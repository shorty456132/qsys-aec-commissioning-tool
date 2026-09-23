# ADR — AEC Commissioning Assistant

Continuity file for a multi-session build. `TASKS.md` is the work queue.
**Size rule:** keep this file under ~150 lines. A superseded decision
shrinks to one line under *Superseded*. Findings keep only what the code
relies on. History goes in the TASKS Session Log, not here.
Labels: **Verified** (named source) · **CONFIRMED** (seen in emulation or on a
Core) · `NEEDS-TEST:` (don't build on it yet).

---

## Decisions (active)

**ADR-01 — Local Node server + browser UI, zero npm deps.** A browser can't
open raw TCP, so one `node server.js` process holds the QRC socket (`net`)
and serves the UI + `/api/*` (`http`). Runs off a stick with no install.

**ADR-02 — QRC only (TCP 1710).** QWRC (1715) isn't in the bundled docs →
parked until its handshake is confirmed. QRC over LAN/VPN covers commissioning.

**ADR-03 — One QRC session, one serialized user.** All traffic goes through
`session.call()`. Never open a second socket. If knob writes are ever added
(Parking Lot): the write and its `Component.Get` read-back happen on separate
ticks ≥ 1–1.5 s apart, and no write is sent while a read-back is pending.

**ADR-04 — Never hardcode pins you haven't confirmed.** QRC names are
**Code Names**, not display names. A role's pins go into `roles.js` only
once CONFIRMED (§Pins). Unknown component types still work through the
"show all" fallback + `NEEDS-TEST:`.

**ADR-06 — Advisory, not a remote Designer.** Findings name the control to
turn and why. The app doesn't write knobs (write-back is parked).

**ADR-07 — ELR vs ERLE.** The AEC has no ELR pin. `channel.N.ERLE` is echo
return loss *enhancement* → its own card, never labelled ELR. ELR = output
level − mic echo level (`output.level` − `input.level`), derived (S5) only
when both stages are set **and** the mode is `farend` (ADR-14). Otherwise
`Snapshot.derived.elr[].needs` says what's missing (stage, mode, live meter).

**ADR-08 — Keepalive.** The Core drops a client idle 60 s (Verified:
`QRC_Overview.md`) → `NoOp` every 58 s; a failed NoOp → `disconnected` +
error. The 500 ms poll (ADR-11) also keeps the link alive; timer = backstop.

**ADR-09 — UI = Setup tab + Monitor tab; v1 UI removed.**
`reference/aec-erl-rmlr-emulator-v1.html` stays as a reference (not served).

**ADR-10 — Chain-stage model.** A *chain* (one mic path) = a component +
channel per stage: input → mic gain → AEC → automixer → mixer crosspoints
(1..n) → output, dropdowns filtered by `typeMatch`. QRC can't reveal wiring,
so the chain is the tech's statement of it. Saved to `rig.json` with the
field readings. Contract allows several chains; the UI shows one.

**ADR-11 — Meters via one change group, polled at 500 ms.** `AddComponentControl`
+ explicit `Poll` (Verified: `QRC_Commands.md`; not AutoPoll, so replies match
by id). Poll returns changes only → value cache. Max 4 groups/connection → one,
`Clear` + re-add on a rig change. CONFIRMED: the first Poll returns every pin
(no `Invalidate`); an unknown component → QRC error 7, shown in the snapshot.

**ADR-12 — Advisor = pure function.** `advise(rig, values, {mode, props}) →
Finding[]`, server-side, unit-tested. `props` (S4) come from one
`GetComponents` per rebuild, dropped on disconnect. Every finding carries its
trigger value, the control(s) to adjust, and `source` (`doc:<file>` |
`heuristic`) so the tech knows Q-SYS guidance from our rule of thumb.

**ADR-14 — Monitor mode says what the room is doing (S3).** One meter can't
tell speech from noise, so the tech sets `off` | `talker` | `quiet` |
`farend` (S5: far-end playing, room silent → mic level = echo, ELR readable).
Session state on the poller (`PUT /api/monitor/mode`), not in `rig.json`.
Clip/peak rules apply in every mode. Rejected: rolling min/max (word gaps ≠
noise floor).

**ADR-13 — Emulation doesn't meter.** CONFIRMED 2026-09-22: meters stay
static (RMLR 0, ERLE 0, levels −120). Emulation → connect, pin names/types/
ranges; meter logic → fake server with scripted tracks; live meters = S10.

### Superseded
- ADR-05 Simulator mode stays → replaced by ADR-09 (2026-09-22).
- v1 plan T1–T13 → replaced by the v2 TASKS (2026-09-22). Reused: `qrc.js`,
  `session.js`, `discovery.js`, `server.js`.

---

## Findings

### QRC protocol (Verified: skill `qsys_connection.py`, `QRC_Commands.md`, `QRC_Overview.md`)
- JSON-RPC 2.0 over TCP 1710, frames end in `\x00`. There's an unsolicited
  `EngineStatus` right after connect → match replies by `id`.
- `Logon {User, Password}` is optional. `NoOp` = keepalive.
- `Component.GetComponents` → `[{Name, Type, Properties[]}]`;
  `Component.GetControls {Name}` → `{Name, Controls[{Name, Type, Value,
  ValueMin, ValueMax, String, Direction}]}`.
- A QRC error reply (e.g. unknown component) → HTTP 502; the session stays up.
- Open: the docs say `Component.Set` replies (`ResponseValues`), but
  `qrc.js` assumes no reply. Only matters if write-back leaves the Parking Lot.

### Pins (CONFIRMED in emulation 2026-09-22; `channel.N` = per channel)
AEC — type `acoustic_echo_canceler_simd` (props incl. `tail_length` — string,
seconds, e.g. `"0.2"` — and `channel_count`)
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `channel.N.ref.mic.ratio` | Float RO | −10…+10 dB | **RMLR** (doc: "Reference-to-Microphone Level Ratio") |
| `channel.N.ERLE` | Float RO | 0…20 dB | ERLE (≠ ELR, ADR-07) |
| `channel.N.ref.gain` | Float RW | −40…0 dB | Reference gain |
| `min.ref.level` | Float RW | −100…0 dB | "Hold If Ref Level Below" |
| `min.mic.level` | Float RW | −100…0 dB | "Hold If Mic Level Below" |

Flex input — type `io_card_flex_in_core_8flex` / `io_card_flex_in_core_24f` (8 ch; **no** `channel_count` property)
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `channel.N.digital.input.level` | Float RO | −120…+20 dB | Input level meter (treated as dBFS) |
| `channel.N.clip` | Bool RO | — | Clip (GetControls → `false`; **Poll → 0/1**) |
| `channel.N.input.gain` | Float RW | −100…+20 dB | Input gain |
| `channel.N.clip.hold` | Bool RW | — | Clip hold (unused; Parking Lot) |

Mic/Line In `io_card_mic_line_in_core_24f`: same 4 pins as the Flex (not yet in `input.typeMatch`).

Output (2026-09-23, Core 24f) — `io_card_flex_out_core_24f`, `io_card_line_out_core_24f` (8 ch each, same pins)
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `channel.N.digital.output.level` | Float RO | −120…+20 dB | Output level meter (treated as dBFS) |
| `channel.N.output.gain` | Float RW | −100…+20 dB | Output gain |

Mixer (2026-09-23) — type `mixer` (props `n_inputs`, `n_outputs`, `crosspoint_mute` "False"); **no meters**
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `input.I.output.O.gain` | Float RW | −100…+10 dB | Crosspoint gain (−100 = off) |
| `input.N.mute` / `output.N.mute` | Bool RW | — | Mutes (**Poll → 0/1**, String "unmuted") |
Also `input.N.gain|trim|solo|invert`, `output.N.gain|invert`. The AEC-ref crosspoint
is tagged by the tech (`feedsRef`) — QRC can't see wiring (ADR-10).

Types seen, pins not mapped: `auto_mixer_gating_adaptive` (S7),
`meter2`, `spaq_amplifier` — re-read their controls in their slice.

- `NEEDS-TEST:` RMLR sign convention (does +ve mean ref hotter than mic?) —
  needs a Core with audio.
- `NEEDS-TEST:` that `digital.input.level` reads dBFS (0 = full scale) on a
  live Core. The input rules assume it does (S10).
- `NEEDS-TEST:` pins for Gating Automixer, Gain; the crosspoint mute pin
  (only when `crosspoint_mute` = "True"); type + pins for Dante Rx/Tx (check
  each in emulation in its own slice).

### Advisor thresholds (sources for ADR-12)
| Rule | Threshold | Source |
|---|---|---|
| Talker level at mic input | −20…−15 dBFS | doc: `AEC_Gain_Structure.md` |
| Room noise at mic input | ≤ −40 ok, ≤ −35 warn, else bad (quiet mode) | doc: `AEC_Gain_Structure.md` ("at most between about −35 and −40") |
| Speech-to-noise | ≥ 15 dB min, 25 dB target | doc: `AEC_Gain_Structure.md` (S4: acoustic SNR = quietest seat SPL − noise floor) |
| Far-end level in room | 65…70 dBA | doc: `AEC_Gain_Structure.md` |
| RMLR | ≈ 0 dB (warn beyond ±3) | doc: Gain Structure / Troubleshooting; ±3 = heuristic (v1) |
| Mic response vs reference | mic 3–6 dB below ref | doc: `AEC_Troubleshooting.md` |
| Program / input peaks | ≤ −3 dBFS | doc: `AEC_Gain_Structure.md` |
| Mic in AEC reference feed | never ("underwater") | doc: `AEC_Troubleshooting.md` |
| Hold thresholds | −100 default; raise to muted-mic level if mics only attenuate | doc: `AEC_Troubleshooting.md` |
| RT60 vs tail length | RT60 > `tail_length` → suggest a longer tail (each step doubles DSP) | doc says "increase if reverberant"; the comparison is heuristic |
| ELR (derived) | < 6 dB warn | heuristic (v1) |

---

## Resume notes
1. The v2 plan is in TASKS.md. S1–S6 are done → next is **S7** (S8, S9 also
   only need S2). The contracts at the top of TASKS are fixed; change them only
   by editing both files.
2. `npm test` is 134 green after S6. The Setup stage editor in `app.js` is
   generic: add a role id to `STAGE_ROLES` + a `data-role` row in the HTML. Tests pass `rigPath` (and `pollMs: 30`) to
   `createApp` so they never touch the repo's `rig.json`. A new metered role
   only needs `roles.js` `meters()` — `meterList` (via `chainSelections`) + the
   poller pick it up. RW controls can be "metered" too (S6 mixer). In emulation,
   `Component.Set` moves controls and Poll reports it → use it to script acceptance.
3. Emulation: `127.0.0.1:1710`, Core 24f design = `200ms_Acoustic_Echo_Canceler`,
   `Mic/Line_In_Core-1`, `Flex_In_Core-1`, `Flex_Out_Core-1`, `Line_Out_Core-1`,
   `Mixer_8x8`, `Gating_Automatic_Mic_Mixer`, meter, SPA-Qf amp. Server: `npm start` (`node src/server.js`) (:8080; `PORT=` to override).
