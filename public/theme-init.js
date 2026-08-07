'use strict';
// Runs blocking, in <head>, before <body> exists - do not add anything here
// that touches the DOM beyond documentElement. Its only job is to set
// [data-theme] before first paint so a stored/system light preference never
// flashes dark first (the default, attribute-less state). Kept as an
// external file because the app's CSP has no 'unsafe-inline' for scripts.
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var light = stored ? stored === 'light' : matchMedia('(prefers-color-scheme: light)').matches;
    if (light) document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) { /* localStorage/matchMedia unavailable - default dark */ }
})();
