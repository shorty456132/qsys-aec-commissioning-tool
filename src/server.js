'use strict';
// T1 — Single-process Node server: static frontend + /api router. Zero npm deps.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Session, SessionError } = require('./session');
const { normalizeComponents, normalizeControls } = require('./discovery');
const { ROLES, defaultRig, validateRig } = require('./roles');
const { MeterPoller } = require('./meters');
const { MODES } = require('./advisor');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_RIG_PATH = path.join(__dirname, '..', 'rig.json');

// --- rig.json (ADR-10) ---------------------------------------------------------
// Read on every GET so the file is the only source of truth. A corrupt file is
// surfaced as a 500, never silently replaced by the default.
function loadRig(rigPath) {
  let text;
  try {
    text = fs.readFileSync(rigPath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return defaultRig();
    throw new SessionError(`Cannot read ${path.basename(rigPath)}: ${e.message}`, 500);
  }
  try {
    return validateRig(JSON.parse(text));
  } catch (e) {
    throw new SessionError(`${path.basename(rigPath)} is invalid: ${e.message}`, 500);
  }
}

function saveRig(rigPath, rig) {
  const tmp = rigPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rig, null, 2) + '\n');
  fs.renameSync(tmp, rigPath); // atomic replace — no half-written rig on a crash
}

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
// All QRC traffic goes through `session.call` (ADR-03).
function apiRoutes(session, rigPath, poller) {
  return {
    // S1 — chain setup persistence.
    'GET /api/rig': (req, res) => json(res, 200, loadRig(rigPath)),
    'PUT /api/rig': async (req, res) => {
      const rig = validateRig(await readJson(req));
      saveRig(rigPath, rig);
      poller.setRig(rig); // S2 — the change group follows the rig
      json(res, 200, rig);
    },
    // S2 — Monitor snapshot, short-polled by the UI (ADR-11).
    'GET /api/monitor': (req, res) => json(res, 200, poller.snapshot()),
    // S3 — talker / quiet-room mode for the input rules; session state, not saved.
    'PUT /api/monitor/mode': async (req, res) => {
      const { mode } = await readJson(req);
      if (!poller.setMode(mode)) throw new SessionError(`mode must be one of: ${MODES.join(', ')}`, 400);
      json(res, 200, { mode: poller.mode });
    },
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

// Parameterised routes: [method, regex, handler(req, res, url, ...groups)].
function paramRoutes(session) {
  return [
    // S1 — components for a role's dropdown, filtered by typeMatch; ?all=1 = "show all".
    ['GET', /^\/api\/roles\/([^/]+)\/candidates$/, async (req, res, url, roleId) => {
      const role = Object.prototype.hasOwnProperty.call(ROLES, roleId) ? ROLES[roleId] : null;
      if (!role) throw new SessionError(`Unknown role "${roleId}"`, 404);
      const all = normalizeComponents(await session.call((c) => c.getComponents()));
      const showAll = url.searchParams.get('all') === '1';
      const components = (showAll ? all : all.filter((c) => role.typeMatch.test(c.type || '')))
        .map(({ name, type, properties }) => ({ name, type, properties }));
      json(res, 200, { role: role.id, all: showAll, components });
    }],
  ];
}

function findRoute(routes, params, method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return (req, res, url) => exact(req, res, url);
  for (const [m, re, fn] of params) {
    const hit = m === method && re.exec(pathname);
    if (hit) return (req, res, url) => fn(req, res, url, ...hit.slice(1).map(decodeURIComponent));
  }
  return null;
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

function createApp({ qrcTimeoutMs, keepaliveMs, pollMs, rigPath = DEFAULT_RIG_PATH } = {}) {
  const session = new Session({ timeoutMs: qrcTimeoutMs, keepaliveMs });
  const poller = new MeterPoller({ session, intervalMs: pollMs });
  try {
    poller.setRig(loadRig(rigPath));
  } catch (e) {
    poller.setRigError(e.message); // GET /api/rig reports the same 500
  }
  const routes = apiRoutes(session, rigPath, poller);
  const params = paramRoutes(session);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = findRoute(routes, params, req.method, url.pathname);
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
  server.poller = poller;
  return server;
}

if (require.main === module) {
  const server = createApp();
  server.listen(PORT, () => {
    console.log(`AEC commissioning tool: http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
