'use strict';
// T5 — Design discovery normalizers (pure). Input shapes are the documented
// QRC results of Component.GetComponents / Component.GetControls.
//
// `aecCandidate` and control `tags` are HINTS for the tech's picker only.
// The real AEC Type string and RMLR/ELR pin names are NEEDS-TEST until
// recorded as CONFIRMED in ADR.md §Design Findings (ADR-04) — nothing
// downstream may key off these hints.

const AEC_RE = /aec|echo/i;
const TAGS = [
  ['rmlr?', /rmlr|ref\.mic\.ratio/i], // Q-SYS AEC names it channel.N.ref.mic.ratio
  ['elr?', /(^|[^a-z])(elr|erl)([^a-z]|$)|return.?loss/i],
];

function normalizeComponents(result) {
  if (!Array.isArray(result)) return [];
  return result
    .map((c) => ({
      name: c.Name,
      type: c.Type,
      aecCandidate: AEC_RE.test(c.Type || '') || AEC_RE.test(c.Name || ''),
      properties: Object.fromEntries((c.Properties || []).map((p) => [p.Name, p.Value])),
    }))
    .sort((a, b) => (b.aecCandidate - a.aecCandidate) || String(a.name).localeCompare(String(b.name)));
}

function normalizeControls(result) {
  const controls = ((result && result.Controls) || [])
    .map((c) => ({
      name: c.Name,
      type: c.Type,
      value: c.Value,
      string: c.String,
      min: c.ValueMin !== undefined ? c.ValueMin : null,
      max: c.ValueMax !== undefined ? c.ValueMax : null,
      direction: c.Direction,
      tags: TAGS.filter(([, re]) => re.test(c.Name || '')).map(([t]) => t),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { name: (result && result.Name) || null, controls };
}

module.exports = { normalizeComponents, normalizeControls };
