'use strict';
// S2 — Meter poller (ADR-11): one change group, explicit Poll every 500 ms,
// a value cache (Poll returns changes only), and the Monitor snapshot.
//
// The group Id is fixed, so a rig change can only ever Clear + re-add it —
// never leak a second group (a Core allows 4 per connection). All QRC traffic
// goes through `session.call` (ADR-03).

const { ROLES, STAGES } = require('./roles');
const { advise, deriveElr, MODES } = require('./advisor');
const { normalizeComponents } = require('./discovery');

const GROUP_ID = 'aec-commissioning-meters';
const DEFAULT_POLL_MS = 500;

// Rig → every meter to watch, tagged with its chain + role (Snapshot shape).
function meterList(rig) {
  const out = [];
  for (const chain of rig.chains) {
    for (const stage of STAGES) {
      const sel = chain[stage];
      const role = ROLES[stage];
      if (!sel || !role) continue;
      for (const m of role.meters(sel)) out.push({ chain: chain.id, role: role.id, component: sel.component, ...m });
    }
  }
  return out;
}

const cacheKey = (component, pin) => `${component}\0${pin}`;

class MeterPoller {
  constructor({ session, intervalMs = DEFAULT_POLL_MS }) {
    this.session = session;
    this.intervalMs = intervalMs;
    this.rig = null;
    this.meters = [];
    this.cache = new Map(); // cacheKey → {value, string}
    this.error = null;      // last poll/rebuild failure; cleared by a good poll
    this.mode = 'off';      // S3 — which input rule the advisor applies (MODES)
    this.props = null;      // S4 — {component: properties} from this connection's design
    this._dirty = true;     // group must be (re)built before the next Poll
    this._built = false;    // group exists on the current connection
    this._running = false;
    this._gen = 0;          // bumps on start/stop so stale in-flight ticks bail out
    this._timer = null;
    session.onState = (state) => (state === 'connected' ? this.start() : this.stop());
  }

  setRig(rig) {
    this.rig = rig;
    this.meters = meterList(rig);
    this._dirty = true;
    this.error = null; // a poll/rebuild failure re-surfaces on the next tick
  }

  // S3 — returns false (and changes nothing) for an unknown mode.
  setMode(mode) {
    if (!MODES.includes(mode)) return false;
    this.mode = mode;
    return true;
  }

  // A rig that can't be loaded is surfaced, not polled.
  setRigError(message) {
    this.rig = null;
    this.meters = [];
    this._dirty = true;
    this.error = message;
  }

  start() {
    this.stop();
    this._running = true;
    this._dirty = true; // a new connection has no groups
    this._schedule(this._gen);
  }

  stop() {
    this._gen++;
    clearTimeout(this._timer);
    this._timer = null;
    this._running = false;
    this._built = false;
    this.props = null; // the next connection may be a different design
  }

  _schedule(gen) {
    if (!this._running || gen !== this._gen) return;
    this._timer = setTimeout(() => this._tick(gen), this.intervalMs);
    this._timer.unref();
  }

  async _tick(gen) {
    try {
      if (this._dirty) await this._rebuild(gen);
      if (gen !== this._gen || !this._built || !this.meters.length) return;
      const r = await this.session.call((c) => c.changeGroupPoll(GROUP_ID));
      if (gen !== this._gen || this._dirty) return; // disconnected / rig changed mid-flight
      for (const ch of (r && r.Changes) || []) {
        this.cache.set(cacheKey(ch.Component, ch.Name), { value: ch.Value, string: ch.String });
      }
      this.error = null;
    } catch (e) {
      if (gen === this._gen) this.error = `Meter poll failed: ${e.message}`;
    } finally {
      this._schedule(gen);
    }
  }

  async _rebuild(gen) {
    this._dirty = false;
    try {
      if (this._built) await this.session.call((c) => c.changeGroupClear(GROUP_ID));
      this.cache.clear();
      // S4 — the AEC tail rule reads tail_length from the design, once per rebuild.
      if (this.rig && this.rig.chains.some((c) => c.aec)) {
        const comps = normalizeComponents(await this.session.call((c) => c.getComponents()));
        if (gen !== this._gen) return;
        this.props = Object.fromEntries(comps.map((c) => [c.name, c.properties]));
      }
      const byComponent = new Map();
      for (const m of this.meters) {
        if (!byComponent.has(m.component)) byComponent.set(m.component, []);
        byComponent.get(m.component).push(m.pin);
      }
      for (const [name, pins] of byComponent) {
        if (gen !== this._gen) return;
        await this.session.call((c) => c.changeGroupAddComponentControl(GROUP_ID, name, pins));
        this._built = true;
      }
    } catch (e) {
      if (gen === this._gen) this._dirty = true; // retry next tick; the error surfaces via _tick
      throw e;
    }
  }

  snapshot() {
    const state = this.session.state;
    const live = state === 'connected' && this._built && !this._dirty && !this.error;
    const values = {};
    const meters = this.meters.map((m) => {
      const hit = this.cache.get(cacheKey(m.component, m.pin));
      const stale = !live || !hit;
      if (!stale && typeof hit.value === 'number') (values[m.chain] = values[m.chain] || {})[m.key] = hit.value;
      return {
        key: m.key, chain: m.chain, role: m.role, component: m.component, pin: m.pin, label: m.label,
        value: hit ? hit.value : null, string: hit ? hit.string : null, unit: m.unit, lo: m.lo, hi: m.hi, stale,
      };
    });
    const error = this.error || (state === 'disconnected' ? this.session.error : null);
    const findings = this.rig ? advise(this.rig, values, { mode: this.mode, props: this.props }) : [];
    // S5 — values computed from several meters, one per chain, with "needs …" when not derivable.
    const elr = this.rig ? this.rig.chains.map((c) => deriveElr(c, values[c.id] || {}, this.mode)) : [];
    return { t: Date.now(), state, mode: this.mode, error, meters, derived: { elr }, findings };
  }
}

module.exports = { MeterPoller, meterList, GROUP_ID, DEFAULT_POLL_MS };
