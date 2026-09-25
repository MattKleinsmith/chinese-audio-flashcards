#!/usr/bin/env node
// serve.mjs — tiny static server for local development and the e2e test (no dependencies).
// Serves site/ at http://localhost:8080 with correct MIME types and HTTP Range support
// (Safari needs 206 responses for <audio>). PLAN §7.3.
//
//   node scripts/serve.mjs [--port 8080] [--root site] [--data-dir <path>]
//
// --data-dir serves that directory at /data/ instead of site/data (e.g. the test fixture at
// tests/fixtures/data). Also importable: `startServer({ port, root, dataDir })` → { server, url }.
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Resolve a URL path inside a base directory; null if it escapes the directory. */
function safeJoin(base, urlPath) {
  const p = normalize(join(base, urlPath));
  return p === base || p.startsWith(base + sep) ? p : null;
}

async function handle(req, res, root, dataDir, userData = true) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  let file;
  // --no-user-data: pretend the synced Hack Chinese export is absent (tests start from empty).
  if (!userData && urlPath.startsWith('/data/user/')) { res.writeHead(404).end('not found'); return; }
  if (urlPath === '/data' || urlPath.startsWith('/data/')) file = safeJoin(dataDir, urlPath.slice('/data'.length) || '/');
  else file = safeJoin(root, urlPath);
  if (!file) { res.writeHead(403).end('forbidden'); return; }
  let st;
  try {
    st = await stat(file);
    if (st.isDirectory()) { file = join(file, 'index.html'); st = await stat(file); }
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  const headers = {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (range[1] === '') end = st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}

/** Start the server. port 0 picks a free port. */
export function startServer({ port = 8080, root = join(REPO, 'site'), dataDir, quiet = false, userData = true } = {}) {
  const absRoot = resolve(root);
  const absData = resolve(dataDir || join(absRoot, 'data'));
  const server = createServer((req, res) => {
    handle(req, res, absRoot, absData, userData).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  return new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${server.address().port}/`;
      if (!quiet) console.log(`Serving ${absRoot} (data: ${absData}) at ${url}`);
      resolveP({ server, url });
    });
  });
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  startServer({
    port: Number(arg('--port') || process.env.PORT || 8080),
    root: arg('--root') ? resolve(arg('--root')) : undefined,
    dataDir: arg('--data-dir') ? resolve(arg('--data-dir')) : undefined,
    userData: !process.argv.includes('--no-user-data'),
  }).catch((err) => { console.error(err.message); process.exit(1); });
}

