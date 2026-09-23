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
level − mic echo level, derived once output + input stages are set (S5).
Until then the card reads "needs a named output component".

**ADR-08 — Keepalive.** The Core drops a client that's been idle 60 s (Verified:
`QRC_Overview.md`). The session sends a `NoOp` every 58 s; a failed NoOp →
`disconnected` + error. The 500 ms meter poll (ADR-11) also keeps the link
alive; the timer stays as a backstop.

**ADR-09 — UI = Setup tab + Monitor tab; v1 UI removed.** The simulator and v1
markup are deleted from `public/`. `aec-erl-rmlr-emulator-v1.html` stays in
the repo root as a reference only (not served).

**ADR-10 — Chain-stage model.** The tech builds a *chain* (one mic path) by
picking a component + channel per stage: input → mic gain → AEC → automixer →
mixer crosspoints (1..n) → output. Dropdowns are filtered by each role's
`typeMatch`. QRC can't reveal wiring, so the chain is the tech's
statement of it. Persisted to `rig.json` together with field readings. The
contract allows several chains; the UI starts with one.

**ADR-11 — Meters via one change group, polled at 500 ms.**
`ChangeGroup.AddComponentControl` + `ChangeGroup.Poll` (Verified:
`QRC_Commands.md`). Poll returns **changes only** → the server keeps a value
cache. Max **4** change groups per connection → we use one, rebuilt with
`Clear` when the rig changes. Explicit Poll, not AutoPoll, so every
response is matched by id. CONFIRMED in emulation: the first Poll after
`AddComponentControl` returns every added pin, so the cache fills without
`Invalidate`. An unknown component → QRC error 7, shown in the snapshot.

**ADR-12 — Advisor = pure function.** `advise(rig, values) → Finding[]`,
server-side, unit-tested. Every finding carries its trigger value, the
control(s) to adjust, and `source`: `doc:<file>` or `heuristic`, so the tech
knows which advice is from Q-SYS guidance and which is our own rule of thumb.

**ADR-13 — Emulation doesn't meter.** CONFIRMED 2026-09-22: every meter
in emulation stays static (RMLR 0, ERLE 0, inputs −120). Emulation is used for
connect, pin names/types/ranges. Meter logic is built against the fake QRC
server with scripted meter tracks. Live meter acceptance = S10 (needs a
Core).

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
AEC — type `acoustic_echo_canceler_simd` (props incl. `tail_length`, `channel_count`)
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `channel.N.ref.mic.ratio` | Float RO | −10…+10 dB | **RMLR** (doc: "Reference-to-Microphone Level Ratio") |
| `channel.N.ERLE` | Float RO | 0…20 dB | ERLE (≠ ELR, ADR-07) |
| `channel.N.ref.gain` | Float RW | −40…0 dB | Reference gain |
| `min.ref.level` | Float RW | −100…0 dB | "Hold If Ref Level Below" |
| `min.mic.level` | Float RW | −100…0 dB | "Hold If Mic Level Below" |

Flex input — type `io_card_flex_in_core_8flex` (8 ch)
| Pin | Type / dir | Range | Role |
|---|---|---|---|
| `channel.N.digital.input.level` | Float RO | −120…+20 dB | Input level meter |
| `channel.N.clip` | Bool RO | — | Clip |
| `channel.N.input.gain` | Float RW | −100…+20 dB | Input gain |

- `NEEDS-TEST:` RMLR sign convention (does +ve mean ref hotter than mic?) —
  needs a Core with audio.
- `NEEDS-TEST:` type strings + pins for Mic/Line In, Dante Rx/Tx, Line Out,
  Gain, Matrix Mixer crosspoints, Gating Automixer (check each in emulation
  in its own slice).

### Advisor thresholds (sources for ADR-12)
| Rule | Threshold | Source |
|---|---|---|
| Talker level at mic input | −20…−15 dBFS | doc: `AEC_Gain_Structure.md` |
| Room noise at mic input | ≤ −35…−40 dBFS | doc: `AEC_Gain_Structure.md` |
| Speech-to-noise | ≥ 15 dB min, 25 dB target | doc: `AEC_Gain_Structure.md` |
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
1. The v2 plan is in TASKS.md. S1 + S2 are done → next is **S3** (S4–S9 also
   only need S2). The contracts at the top of TASKS are fixed; change them only
   by editing both files.
2. `npm test` is 76 green after S2. Tests pass `rigPath` (and `pollMs: 30`) to
   `createApp` so they never touch the repo's `rig.json`. A new metered role
   only needs `roles.js` `meters()` — `meterList` + the poller pick it up.
3. Emulation: `127.0.0.1:1710`, design = `200ms_Acoustic_Echo_Canceler` +
   `Flex_In_Core-1`. Server: `node server.js` (:8080; `PORT=` to override).
