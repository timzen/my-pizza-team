// Shared utility functions for pi-pizza-team web UI pages
//
// Provides:
//   escHtml(s) — HTML-escape a string
//   renderMarkdown(text, emptyText) — minimal markdown-to-HTML renderer

/**
 * Escape HTML special characters in a string.
 */
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  if (!text) return '<em style="color:#666;">(' + (emptyText || 'no content') + ')</em>';
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
