'use strict';
// T1 — Single-process Node server: static frontend + /api router. Zero npm deps.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Session, SessionError } = require('./session');
const { normalizeComponents, normalizeControls } = require('./discovery');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MAX_BODY = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > MAX_BODY) {
        reject(new SessionError('Body too large', 413));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(new SessionError('Invalid JSON body', 400));
      }
    });
    req.on('error', reject);
  });
}

// --- /api router -------------------------------------------------------------
// T7+ adds /api/poll, /api/set here — all through `session.call`.
function apiRoutes(session) {
  return {
    'GET /api/ping': (req, res) => json(res, 200, { ok: true }),
    'GET /api/status': (req, res) => json(res, 200, session.status()),
    'POST /api/connect': async (req, res) => json(res, 200, await session.connect(await readJson(req))),
    'POST /api/disconnect': (req, res) => json(res, 200, session.disconnect()),
    // T5 — design discovery (read-only).
    'GET /api/components': async (req, res) => {
      const result = await session.call((c) => c.getComponents());
      json(res, 200, { components: normalizeComponents(result) });
    },
    'GET /api/controls': async (req, res, url) => {
      const name = url.searchParams.get('name');
      if (!name) throw new SessionError('name (component Code Name) is required', 400);
      json(res, 200, normalizeControls(await session.call((c) => c.getControls(name))));
    },
  };
}

// --- static file serving -----------------------------------------------------
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, '.' + rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

function createApp({ qrcTimeoutMs, keepaliveMs } = {}) {
  const session = new Session({ timeoutMs: qrcTimeoutMs, keepaliveMs });
  const routes = apiRoutes(session);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try {
        await route(req, res, url);
      } catch (e) {
        json(res, e.httpCode || 500, { ...session.status(), error: String(e.message || e) });
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'no such endpoint' });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    serveStatic(req, res, url.pathname);
  });
  server.session = session;
  return server;
}

if (require.main === module) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`AEC commissioning tool: http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
