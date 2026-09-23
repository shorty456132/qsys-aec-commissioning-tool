# TASKS — AEC Commissioning Assistant (v2)

**Goal:** the tech maps each stage of a Q-SYS design's gain chain to its
component, enters field readings (seat SPL, noise floor, RT60), and the app
watches the live meters and says **what to adjust, on which control, and
why**. Two tabs: **Setup** and **Monitor**.

**Every session:** read `ADR.md` → take the top card in **To Do** whose
dependencies are Done → test-first (red → green → refactor) → move the card →
add ≤ 5 lines to the Session Log. Anything not verified against docs,
emulation or a Core gets `NEEDS-TEST:`.

**Test policy:** everything testable runs in `npm test` with zero deps. QRC
goes to the fake server (`test-server.js`), which can play **scripted
meter values** (ADR-13). Emulation is fine for pin names and types, but its
meters don't move, so live meter behaviour waits for S10.

---

## Contracts (fixed before S1 — every slice builds against these)

```js
// Rig — persisted to rig.json via GET/PUT /api/rig (ADR-10)
Rig = {
  chains: [{                      // one chain = one mic path; UI starts with 1
    id, label,
    input:     { component, channel } | null,  // Mic/Line, Flex, Dante in
    micGain:   { component, channel } | null,  // gain block after input
    aec:       { component, channel } | null,
    automixer: { component, channel } | null,  // gating automixer
    mixer:     [{ component, in, out }],       // monitored crosspoints (0..n)
    output:    { component, channel } | null,  // line out / Dante out
  }],
  field: { seatSpl: [number], noiseFloor: number|null, rt60: number|null },
}

// Role registry — roles.js, one entry per chain stage (ADR-10)
Role = { id, label, typeMatch: RegExp,         // dropdown filter; "show all" fallback
         meters(sel) -> [{ key, pin, label, unit, lo, hi }],
         knobs(sel)  -> [{ key, pin, label, lo, hi }] }  // named in findings, never written

// Monitor snapshot — GET /api/monitor, short-polled by the UI (ADR-11)
Snapshot = { t, state, meters: [{ key, chain, role, component, pin, label,
             value, string, unit, lo, hi, stale }], findings: [Finding] }

// Finding — advisor.js, pure: advise(rig, meterValues) -> [Finding] (ADR-12)
Finding = { id, level: 'ok'|'warn'|'bad', text,
            trigger: { key, value } | null,
            adjust: [{ component, pin, label }],
            source: 'doc:<file>' | 'heuristic' }
```

---

## To Do

**S1 — New shell + Setup tab with an AEC stage** *(no deps)*
Replace the v1 UI with the Setup / Monitor tabs. Setup = the connection panel
plus a chain editor that has one stage so far, **AEC**: a dropdown of
components matching the role's `typeMatch` (with a "show all" toggle), and a
channel picker. Save to `rig.json`.
Delete the simulator (`gain-model.js`, `test-gain-model.js`, v1 markup/JS
in `public/`). The v1 HTML stays in the repo root, not served (ADR-09).
Tests first:
- `GET /api/rig` with no file → the default rig (1 empty chain, empty field)
- `PUT /api/rig` validates: unknown role key → 400; bad channel → 400;
  round-trips; written to `rig.json`; survives an app restart
- `GET /api/roles/aec/candidates` → only components whose Type matches
  (fixture: `acoustic_echo_canceler_simd`); `?all=1` → every component;
  not connected → 409
- `roles.js`: AEC role `meters({channel:1})` → `channel.1.ref.mic.ratio`,
  `channel.1.ERLE`; `knobs` → `channel.1.ref.gain`, `min.ref.level`,
  `min.mic.level` (CONFIRMED pins)
- `/` serves the new shell; `gain-model.js` → 404
Acceptance (emulation): pick `200ms_Acoustic_Echo_Canceler` ch 1 → save →
restart server → selection still there.

**S2 — Monitor tracer: AEC meters + first finding** *(needs S1)*
`meters.js`: one change group (`ChangeGroup.AddComponentControl` for every
meter pin in the rig) → `ChangeGroup.Poll` every 500 ms → a value cache,
because Poll returns changes only. `GET /api/monitor` → Snapshot. The
Monitor tab shows an RMLR bar meter (centred on 0, pins at ±10 dB), an ERLE
meter (0…20), and an ELR card reading "needs a named output component"
(ADR-07). First rule: RMLR outside ±3 dB → "Adjust Reference gain
(`channel.N.ref.gain`)".
Tests first:
- the fake server gets `ChangeGroup.*` plus a scripted meter track; the poller
  merges partial `Changes` into the cache
- rig change → group rebuilt (`Clear`/re-add), with no second group leaked
  (max 4, ADR-11)
- `advise`: RMLR +5 → warn, trigger `{key, 5}`, adjust `ref.gain`,
  `source: 'doc:AEC_Gain_Structure.md'`; RMLR 0 → ok
- disconnect → poller stops; snapshot `state: 'disconnected'`, meters `stale`
- a poll error → surfaced in the snapshot, never swallowed
- `NEEDS-TEST:` RMLR sign convention (is +ve "ref hotter than mic"?) → S10
Acceptance (emulation): meters render and read the static values; the
poll runs without errors for more than 60 s (it doubles as the keepalive).

**S3 — Input stage (Mic/Line, Flex, Dante in)** *(needs S2)*
Role + dropdown + channel; input level meter + clip; rules: talker window
−20…−15 dBFS, noise at the input ≤ −35…−40 dBFS, peak/clip → adjust
`input.gain`.
Tests first: Flex pins CONFIRMED (`channel.N.digital.input.level`, `.clip`,
`.input.gain`); each rule's ok/warn/bad edges; clip → bad.
`NEEDS-TEST:` Mic/Line In and Dante Rx type strings + pin names (emulation).

**S4 — Field readings** *(needs S2)*
The Setup tab gets inputs for seat SPL (several positions), noise floor (dB
SPL) and RT60 (s, broadband), saved in `rig.field`. Rules: seat SPL outside
65…70 dBA → adjust the amp/output; acoustic SNR (SPL − noise) < 15 dB bad,
< 25 dB warn; RT60 > AEC `tail_length` property → suggest a longer tail
(heuristic; note the DSP cost).
Tests first: validation (numbers, ranges, empty allowed); each rule's edges;
the tail rule reads `tail_length` from the component properties.

**S5 — Output stage + derived ELR** *(needs S2)*
Role (line out / Dante out) + output level meter; near-clip rule (> −3
dBFS); the ELR card becomes output level − mic echo level (ADR-07) once both
stages are set.
Tests first: ELR math; ELR < 6 dB → warn; one stage missing → the card keeps
the "needs …" text. `NEEDS-TEST:` output type strings + pins (emulation).

**S6 — Mixer crosspoints (monitor 1..n)** *(needs S2)*
Mixer dropdown → an in × out picker; add or remove several crosspoints;
show crosspoint gain/mute; rule: a mic crosspoint routed into the AEC
reference feed → bad ("underwater" effect, `AEC_Troubleshooting.md`).
Tests first: add/remove crosspoints; pin naming per mixer type.
`NEEDS-TEST:` matrix-mixer crosspoint pin names (emulation).

**S7 — Gating automixer** *(needs S2)*
Role + channel; gate/level meters; rules TBD from pins + docs.
`NEEDS-TEST:` automixer type + pins; find docs before writing any rule.

**S8 — Mic gain block** *(needs S2)*
Role (Gain component) + gain/mute; included in the talker-window advice so
the fix names the right stage (input gain vs gain block).
`NEEDS-TEST:` gain component type string (doc fixture shows `gain`).

**S9 — Findings export + reconnect** *(needs S2)*
A "Copy findings" button → timestamped text for the commissioning log. Remote
drop → banner + auto-retry; the poller resumes and the rig is kept.
Tests first: export format; auto-retry backoff; resume rebuilds the change group.

**S10 — Live Core acceptance** *(BLOCKED: needs a deployed Core with audio)*
Full pass: set up the chain → meters move → ≥ 2 findings raised → tech adjusts
in Designer → findings clear. Resolve every meter `NEEDS-TEST:` (RMLR sign,
live ranges).

## In Progress
- (none)

## Done (carried from v1 — reused as-is)
- QRC client `qrc.js` (framing, id matching, connect errors/timeouts) — 13 tests
- Session `session.js`: one connection, 409 on a second, NoOp check, keepalive
  58 s (ADR-08), `session.call()` → 409/502 — `test-server.js`
- Connect / disconnect / reconnect CONFIRMED in emulation
- Discovery `discovery.js` + `/api/components`, `/api/controls` (the Setup
  tab's "show all" and pin checks reuse it)

## Parking Lot (not scheduled)
- Knob write-back with verified read-back (old T9; ADR-03 + the open
  `Component.Set` reply question)
- UI for several chains (the contract already allows it)
- QWRC / remote Core (ADR-02)

---

## Session Log
<!-- ≤ 5 lines per session. Older history: git / ADR. -->
- **2026-09-22 (S0 planning):** v1 plan retired (T1–T5 done; its code
  carries over). Re-scoped to chain-stage setup + Monitor + advisor. Meters
  confirmed static in emulation → fake scripted meters (ADR-13). Field
  readings = seat SPL + noise floor + broadband RT60.
