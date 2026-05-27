// Shared utility functions for pi-pizza-team web UI pages
//
// Provides:
//   escHtml(s) — HTML-escape a string
//   DirBrowser — reusable directory browser modal controller
//   loadDirFavorites(elemId, inputId) — load favorite directories as quick-select buttons
//   renderMarkdown(text, emptyText) — minimal markdown-to-HTML renderer

/**
 * Escape HTML special characters in a string.
 */
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * Reusable directory browser.
 *
 * Usage:
 *   const browser = new DirBrowser({
 *     modalId: 'browse-modal',       // modal overlay element ID
 *     pathId: 'browse-path',         // element showing current path
 *     listId: 'browse-list',         // element showing directory listing
 *     onSelect: (path) => { ... }    // callback when user selects a directory
 *   });
 *   browser.open('~');               // open browser starting at path
 *   browser.close();                 // close browser
 */
class DirBrowser {
  constructor(opts) {
    this.modalId = opts.modalId;
    this.pathId = opts.pathId;
    this.listId = opts.listId;
    this.onSelect = opts.onSelect || function() {};
    this.currentPath = '~';
  }

  open(startPath) {
    this.currentPath = startPath || '~';
    document.getElementById(this.modalId).style.display = 'flex';
    this.navigateTo(this.currentPath);
  }

  close() {
    document.getElementById(this.modalId).style.display = 'none';
  }

  select() {
    this.onSelect(this.currentPath);
    this.close();
  }

  async navigateTo(dir) {
    this.currentPath = dir;
    document.getElementById(this.pathId).textContent = dir;
    document.getElementById(this.listId).innerHTML = '<div style="color:var(--text-muted);font-size:0.85em;">Loading...</div>';
    const self = this;
    try {
      const res = await fetch('/api/browse?path=' + encodeURIComponent(dir));
      const data = await res.json();
      if (data.error) {
        document.getElementById(self.listId).innerHTML = '<div style="color:var(--danger);font-size:0.85em;">' + escHtml(data.error) + '</div>';
        return;
      }
      self.currentPath = data.path;
      document.getElementById(self.pathId).textContent = data.path;

      let html = '';
      if (data.path !== '~' && data.path !== '/') {
        const parentPath = data.path.replace(/\/[^\/]+$/, '') || '/';
        html += '<div style="padding:6px 10px;cursor:pointer;border-radius:4px;font-size:0.85em;color:var(--text-muted);" onmouseover="this.style.background=\'var(--card-hover)\'" onmouseout="this.style.background=\'\'" onclick="window.__dirBrowserNav(\'' + escHtml(parentPath).replace(/'/g, "\\'") + '\')">← ..</div>';
      }
      if (data.dirs.length === 0) {
        html += '<div style="padding:10px;color:var(--text-muted);font-size:0.85em;">No subdirectories</div>';
      } else {
        for (const d of data.dirs) {
          const fullPath = data.path === '/' ? '/' + d : data.path + '/' + d;
          html += '<div style="padding:6px 10px;cursor:pointer;border-radius:4px;font-size:0.85em;" onmouseover="this.style.background=\'var(--card-hover)\'" onmouseout="this.style.background=\'\'" onclick="window.__dirBrowserNav(\'' + escHtml(fullPath).replace(/'/g, "\\'") + '\')">📁 ' + escHtml(d) + '</div>';
        }
      }
      document.getElementById(self.listId).innerHTML = html;
    } catch(e) {
      document.getElementById(self.listId).innerHTML = '<div style="color:var(--danger);font-size:0.85em;">Error: ' + escHtml(e.message) + '</div>';
    }
  }
}

// Global navigation hook (used by inline onclick in rendered HTML)
// Each page sets window.__activeDirBrowser to the currently-open DirBrowser instance.
window.__dirBrowserNav = function(path) {
  if (window.__activeDirBrowser) window.__activeDirBrowser.navigateTo(path);
};

/**
 * Load favorite directories from the API and render as quick-select buttons.
 *
 * @param {string} targetElementId - Container element for the buttons
 * @param {string} targetInputId - Input element to set value on click
 */
async function loadDirFavorites(targetElementId, targetInputId) {
  const el = document.getElementById(targetElementId);
  try {
    const res = await fetch('/api/team/spawn-options');
    const data = await res.json();
    const favorites = (data.options || []).filter(function(o) { return o.source === 'favorite'; });
    if (favorites.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = favorites.map(function(o) {
      return '<button type="button" class="btn-add-task-inline" style="margin:2px;" onclick="document.getElementById(\'' + escHtml(targetInputId) + '\').value=\'' + escHtml(o.dir).replace(/'/g, "\\'") + '\'">'
        + '⭐ ' + escHtml(o.dir) + '</button>';
    }).join('');
  } catch(e) { el.innerHTML = ''; }
}

/**
 * Render a subset of markdown to HTML.
 * Supports: code blocks, inline code, headers, bold, italic,
 * blockquotes, unordered lists, horizontal rules, links, paragraphs.
 *
 * @param {string} text - The markdown text to render
 * @param {string} [emptyText="(no content)"] - Fallback when text is empty
 * @returns {string} HTML string
 */
function renderMarkdown(text, emptyText) {
  if (!text) return '<em style="color:var(--text-muted);">(' + (emptyText || 'no content') + ')</em>';
  let html = escHtml(text);
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Paragraphs (double newline)
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';
  // Clean up empty paragraphs and fix nested block elements
  html = html.replace(/<p>(<h[1-4]>)/g, '$1');
  html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p><\/p>/g, '');
  // Single newlines → <br> inside paragraphs
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, function(m, inner) {
    return '<p>' + inner.replace(/\n/g, '<br>') + '</p>';
  });
  return html;
}
