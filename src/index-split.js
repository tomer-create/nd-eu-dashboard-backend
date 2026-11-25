// Serves public/index.html with its embedded `const DATA = {...}` snapshot moved
// into a separate file (added 2026-11-25, loading time).
//
// Why: that one line is ~550 KB of the 1.15 MB page and changes only when the
// snapshot is regenerated, yet it was downloaded again with every page load.
// Now the page is ~half the size and the snapshot is fetched once and kept by the
// browser (immutable, file name carries a hash of its content).
//
// The split happens at runtime from the same index.html, so nothing else in the
// repo changes: `const DATA` stays a global in a classic script that runs before
// the page's own script, exactly as before. If the page doesn't look the way
// this expects, split() returns null and the plain file is served as before.

const fs = require('fs');
const crypto = require('crypto');

const DATA_LINE = /^const DATA = .*$/m;

function splitHtml(html) {
  const m = DATA_LINE.exec(html);
  if (!m) return null;
  if (DATA_LINE.exec(html.slice(m.index + m[0].length)) ) return null; // more than one: not what we expect
  const line = m[0];
  const scriptAt = html.lastIndexOf('<script>', m.index);
  if (scriptAt < 0) return null;
  const closeAt = html.indexOf('</script>', m.index);
  if (closeAt < 0 || line.includes('</script>')) return null;
  const hash = crypto.createHash('sha1').update(line).digest('hex').slice(0, 12);
  const name = `snapshot-${hash}.js`;
  const out = html.slice(0, scriptAt) + `<script src="/${name}"></script>\n` + html.slice(scriptAt, m.index) + html.slice(m.index + line.length + 1);
  return { html: out, name, js: line + '\n' };
}

function createSplitServer(htmlPath) {
  let cached = null; // { mtimeMs, result }
  function load() {
    const st = fs.statSync(htmlPath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.result;
    let result = null;
    try { result = splitHtml(fs.readFileSync(htmlPath, 'utf8')); } catch (err) { console.error('index-split failed:', err.message); }
    cached = { mtimeMs: st.mtimeMs, result };
    if (result) console.log(`index-split: page ${Math.round(result.html.length / 1024)} KB + ${result.name} ${Math.round(result.js.length / 1024)} KB`);
    return result;
  }
  function page(req, res, next) {
    let r = null;
    try { r = load(); } catch (err) { /* fall through to static */ }
    if (!r) return next();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    res.send(r.html);
  }
  function snapshot(req, res, next) {
    let r = null;
    try { r = load(); } catch (err) { /* fall through */ }
    if (!r || req.params.name !== r.name) return next();
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(r.js);
  }
  return { page, snapshot };
}

module.exports = { splitHtml, createSplitServer };
