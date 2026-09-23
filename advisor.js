'use strict';
// S2 — Advisor (ADR-12). Pure: advise(rig, values) → Finding[].
//
// `values` = { [chainId]: { [meterKey]: number } }, fresh values only — the
// caller leaves stale meters out, so there's never advice on stale data.
// Every finding names its trigger, the control(s) to turn and its source.

const { ROLES } = require('./roles');

// RMLR ≈ 0 dB (doc: AEC_Gain_Structure.md); the ±3 dB window is heuristic (v1).
const RMLR_WINDOW_DB = 3;

const fmtDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

function knob(chain, roleId, key) {
  const sel = chain[roleId];
  const k = ROLES[roleId].knobs(sel).find((x) => x.key === key);
  return { component: sel.component, pin: k.pin, label: k.label };
}

// NEEDS-TEST: RMLR sign convention (S10) — so the text says "adjust", never
// "raise"/"lower".
function rmlrRule(chain, v) {
  if (!chain.aec || typeof v !== 'number') return [];
  const base = { id: `${chain.id}:aec.rmlr`, trigger: { key: 'aec.rmlr', value: v }, source: 'doc:AEC_Gain_Structure.md' };
  if (Math.abs(v) <= RMLR_WINDOW_DB) {
    return [{ ...base, level: 'ok', text: `RMLR ${fmtDb(v)} — within ±${RMLR_WINDOW_DB} dB of 0.`, adjust: [] }];
  }
  const ref = knob(chain, 'aec', 'aec.refGain');
  return [{
    ...base,
    level: 'warn',
    text: `RMLR ${fmtDb(v)} — outside ±${RMLR_WINDOW_DB} dB. Adjust ${ref.label} (${ref.pin}) on ${ref.component} to bring RMLR toward 0 dB.`,
    adjust: [ref],
  }];
}

function advise(rig, values) {
  const out = [];
  for (const chain of rig.chains) {
    const v = values[chain.id] || {};
    out.push(...rmlrRule(chain, v['aec.rmlr']));
  }
  return out;
}

module.exports = { advise, RMLR_WINDOW_DB };
