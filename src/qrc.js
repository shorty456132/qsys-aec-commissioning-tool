'use strict';
// T2 — QRC (Q-SYS Remote Control) client. Node port of qsys_connection.py
// (qsys-scripter skill — protocol source of truth, see ADR.md §Findings).
//
// Protocol facts this port preserves:
//   - JSON-RPC 2.0 over raw TCP, default port 1710.
//   - Frames delimited by \x00.
//   - Q-SYS emits an unsolicited EngineStatus broadcast immediately on
//     connect → match responses by JSON-RPC `id`, never first-frame-wins.
//   - Persistent receive buffer; frames may arrive fragmented.
//   - Logon {User, Password} is optional (only if credentials configured).
//   - Component.Set does NOT return a reply — "timeout" is normal, not an
//     error (see QRC.set / sendCommand({expectReply:false})).
//   - NoOp exists as a keepalive/round-trip.

const net = require('net');

const RECV_BUFSIZE = 65536; // reference only; net streams buffer for us
const DEFAULT_TIMEOUT_MS = 5000;

class QRCError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'QRCError';
  }
}

class QRC {
  /**
   * @param {object} opts {host, port=1710, user='', password='', timeoutMs=5000}
   */
  constructor({ host, port = 1710, user = '', password = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this._sock = null;
    this._id = 0;
    this._buf = ''; // persistent receive buffer across reads
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this.onClose = null; // called on remote drop of an established link
  }

  get connected() {
    return this._sock !== null && !this._sock.destroyed;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.connected) return reject(new QRCError('Already connected'));
      const sock = new net.Socket();
      let settled = false;
      let up = false; // true once connect() resolved
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this._sock = null;
          sock.destroy();
          reject(err);
        } else {
          up = true;
          resolve();
        }
      };
      // TCP connect has no built-in timeout; an unreachable host would
      // otherwise hang for the OS SYN-retry window.
      const timer = setTimeout(
        () => done(new QRCError(`Timed out connecting to ${this.host}:${this.port}`)),
        this.timeoutMs
      );
      sock.connect(this.port, this.host, () => {
        this._sock = sock;
        if (this.user) {
          // Python reference: Logon sent immediately on connect.
          this.sendCommand('Logon', { User: this.user, Password: this.password })
            .then(() => done(), (e) => done(e));
        } else {
          done();
        }
      });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('error', (err) => {
        const e = new QRCError(`Socket error: ${err.message}`);
        done(e);
        this._fail(e);
      });
      sock.on('close', () => {
        done(new QRCError('Connection closed during connect'));
        if (this._sock === sock) this._sock = null;
        this._fail(new QRCError('Connection closed by remote host'));
        // Remote drop of an established link → notify owner (T11 reconnect).
        if (up && !sock._localClose && this.onClose) this.onClose();
      });
    });
  }

  close() {
    const sock = this._sock;
    this._sock = null;
    const err = new QRCError('Connection closed');
    this._fail(err);
    if (sock) {
      sock._localClose = true;
      sock.end();
    }
  }

  /**
   * Send a JSON-RPC command.
   * @returns {Promise<any>} result, or null when expectReply is false.
   */
  sendCommand(method, params, opts = {}) {
    const expectReply = opts.expectReply !== false;
    const timeoutMs = opts.timeoutMs || this.timeoutMs;
    return new Promise((resolve, reject) => {
      if (!this.connected || !this._sock) {
        return reject(new QRCError('Not connected'));
      }
      this._id += 1;
      const id = this._id;
      const payload = { jsonrpc: '2.0', method, id };
      if (params !== undefined && params !== null) payload.params = params;
      this._sock.write(JSON.stringify(payload) + '\x00');
      if (!expectReply) {
        resolve(null); // Component.Set semantics: no reply is normal.
        return;
      }
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new QRCError(`Timed out waiting for response to ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf-8');
    // Drain complete frames out of the buffer; may be fragmented.
    for (;;) {
      const idx = this._buf.indexOf('\x00');
      if (idx < 0) break;
      const frame = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    if (!frame.trim()) return;
    let obj;
    try {
      obj = JSON.parse(frame);
    } catch (e) {
      const err = new QRCError(`Bad JSON from QRC: ${e.message}`);
      this._fail(err);
      return;
    }
    const entry = this._pending.get(obj.id);
    if (!entry) {
      // Unsolicited broadcast (e.g. EngineStatus on connect) — discard.
      return;
    }
    clearTimeout(entry.timer);
    this._pending.delete(obj.id);
    if (obj.error) {
      entry.reject(new QRCError(`QRC error ${obj.error.code}: ${obj.error.message}`));
    } else {
      entry.resolve(obj.result);
    }
  }

  _fail(err) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      this._pending.delete(id);
      entry.reject(err);
    }
    this._sock = null;
  }

  // --- named API helpers (param shapes verified from qsys_inject.py) --------

  noop() {
    return this.sendCommand('NoOp');
  }

  getComponents() {
    return this.sendCommand('Component.GetComponents');
  }

  get(name) {
    // {"Name": "<component Code Name>"}
    return this.sendCommand('Component.Get', { Name: name });
  }

  getControls(name) {
    // {"Name": "<component Code Name>"}
    return this.sendCommand('Component.GetControls', { Name: name });
  }

  // --- change groups (S2, ADR-11; shapes Verified: QRC_Commands.md) ----------

  changeGroupAddComponentControl(id, name, pins) {
    // {"Id", "Component": {"Name", "Controls": [{"Name": <pin>}]}} — creates the group if new
    return this.sendCommand('ChangeGroup.AddComponentControl', {
      Id: id,
      Component: { Name: name, Controls: pins.map((p) => ({ Name: p })) },
    });
  }

  changeGroupPoll(id) {
    // → {Id, Changes: [{Component, Name, Value, String}]} — changes only
    return this.sendCommand('ChangeGroup.Poll', { Id: id });
  }

  changeGroupClear(id) {
    return this.sendCommand('ChangeGroup.Clear', { Id: id });
  }

  /**
   * Set controls on a component. NO reply — timeout is normal.
   * @param {string} name component Code Name
   * @param {Array<{Name: string, Value: *}>} controls pin/value pairs
   */
  set(name, controls) {
    // {"Name": <component>, "Controls": [{"Name": <pin>, "Value": <value>}]}
    return this.sendCommand(
      'Component.Set',
      { Name: name, Controls: controls },
      { expectReply: false }
    );
  }
}

module.exports = { QRC, QRCError };
