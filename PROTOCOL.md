# CSP Companion Protocol — Observed Notes

Reverse-engineered from Wireshark "Follow TCP Stream" captures of the official CSP mobile companion app talking to CSP desktop during normal sessions (full usage, plus a separate disconnect/reconnect capture).

This supplements [chocolatkey/clipremote](https://github.com/chocolatkey/clipremote) (which only documents `Authenticate`, `TellHeartbeat`, `GetModifyKeyString`, `GetServerSelectedTabKind`, `SetServerSelectedTabKind`, `PreviewWebtoonFromClient`). Everything below was observed empirically — treat it as field notes, not an official spec.

## QR code & transport discovery

Scanning the companion QR on the phone reveals a URL like `https://companion.clip-studio.com/rc/zh-tw?s=<hex>`. The `s` query parameter is the actual payload; the rest is a redirect page.

- `s` is hex-encoded ciphertext.
- Plaintext = `xor_cycle(hex_decode(s), REMOTE_KEY)` where `REMOTE_KEY = 74 B2 92 5B 4A 21 DA` (7-byte rotating XOR key — distinct from `AUTH_KEY` used by `Authenticate`).
- Plaintext format: four tab-separated (`\t`) fields — `ips,port,password,generation`:
  - `ips` — comma-separated list of IPv4 addresses (the desktop advertises every interface it's listening on; pick the first reachable one).
  - `port` — TCP listen port (random ephemeral each time the companion window is opened).
  - `password` — ASCII string used as the initial `currentAuthToken` input (see Handshake below).
  - `generation` — spec/version tag, e.g. `G#1:2022.12`. Echoed in every `Authenticate` call.

## Framing

## Framing

Each TCP message is a single record:

```
<TYPE:1> $tcp_remote_command_protocol_version=1.0 <RS> $command=<NAME> <RS> $serial=<N> <RS> $detail=<JSON-or-empty> <RS> <TERM>
```

- `TYPE` — `0x01` command/push, `0x06` success response, `0x15` error response.
- `RS` — `0x1E` record separator between fields.
- `TERM` — `0x00` terminator.
- `detail` — empty, a JSON object, or a JSON array (Authenticate uses an array).
- `serial` — monotonic per direction; the response echoes the request's serial. (Wireshark renders `0x1E`/`0x00`/most non-ASCII bytes as `.`, so raw dumps look like `.$detail=..` even when content is non-empty; don't trust visual emptiness blindly.)

**Parse gotcha:** the last field (`detail=<JSON>`) is followed by an `RS` byte **before** the final `TERM`, i.e. `...}\x1e\x00`. A naive implementation that splits on `\x1e$` leaves a trailing `\x1e` glued to the JSON string, so `json.loads` throws. Strip the trailing `\x1e` (and `\x00` if you included it) before decoding.

**Coalesced records:** multiple records may arrive in a single `recv()` chunk (observed as concatenated frames in `wire.log`). Buffer and re-scan for `TERM` rather than assuming one record per read. A record's start can be found by scanning backward from `TERM` for the nearest `0x01`/`0x06`/`0x15` type byte.

## Handshake

1. Phone → `Authenticate` with `["<RemoteCommandSpecVersion>", "<currentAuthToken>", "<newAuthToken>"]`. Tokens are the session password XOR-ed with `AUTH_KEY` then hex-encoded. The password rotates every auth — the `newAuthToken` the phone sends becomes the next session password.
2. Server → `Authenticate` success with `{"AuthErrorReason":"Unknown","RemoteCommandSpecVersionOfServer":"G#1:2022.12","IsQuickAccessAvailable":true}`.
3. Phone → a batch of empty `TellHeartbeat`s while idle.

### Reconnect without rescanning the QR

On a fresh socket, the phone sends the literal string `{{(([[reconnection request marker]]))}}\r\n` (41 bytes including the trailing CRLF) as the `currentAuthToken` — XOR-obfuscated with `AUTH_KEY` exactly like a password, yielding an 82-char hex token. CSP accepts this as an alternative to the original QR password.

Critical second half of the handshake: the `newAuthToken` on reconnect is **not a fresh random password**. The phone re-sends the exact `newAuthToken` it sent during the original first-time auth (observed in PHONEFIRST vs PHONERECONNECT captures — both show `"eab2bcfb8bd3a58a"` in the new slot). CSP's check is effectively "curr == marker AND new == <password-I-stored-during-last-auth>". So the client must persist the `new_pass` from initial auth and re-send the identical value on every reconnect. If it randomizes, CSP replies `PasswordMismatch`.

## Heartbeat & the idle gate ⚠ (the bug we hit)

Heartbeat fires on both sides; the payload changes meaning:

- Empty `$detail=` → passive keep-alive. **CSP's server treats this client as idle.**
- `$detail={"IdleTimerResetRequested":true}` → active client. The server then emits full UI state on subsequent `Sync*` calls.

The phone starts with empty heartbeats, then switches to `IdleTimerResetRequested:true` the moment the user touches the UI. Our Python client was sending empty heartbeats forever, so the server replied to every `SyncColorCircleUIState` with `$detail={}`. Fix: always include `IdleTimerResetRequested:true` in our heartbeat.

## Field encodings

- `HSVColorH/S/V`, `HSVColorMainH/S/V`, `HSVColorSubH/S/V` — `uint32` scaled over `MAX_U32 = 4294967295`. H maps `0..MAX_U32 → 0..360°`, S/V map to `0..100%`.
- `CurrentColorRed/Green/Blue` (seen in `SyncSubViewUIState`) — same uint32 scaling, `0..MAX_U32 → 0..255`.
- `CurrentToolBrushSize` — float, unit given by sibling field `LengthUnitKind` (`"px"` in captures).
- `CurrentToolAlphaPercent` — integer 0..100.
- `ColorIndex` — `0` = main/foreground, `1` = sub/background, matching CSP's two-slot color model.
- `ColorSpaceKind` — string enum: `"HSV"` was the only value observed.
- `IsManipulating` — true while the user is mid-drag; the phone uses it to tell the server "this is a streaming update, don't log it as a discrete history step".

## Command reference (from this capture)

Total command volume in this capture: `SyncQuickAccessUIState` 600, `SyncColorCircleUIState` 344, `SetCurrentColor` 340, `SetBrushSize` 168, `TellHeartbeat` 138, `SetAlpha` 88, `GetQuickAccessItemIcon` 88, `SyncGesturePadUIState` 54, `SyncSubViewUIState` 34, `SyncColorMixUIState` 28, `DoQuickAccess` 22, `GetQuickAccessData` 6, `PreviewWebtoonFromClient` 4, `SetServerSelectedTabKind` 2, `GetServerSelectedTabKind` 2, `GetModifyKeyString` 2, `Authenticate` 2.

All `Sync*` commands follow the same pattern: phone request carries empty detail (a pure poll), server response carries the full current UI state. They are polled ~2 Hz while the corresponding mobile tab is open.

### Color

**`SyncColorCircleUIState`** — *the* command for reading CSP's current brush color.

Request detail: `{}` (empty).

Response detail (example, line 28 of the capture):
```json
{
  "ColorSelectionModel": "HSV",
  "CurrentColorIndex": 0,
  "PrevColorIndex": 0,
  "HSVColorMainH": 25195178,
  "HSVColorMainS": 2931453695,
  "HSVColorMainV": 4118002943,
  "HSVColorSubH": 0,
  "HSVColorSubS": 0,
  "HSVColorSubV": 4294967295,
  "IsCurrentColorTransparent": false,
  "CanExecuteSetterCommand": true,
  "IsManipulating": false,
  "LengthUnitKind": "px",
  "CurrentToolBrushSize": 208.3824031498136,
  "IsToolBrushSizeAvailable": true,
  "CurrentToolAlphaPercent": 100,
  "IsToolAlphaAvailable": true
}
```

Empty `{}` response = you're in the idle gate; send an active heartbeat first.

**Stale-state request trick:** even with the idle gate cleared, CSP sometimes returns a partial `detail` that omits `HSVColorMain*` fields if nothing has changed since your previous sync. Workaround: send a *non-empty* request detail that describes a deliberately stale state, e.g.
```json
{"IsManipulating":false,"HSVColorMainH":0,"HSVColorMainS":0,"HSVColorMainV":0,
 "CurrentColorIndex":0,"ColorSelectionModel":"HSV"}
```
CSP then diffs your declared state against reality and returns a *full* color payload. The implementation in this repo uses this trick in `get_color_rgb`.

**`SetCurrentColor`** — write the fore/background color.

Request detail:
```json
{
  "ColorSpaceKind": "HSV",
  "IsColorTransparent": false,
  "HSVColorH": 216465408,
  "HSVColorS": 2931453695,
  "HSVColorV": 4118002943,
  "ColorIndex": 0
}
```

Note the field-name difference: **`HSVColorH/S/V`** for set, **`HSVColorMainH/S/V`** (or `…Sub…`) for the sync reads.

Response detail: empty.

**`SyncColorMixUIState`** — color-mix palette state (palette swatches). Not interesting for our use.

**`SyncSubViewUIState`** — "sub view" color picker. Uses RGB fields instead of HSV:
```json
{"CurrentColorRed":1285049496,"CurrentColorGreen":1304645059,"CurrentColorBlue":899102103,
 "IsCurrentColorTransparent":false,"CanExecuteSetterCommand":true,"IsManipulating":false}
```

### Tool

- **`SetBrushSize`** — request body likely `{"BrushSize": <uint32-or-float>, ...}` (not inspected in detail here; issued rapidly during brush-slider drags).
- **`SetAlpha`** — request body likely `{"AlphaPercent": <0-100>, ...}`.

### Tabs / routing

- **`GetServerSelectedTabKind`** → `{"ServerSelectedTabKind":"Invalid"}` when nothing is active.
- **`SetServerSelectedTabKind`** — observed only once at session start, with an empty detail payload; does *not* appear to be required to "unlock" color sync. The idle-timer flag is what actually gates `Sync*` state.

### Quick Access (mobile's customizable button grid)

- `GetQuickAccessData` — returns the grid layout (commands, tools, panels).
- `GetQuickAccessItemIcon` — fetches a specific item's icon. Request detail: `{"ItemIDCommandName":"","ItemIDToolUuid":"c080627816-…","ItemIDType":"Tool","ItemIDCommandType":""}`.
- `DoQuickAccess` — invoke an item. Request detail: `{"ItemCommandName":"undo","ItemCommandType":"basiccommand","ItemType":"Command"}` for built-ins like undo/redo/save.
- `SyncQuickAccessUIState` — polled (600 calls in one session), response lists the currently visible page of items and their enabled state.

### Other

- `GetModifyKeyString` — request is the phone's current `{"CtrlPushed","AltPushed","ShiftPushed"}` state; response is CSP's OS-localized labels for each modifier (per-OS key names).
- `SyncGesturePadUIState` — response lists the gesture-pad buttons and gesture bindings.
- `PreviewWebtoonFromClient` — mobile asks desktop to render the current canvas preview for display on the phone.

## Practical consequences for this tool

1. Every heartbeat must include `{"IdleTimerResetRequested":true}` or the server starves subsequent `Sync*` reads.
2. `get_color_rgb` only needs one command: `SyncColorCircleUIState` with empty detail; parse `HSVColorMainH/S/V` from the response.
3. To react to desktop-side color changes passively, keep heartbeat interval ≤ 3 s — that's what drains any pushed updates from the socket buffer. (Our code already polls on heartbeat; the `_absorb_color` hook in `_try_parse` catches any message with color fields whether expected or not.)
4. There are no known `Get*` commands for color — the `Sync*` request/response pair is the read API.

## Open / unverified

- Whether the idle timer auto-expires mid-session if heartbeats become empty again. Not tested.
- Exact `SetServerSelectedTabKind` payload format — only the empty variant seen.
- Whether `SetBrushSize`/`SetAlpha` detail fields match the sync-response field names byte-for-byte.
