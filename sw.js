// Root service worker (scope = the whole game folder).
// A worker file inside js/ could not control the game page (scope is limited to its own folder
// on GitHub Pages), so the real code stays in js/sw.js and is pulled in from here.
// Relative URLs inside js/sw.js resolve against THIS file's location, i.e. the game root.
importScripts('js/sw.js');
