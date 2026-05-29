// Shared navigation header for pi-pizza-team web UI pages
//
// Auto-injects a consistent navigation bar at the top of every page.
// Highlights the current page based on window.location.pathname.
// Includes a theme toggle (dark / solarized dark / solarized light).

(function() {
  // --- Theme management ---
  const THEMES = [
    { id: 'solarized-dark', label: '🌙', title: 'Dark' },
    { id: 'solarized-light', label: '☀️', title: 'Light' },
  ];

  function getTheme() {
    return localStorage.getItem('ppt-theme') || 'solarized-dark';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ppt-theme', theme);
    // Update active button
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

  // Apply theme immediately (before nav renders) to prevent flash
  document.documentElement.setAttribute('data-theme', getTheme());

  // --- PWA: inject manifest + meta tags + register service worker ---
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/app.webmanifest';
    document.head.appendChild(link);
  }
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#268bd2';
    document.head.appendChild(meta);
  }
  if (!document.querySelector('meta[name="viewport"]')) {
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(meta);
  }
  if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const meta = document.createElement('meta');
    meta.name = 'apple-mobile-web-app-capable';
    meta.content = 'yes';
    document.head.appendChild(meta);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // --- Navigation ---
  const navItems = [
    { href: '/', label: '🍕 Home', match: /^\/$/ },
    { href: '/board', label: '📋 Board', match: /^\/board/ },
    { href: '/assistant', label: '🤖 Assistant', match: /^\/assistant/ },
    { href: '/memory', label: '🧠 Memory', match: /^\/memory/ },
    { href: '/archived', label: '📦 Archived', match: /^\/archived/ },
    { href: '/config', label: '⚙️ Config', match: /^\/config/ },
  ];

  const currentPath = window.location.pathname;

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.innerHTML = '<div class="site-nav-inner">'
    + '<span class="site-nav-brand">🍕 pi-pizza-team</span>'
    + '<div class="site-nav-links">'
    + navItems.map(item => {
        const active = item.match.test(currentPath) ? ' site-nav-active' : '';
        return '<a href="' + item.href + '" class="site-nav-link' + active + '">' + item.label + '</a>';
      }).join('')
    + '<span class="theme-toggle">'
    + THEMES.map(t =>
        '<button class="theme-btn' + (getTheme() === t.id ? ' active' : '') + '" data-theme="' + t.id + '" title="' + t.title + '">' + t.label + '</button>'
      ).join('')
    + '</span>'
    + '</div>'
    + '</div>';

  document.body.insertBefore(nav, document.body.firstChild);

  // Bind theme toggle clicks
  nav.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });
})();
