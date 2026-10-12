local music player is a plugin for super productivity. it let's you play local music in the background

Musics are scanned from a fixed path ~/Music/sp. so you need to put all you mp3 files inside a folder on inside ~/Music/sp, and then your folder will act like an playlist in super productivity.  

for example:
~/Music/sp/focus/deepwork.mp3 
~/Music/sp/chill/fun.mp3

## How to use this plugin

git clone https://github.com/beyond-alok/local-music-player
cd local-music-player
zip -r ~/local-music-player.zip manifest.json index.html plugin.js icon.svg  

#### inside super productivity

1. go to settings -> plugins -> add plugin -> select local-music-player zip file from home directory -> enable the plugin

it will ask for a permission for node execution. allow that it is necessary to play music in the background.