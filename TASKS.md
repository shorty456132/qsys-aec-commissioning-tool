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
    mixer:     [{ component, in, out, feedsRef }], // monitored crosspoints (0..n); feedsRef (S6,
                                               //   default false) = tech says it feeds the AEC reference
    output:    { component, channel } | null,  // line out / Dante out
  }],
  field: { seatSpl: [number], noiseFloor: number|null, rt60: number|null },
}

// Role registry — roles.js, one entry per chain stage (ADR-10)
Role = { id, label, typeMatch: RegExp,         // dropdown filter; "show all" fallback
         meters(sel) -> [{ key, pin, label, unit, lo, hi }],
         knobs(sel)  -> [{ key, pin, label, lo, hi }] }  // named in findings, never written

// Monitor snapshot — GET /api/monitor, short-polled by the UI (ADR-11)
Snapshot = { t, state, error: string|null,       // poll/rebuild/rig error (S2)
             mode: 'off'|'talker'|'quiet'|'farend', // S3/S5 — PUT /api/monitor/mode {mode}
             meters: [{ key, chain, role, component, pin, label,
             value, string, unit, lo, hi, stale }],
             derived: { elr: [{ chain, value: number|null, needs: string|null }] }, // S5
             findings: [Finding] }

// Finding — advisor.js, pure: advise(rig, meterValues, {mode, props}) -> [Finding] (ADR-12)
//   props (S4) = { [component]: { [property]: string } } from GetComponents on
//   the live connection (null offline); field findings use trigger.key 'field.*'
Finding = { id, level: 'ok'|'warn'|'bad', text,
            trigger: { key, value } | null,
            adjust: [{ component, pin, label }],
            source: 'doc:<file>' | 'heuristic' }
```

---

## To Do

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

## Done
- **S7 — Gating automixer.** `automixer` role (`/^auto_mixer_gating_adaptive$/`;
  `channel.N.open|snr|post.gate.mute|manual` + shared `config.minimum.snr`).
  Rules (doc: component help): talker snr ≤ threshold → warn lower threshold
  (snr at 0 floor → "no signal, check mic/input"); quiet snr > threshold → warn
  raise; post-gate mute → warn (any mode); Manual → ok note, gate rule skipped.
  Open LED not ruled on (Last Mic On). Setup row + Monitor gate card. Emulation
  acceptance passed. `NEEDS-TEST:` other automixer types → "show all".
- **S6 — Mixer crosspoints.** `mixer` role (`/^mixer$/`); per crosspoint
  the poller reads `input.I.output.O.gain` + `input.I.mute` + `output.O.mute`
  (the mixer has no meters). Crosspoint `feedsRef` flag (contract updated);
  duplicates → 400. Rule: `feedsRef` crosspoint open (gain > −100, neither side
  muted) → bad "underwater", adjust crosspoint gain; closed → ok. Setup: in × out
  picker + list; Monitor: mixer card. Emulation acceptance passed (live Set → bad → ok).
  `NEEDS-TEST:` crosspoint mute pin (only when `crosspoint_mute` = "True").
- **S5 — Output stage + derived ELR.** `output` role
  (`/^io_card_(flex|line)_out/i`; `output.level`, knob `output.gain`). New
  Monitor mode **Far-end test** → `derived.elr` = output level − mic input
  level (ADR-07), else "needs …" (stage / mode / meter). ELR < 6 warn
  (heuristic); output > −3 dBFS warn (any mode); the seat-SPL low/high finding
  names the output gain. Emulation acceptance passed (API, Core 24f).
  `NEEDS-TEST:` Dante Tx type/pins → "show all".
- **S4 — Field readings.** Setup panel: seat SPL list (dBA), noise floor
  (dB SPL), RT60 (s); `validateField` (SPL/noise 0…140, RT60 (0, 20] s,
  ≤ 32 seats, empty ok). Rules: seat SPL 65…70 (low → raise, high → lower,
  both → coverage); SNR at the quietest seat < 15 bad, < 25 warn; RT60 >
  AEC `tail_length` → warn (heuristic). The poller reads design props once per
  rebuild; they're dropped on disconnect. Emulation acceptance passed (API).
- **S3 — Input stage (Flex).** `input` role (`/^io_card_flex_in/i`; level,
  clip, knob `input.gain`). Monitor mode Off / Talker test / Quiet room (the
  tech says what's happening; one meter can't tell speech from noise):
  talker −20…−15 warn raise/lower; quiet ≤ −40 ok, ≤ −35 warn, else bad (no
  gain advice: gain doesn't fix SNR); any mode: > −3 warn, clip → bad. Setup
  stage editor made generic per role. Emulation acceptance passed (API).
  `NEEDS-TEST:` Mic/Line In + Dante Rx types/pins (not in the design) → "show all".
- **S2 — Monitor tracer: AEC meters + first finding.** `meters.js`
  (`meterList`, `MeterPoller`: one fixed-Id change group, `Clear` + re-add
  on a rig change, 500 ms chained Poll, value cache), `advisor.js` (RMLR ±3
  rule → adjust `channel.N.ref.gain`), `GET /api/monitor`, `session.onState`
  starts/stops the poller. Monitor tab: RMLR/ERLE bars, ELR placeholder,
  findings. Emulation acceptance passed (65 s, 0 errors, static values read).
- **S1 — New shell + Setup tab with an AEC stage.** `roles.js` (AEC role,
  `defaultRig`, `validateRig`), `GET/PUT /api/rig` (atomic write; a corrupt
  file → 500, never silently reset), `GET /api/roles/:id/candidates[?all=1]`,
  Setup/Monitor shell. Simulator deleted. `createApp({rigPath})` for tests.
  Emulation acceptance passed at the API level (pick → save → restart → kept).

### Carried from v1 (reused as-is)
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
- Input "no signal" rule: talker mode at ≈ −120 dBFS currently says "raise
  input gain"; a dead input should say check mic / phantom / mute instead
  (seen in S3 emulation acceptance)
- Input rule for Mic/Line In + Dante Rx. Mic/Line In is now in the design
  (`io_card_mic_line_in_core_24f`) with the same level/clip/gain pins as the
  Flex → widening `input.typeMatch` is likely a one-liner + test. Dante Rx
  still unseen.
- ELR on silent meters: far-end mode with both meters at −120 gives ELR 0 →
  warn. Should say "no signal — play far-end audio" (seen in S5 acceptance;
  same family as the input "no signal" item)
- Clip latch: a 500 ms poll can miss a short clip; `channel.N.clip.hold` (RW
  Bool) exists on the Flex
- Crosspoint mute: a mixer with `crosspoint_mute` "True" has a per-crosspoint
  mute pin (name unconfirmed). Turn it on in the emulation design, read the pin,
  then add it to the "closed" check (S6 ignores it today)

---

## Session Log
<!-- ≤ 5 lines per session. Older history: git / ADR. -->
- **2026-09-22 (S0 planning):** v1 plan retired (T1–T5 done; its code
  carries over). Re-scoped to chain-stage setup + Monitor + advisor. Meters
  confirmed static in emulation → fake scripted meters (ADR-13). Field
  readings = seat SPL + noise floor + broadband RT60.
- **2026-09-22 (S1):** done, `npm test` 59 green. AEC `typeMatch`
  `/^acoustic_echo_cancel/i`; emulation lists only `200ms_Acoustic_Echo_Canceler`
  (channel_count "1"). Meter keys are `aec.rmlr` / `aec.erle`, knob keys
  `aec.refGain|minRef|minMic` → S2 builds on these. The browser UI hasn't
  been clicked through by hand yet.
- **2026-09-22 (S2):** done, `npm test` 76 green. CONFIRMED in emulation: the
  first Poll after AddComponentControl returns every added pin; `Clear` +
  re-add works; an unknown component → QRC error 7 (surfaced, retried each
  tick). Snapshot gained `error` (contract updated). The Monitor UI hasn't
  been clicked through by hand yet. `NEEDS-TEST:` RMLR sign → S10.
- **2026-09-23 (S3):** done, `npm test` 91 green. Talker/noise split by a
  tech-set Monitor mode (Andrew's call) → contract: `advise(…, {mode})`,
  `Snapshot.mode`. CONFIRMED: Poll returns the clip Bool as 0/1; the Flex has
  no `channel_count` property (UI falls back to 16). Emulation has no Mic/Line
  or Dante component. UI not clicked through by hand yet.
- **2026-09-23 (S4):** done, `npm test` 105 green. CONFIRMED: `tail_length`
  is a string in seconds ("0.2"). `advise` gained `{props}` (contract updated)
  — the poller fetches `GetComponents` on rebuild, so there's no new Rig field. SNR uses the
  quietest seat. Field findings show offline; the tail rule shows only while connected.
- **2026-09-23 (S5):** done, `npm test` 120 green. Emulation design is now a
  Core 24f + Mic/Line In, Flex In/Out, Line Out, SPA-Qf amp, meter2, 8×8
  mixer, gating automixer (types in ADR §Pins, ready for S6–S8). Flex Out and
  Line Out share pins. ELR needs a tech-set `farend` mode (contract updated).
- **2026-09-23 (S6):** done, `npm test` 134 green. The AEC-ref crosspoint is
  tagged by the tech (`feedsRef`, Andrew's call) → contract updated. CONFIRMED:
  mixer mutes Poll as 0/1 ("unmuted"); `Component.Set` moves emulation controls
  and Poll reports them. `meterList` walks `chainSelections()`; poller dedupes pins.
  UI not clicked through by hand yet.
- **2026-09-23 (S7):** done, `npm test` 147 green. AEC docs say nothing on
  automixers → rules cite the component help page. CONFIRMED: `config.LMO.enable`
  defaults true (so no "open in quiet room" rule); `n_channels` is the channel
  count prop (UI reads it); Set on mute/manual/threshold → Poll 0/1 + value.
  Contract unchanged. UI not clicked through by hand yet.
