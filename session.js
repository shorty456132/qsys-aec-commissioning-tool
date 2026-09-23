'use strict';
// T4 — The single QRC session this server owns (ADR-03: one connection at a
// time, serialized writer). Later tasks (T5 discovery, T7 polling, T9 writes)
// go through `session.client` — never open a second QRC socket.

const { QRC, QRCError } = require('./qrc');

const DEFAULT_QRC_PORT = 1710;
// Core closes a QRC client idle for 60 s (QRC_Overview.md) — ADR-08.
const DEFAULT_KEEPALIVE_MS = 58000;

class SessionError extends Error {
  constructor(msg, httpCode) {
    super(msg);
    this.name = 'SessionError';
    this.httpCode = httpCode;
  }
}

// Validate a /api/connect body → {host, port, user, pass}. Throws 400s.
function parseConnectBody(body) {
  if (!body || typeof body !== 'object') throw new SessionError('Body must be a JSON object', 400);
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host) throw new SessionError('host is required', 400);
  let port = DEFAULT_QRC_PORT;
  if (body.port !== undefined && body.port !== null && body.port !== '') {
    port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SessionError('port must be 1–65535', 400);
  }
  const user = typeof body.user === 'string' ? body.user : '';
  const pass = typeof body.pass === 'string' ? body.pass : '';
  return { host, port, user, pass };
}

class Session {
  constructor({ timeoutMs = 5000, keepaliveMs = DEFAULT_KEEPALIVE_MS, QRCClass = QRC } = {}) {
    this.timeoutMs = timeoutMs;
    this.keepaliveMs = keepaliveMs;
    this._keepaliveTimer = null;
    this.QRCClass = QRCClass;
    this.client = null;
    this.state = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
    this.host = null;
    this.port = null;
    this.user = '';
    this.error = null; // last failure message; cleared on success / user disconnect
    this.since = Date.now();
    this.onState = null; // (state) => void — the meter poller follows the link (S2)
  }

  _set(state, error) {
    this.state = state;
    if (error !== undefined) this.error = error;
    this.since = Date.now();
    if (this.onState) this.onState(state);
  }

  status() {
    // Never include the password.
    return {
      state: this.state,
      host: this.host,
      port: this.port,
      user: this.user,
      error: this.error,
      since: new Date(this.since).toISOString(),
    };
  }

  async connect(body) {
    const { host, port, user, pass } = parseConnectBody(body);
    if (this.state !== 'disconnected') {
      throw new SessionError(`Already ${this.state} to ${this.host}:${this.port} — disconnect first`, 409);
    }
    const client = new this.QRCClass({ host, port, user, password: pass, timeoutMs: this.timeoutMs });
    this.client = client;
    this.host = host;
    this.port = port;
    this.user = user;
    this._set('connecting', null);
    try {
      await client.connect();
      // A plain TCP listener would "connect" too — prove it speaks QRC.
      await client.noop();
    } catch (e) {
      client.close();
      if (this.client === client) {
        this.client = null;
        this._set('disconnected', e.message);
      }
      throw new SessionError(e.message, 502);
    }
    if (this.client !== client) {
      // disconnect() was called while we were connecting.
      client.close();
      throw new SessionError('Disconnected while connecting', 409);
    }
    client.onClose = () => {
      if (this.client !== client) return;
      this._stopKeepalive();
      this.client = null;
      this._set('disconnected', 'Connection closed by remote host');
    };
    this._set('connected', null);
    this._startKeepalive(client);
    return this.status();
  }

  _startKeepalive(client) {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      client.noop().catch((e) => {
        // A dead link must surface, never fail silently (ADR-08).
        if (this.client !== client) return;
        this._stopKeepalive();
        this.client = null;
        client.close();
        this._set('disconnected', `Keepalive failed: ${e.message}`);
      });
    }, this.keepaliveMs);
    this._keepaliveTimer.unref();
  }

  _stopKeepalive() {
    clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = null;
  }

  // The live client, or a 409 — every QRC call after connect goes through here.
  requireClient() {
    if (this.state !== 'connected' || !this.client) throw new SessionError('Not connected', 409);
    return this.client;
  }

  // Run a QRC call; a QRC error reply / timeout becomes a 502 (session stays up).
  async call(fn) {
    const client = this.requireClient();
    try {
      return await fn(client);
    } catch (e) {
      throw new SessionError(e.message, 502);
    }
  }

  disconnect() {
    this._stopKeepalive();
    const client = this.client;
    this.client = null;
    if (client) client.close();
    if (this.state !== 'disconnected' || client) this._set('disconnected', null);
    return this.status();
  }
}

module.exports = { Session, SessionError, parseConnectBody, QRCError, DEFAULT_QRC_PORT, DEFAULT_KEEPALIVE_MS };
