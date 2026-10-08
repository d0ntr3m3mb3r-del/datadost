/**
 * DataDost legal pages — shared page template.
 * Path: /api/_legalPage.js  (leading underscore = Vercel does NOT expose this as a URL,
 * same convention as /api/_rateLimit.js)
 *
 * Used by: legal.js (the single function that serves /terms, /privacy, /refund and /data-retention)
 *
 * IMPORTANT: this file only controls how a page LOOKS (header, fonts, colours, dark mode,
 * print layout). The legal wording itself lives in each _legal-*.js file and is copied
 * word-for-word from the lawyer's PDF. Never edit that wording here.
 */

const DOCS = [
  { path: '/terms',          label: 'Terms of Service' },
  { path: '/privacy',        label: 'Privacy Policy' },
  { path: '/data-retention', label: 'Data Retention Policy' },
  { path: '/refund',         label: 'Refund Policy' },
];

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Turns plain email addresses in the text into clickable mailto links. The visible text is unchanged.
function paragraphHtml(text) {
  return esc(text).replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    (m) => '<a href="mailto:' + m + '">' + m + '</a>'
  );
}

const CSS = `
  :root {
    --orange: #E86832; --green: #0F6E56; --dark: #0E0D0B;
    --bg: #ffffff; --ink: #2b2a27; --muted: #6b675f; --line: #E0D5C7; --soft: #F5F0EB;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0E0D0B; --ink: #e6e2da; --muted: #a39e93; --line: #3a372f; --soft: #1b1a17; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 16px; line-height: 1.7; color: var(--ink); background: var(--bg);
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
         padding-bottom: 1rem; border-bottom: 3px solid var(--orange); margin-bottom: 1.5rem; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: .6rem; text-decoration: none; color: var(--ink); font-weight: 700; font-size: 1.15rem; }
  .brand img { width: 32px; height: 32px; border-radius: 7px; object-fit: contain; display: block; }
  .brand .dot { color: var(--orange); }
  .back { font-size: .9rem; color: var(--orange); text-decoration: none; }
  .back:hover, .doc a:hover, .nav a:hover { text-decoration: underline; }
  nav.nav { display: flex; flex-wrap: wrap; gap: .4rem 1.1rem; font-size: .9rem; margin-bottom: 1.75rem; }
  nav.nav a { color: var(--muted); text-decoration: none; }
  nav.nav a[aria-current="page"] { color: var(--orange); font-weight: 600; }
  h1 { font-size: 1.6rem; line-height: 1.25; letter-spacing: .02em; margin-bottom: 1.5rem; color: var(--ink); }
  .doc p { margin-bottom: 1.1rem; overflow-wrap: anywhere; }
  .doc a { color: var(--orange); text-decoration: none; }
  .foot { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: .85rem; color: var(--muted); }
  @media (max-width: 600px) { .wrap { padding: 1rem 1rem 3rem; } h1 { font-size: 1.35rem; } }
  @media print {
    :root { --bg: #fff; --ink: #000; --muted: #444; --line: #bbb; }
    body { font-size: 11.5pt; line-height: 1.5; }
    .wrap { max-width: none; padding: 0; }
    .back, nav.nav, .foot { display: none; }
    .top { border-bottom: 1px solid #999; }
    .doc a { color: #000; text-decoration: none; }
  }
`;

export function renderLegalPage({ title, pageLabel, currentPath, paragraphs }) {
  const nav = DOCS.map((d) =>
    '<a href="' + d.path + '"' + (d.path === currentPath ? ' aria-current="page"' : '') + '>' + esc(d.label) + '</a>'
  ).join('\n      ');
  const body = paragraphs.map((p) => '      <p>' + paragraphHtml(p) + '</p>').join('\n');

  return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <meta name="description" content="DataDost ' + esc(pageLabel) + '">\n' +
'  <title>' + esc(pageLabel) + ' — DataDost</title>\n' +
'  <style>' + CSS + '</style>\n' +
'</head>\n' +
'<body>\n' +
'  <div class="wrap">\n' +
'    <header class="top">\n' +
'      <a class="brand" href="/"><img src="/assets/logo-icon.png" alt="" width="32" height="32" onerror="this.style.display=\'none\'"><span>DataDost<span class="dot">.</span></span></a>\n' +
'      <a class="back" href="/">&larr; Back to DataDost</a>\n' +
'    </header>\n' +
'    <nav class="nav" aria-label="Legal documents">\n      ' + nav + '\n    </nav>\n' +
'    <main class="doc">\n' +
'      <h1>' + esc(title) + '</h1>\n' +
body + '\n' +
'    </main>\n' +
'    <footer class="foot">DataDost &middot; datadost.in</footer>\n' +
'  </div>\n' +
'</body>\n' +
'</html>\n';
}
