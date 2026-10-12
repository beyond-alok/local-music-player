// Local Music Player - host-side engine.
//
// This file runs once in the HOST APP'S OWN renderer context (same JS
// context as Super Productivity itself, not inside the panel iframe), and
// stays alive for the whole app session. That's what makes background /
// looping playback survive closing the side panel: the <audio> element
// below is attached to the host app's own document, not to the panel's
// disposable iframe.
//
// index.html (the panel UI) is just a thin remote control - it reads state
// from window.__localMusicPlayer and sends it commands. It can be closed
// and reopened freely without affecting playback at all.

(function () {
  const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

  const state = {
    allPlaylists: {}, // { folderName: [{ name, path, url }] }
    currentPlaylistName: null,
    playlist: [],
    currentIndex: -1,
    shuffleOrder: [],
    shuffle: false,
    volume: 0.8,
    isScanning: false,
    status: 'Not scanned yet.',
  };

  // A real <audio> element attached to the host app's own document.
  const audio = document.createElement('audio');
  audio.volume = state.volume;
  document.body.appendChild(audio);

  function toFileUrl(filePath) {
    let p = filePath.replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p; // handles Windows "C:/..." -> "/C:/..."
    const encoded = p
      .split('/')
      .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
      .join('/');
    return 'file://' + encoded;
  }

  function basename(filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }

  function buildShuffleOrder() {
    const order = state.playlist.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  function getNextIndex() {
    if (state.playlist.length === 0) return -1;
    if (state.currentIndex === -1) {
      return state.shuffle ? state.shuffleOrder[0] : 0;
    }
    if (state.shuffle) {
      const pos = state.shuffleOrder.indexOf(state.currentIndex);
      const nextPos = (pos + 1) % state.shuffleOrder.length;
      if (nextPos === 0) state.shuffleOrder = buildShuffleOrder(); // reshuffle each loop
      return state.shuffleOrder[nextPos];
    }
    return (state.currentIndex + 1) % state.playlist.length; // wraps -> infinite loop
  }

  function getPrevIndex() {
    if (state.playlist.length === 0) return -1;
    if (state.currentIndex === -1) {
      return state.shuffle
        ? state.shuffleOrder[state.shuffleOrder.length - 1]
        : state.playlist.length - 1;
    }
    if (state.shuffle) {
      const pos = state.shuffleOrder.indexOf(state.currentIndex);
      const prevPos = (pos - 1 + state.shuffleOrder.length) % state.shuffleOrder.length;
      return state.shuffleOrder[prevPos];
    }
    return (state.currentIndex - 1 + state.playlist.length) % state.playlist.length;
  }

  function playIndex(index) {
    if (index < 0 || index >= state.playlist.length) return;
    state.currentIndex = index;
    audio.src = state.playlist[index].url;
    audio.play().catch((e) => {
      state.status = 'Playback error: ' + e.message;
    });
  }

  function stopPlayback(msg) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.currentIndex = -1;
    state.status = msg;
  }

  audio.addEventListener('ended', () => playIndex(getNextIndex()));

  async function saveLastPlaylist(name) {
    try {
      await PluginAPI.persistDataSynced(JSON.stringify({ lastPlaylist: name }));
    } catch (e) {
      // non-fatal - just won't remember the selection next launch
    }
  }

  async function getLastPlaylist() {
    try {
      const raw = await PluginAPI.loadSyncedData();
      if (!raw) return null;
      return JSON.parse(raw).lastPlaylist || null;
    } catch (e) {
      return null;
    }
  }

  function selectPlaylist(name, autoplay) {
    if (!state.allPlaylists[name]) return;
    state.currentPlaylistName = name;
    state.playlist = state.allPlaylists[name];
    state.currentIndex = -1;
    state.shuffleOrder = buildShuffleOrder();
    saveLastPlaylist(name);
    if (autoplay) {
      playIndex(0);
    } else {
      state.status = 'Selected "' + name + '" - press play to start.';
    }
  }

  async function scanBaseFolder() {
    if (state.isScanning) return;
    state.isScanning = true;
    state.status = 'Scanning ~/Music/sp ...';

    const script = `
      const fs = require('fs');
      const pathMod = require('path');
      const os = require('os');
      const baseDir = pathMod.join(os.homedir(), 'Music', 'sp');
      const exts = ${JSON.stringify(AUDIO_EXTENSIONS)};
      if (!fs.existsSync(baseDir)) {
        throw new Error('Folder not found: ' + baseDir + ' - create it with a subfolder per playlist.');
      }
      const names = fs.readdirSync(baseDir)
        .filter((n) => !n.startsWith('.'))
        .sort((a, b) => a.localeCompare(b));
      const playlists = {};
      for (const name of names) {
        const dirPath = pathMod.join(baseDir, name);
        let stat;
        try {
          stat = fs.statSync(dirPath); // follows symlinks, unlike dirent.isDirectory()
        } catch (e) {
          continue; // broken symlink or permission error - skip quietly
        }
        if (!stat.isDirectory()) continue;
        const files = fs.readdirSync(dirPath)
          .filter((f) => exts.includes(pathMod.extname(f).toLowerCase()))
          .sort((a, b) => a.localeCompare(b))
          .map((f) => pathMod.join(dirPath, f));
        if (files.length > 0) {
          playlists[name] = files;
        }
      }
      return playlists;
    `;

    try {
      const result = await PluginAPI.executeNodeScript({ script, timeout: 30000 });
      if (!result.success) {
        state.status = 'Scan failed: ' + (result.error || 'unknown error');
        return;
      }
      const raw = result.result || {};
      const newAllPlaylists = {};
      Object.keys(raw).forEach((folderName) => {
        newAllPlaylists[folderName] = raw[folderName].map((p) => ({
          name: basename(p),
          path: p,
          url: toFileUrl(p),
        }));
      });

      // Capture playback state BEFORE swapping in the new scan results.
      const wasPlaying =
        state.currentPlaylistName &&
        !audio.paused &&
        state.currentIndex !== -1 &&
        state.playlist[state.currentIndex];
      const playingTrackPath = wasPlaying ? state.playlist[state.currentIndex].path : null;

      state.allPlaylists = newAllPlaylists;

      if (Object.keys(state.allPlaylists).length === 0) {
        if (wasPlaying) stopPlayback('Playlist folder no longer found - stopped.');
        state.status = 'No playlist subfolders with audio files found in ~/Music/sp.';
        state.playlist = [];
        state.currentPlaylistName = null;
        return;
      }

      // Same playlist still exists - keep the currently playing track going.
      if (wasPlaying && state.allPlaylists[state.currentPlaylistName]) {
        state.playlist = state.allPlaylists[state.currentPlaylistName];
        const matchIdx = state.playlist.findIndex((t) => t.path === playingTrackPath);
        state.currentIndex = matchIdx; // -1 if that exact file was removed/renamed
        state.shuffleOrder = buildShuffleOrder();
        state.status =
          matchIdx === -1 ? 'Current track no longer listed, will move on when it ends.' : 'Ready.';
        return;
      }

      if (wasPlaying) {
        stopPlayback('Playing folder no longer found - stopped.');
      }

      state.status = 'Ready.';
      const lastPlaylist = await getLastPlaylist();
      const nameToSelect = state.allPlaylists[lastPlaylist]
        ? lastPlaylist
        : Object.keys(state.allPlaylists)[0];
      selectPlaylist(nameToSelect, false);
    } catch (e) {
      state.status = 'Scan error: ' + e.message;
    } finally {
      state.isScanning = false;
    }
  }

  function getState() {
    const playlistCounts = {};
    Object.keys(state.allPlaylists).forEach((name) => {
      playlistCounts[name] = state.allPlaylists[name].length;
    });
    return {
      allPlaylists: playlistCounts,
      currentPlaylistName: state.currentPlaylistName,
      tracks: state.playlist.map((t) => t.name),
      currentIndex: state.currentIndex,
      isPlaying: !audio.paused && state.currentIndex !== -1,
      shuffle: state.shuffle,
      volume: state.volume,
      status: state.status,
      isScanning: state.isScanning,
      currentTime: audio.currentTime || 0,
      duration: audio.duration || 0,
    };
  }

  // Exposed for the panel iframe to call. The iframe is same-origin with
  // the host (per the plugin architecture), so window.parent.__localMusicPlayer
  // is reachable directly from index.html - no postMessage bridge needed,
  // and nothing here is torn down when the panel closes.
  window.__localMusicPlayer = {
    getState,
    scan: () => scanBaseFolder(),
    selectPlaylist: (name) => selectPlaylist(name, true),
    playPause: () => {
      if (state.playlist.length === 0) return;
      if (state.currentIndex === -1) {
        playIndex(0);
        return;
      }
      if (audio.paused) {
        audio.play();
      } else {
        audio.pause();
      }
    },
    next: () => playIndex(getNextIndex()),
    prev: () => playIndex(getPrevIndex()),
    playTrackAt: (index) => playIndex(index),
    setVolume: (v) => {
      state.volume = v;
      audio.volume = v;
    },
    setShuffle: (on) => {
      state.shuffle = !!on;
      state.shuffleOrder = buildShuffleOrder();
    },
    seek: (time) => {
      if (audio.duration && !isNaN(time)) {
        audio.currentTime = time;
      }
    },
  };

  PluginAPI.registerSidePanelButton({
    label: 'Music',
    icon: 'music_note',
    onClick: () => {
      PluginAPI.showIndexHtmlAsView();
    },
  });

  // Scan on plugin load (app start), not just when the panel is opened, so
  // playback can be controlled without ever needing to open the panel.
  scanBaseFolder();
})();
