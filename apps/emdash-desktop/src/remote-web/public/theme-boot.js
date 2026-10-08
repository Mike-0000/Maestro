// Runs before first paint (a classic script in <head>): puts the Maestro theme class on <html>
// so the design tokens resolve immediately, and keeps it in step with the system setting.
// A separate same-origin file rather than an inline script, so a strict CSP can allow it.
(function () {
  var query = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var root = document.documentElement;
    var dark = query.matches;
    root.classList.toggle('emdark', dark);
    root.classList.toggle('emlight', !dark);
    window.dispatchEvent(new Event('maestro-theme-change'));
  }
  apply();
  if (query.addEventListener) query.addEventListener('change', apply);
})();
