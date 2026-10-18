// Apply the saved theme before first paint (avoids a light flash in dark mode)
try {
  var t = localStorage.getItem('theme');
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#000000' : '#f7f7fa');
} catch (e) { document.documentElement.dataset.theme = 'light'; }
