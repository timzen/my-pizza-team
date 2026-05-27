// Shared navigation header for pi-pizza-team web UI pages
//
// Auto-injects a consistent navigation bar at the top of every page.
// Highlights the current page based on window.location.pathname.

(function() {
  const navItems = [
    { href: '/', label: '🍕 Home', match: /^\/$/ },
    { href: '/board', label: '📋 Board', match: /^\/board/ },
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
    + '</div>'
    + '</div>';

  document.body.insertBefore(nav, document.body.firstChild);
})();
