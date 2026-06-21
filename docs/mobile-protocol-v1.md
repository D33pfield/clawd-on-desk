# Clawd Mobile Protocol v1

## Scope

Mobile v1 is an opt-in, read-only LAN preview for watching Clawd session state
from a phone or another browser on the same network.

M1 does not expose remote approval, elicitation, writes, terminal control, raw
tool inputs, prompts, full cwd paths, or transcript/output sync. Permission
approval remains on the desktop surfaces and other existing remote channels.

M2 Slice 2 adds read-only permission broadcasting: permission requests are
pushed to all connected PWA clients so the user can observe pending approvals
from their phone. The PWA cannot respond — the desktop bubble remains the sole
approval surface.

## Architecture

```text
Clawd Desktop
  State engine
      |
      v
  LAN WebSocket bridge (0.0.0.0:<port>)
      |-- HTTP static server for /mobile/*
      `-- WebSocket /ws?token=<hex>
              |
              v
        PWA session renderer
```

## Security Model

- **Token**: 32-char hex, generated once and stored at
  `~/.clawd/mobile-token.json`.
- **Transport**: plaintext WebSocket over LAN only. Do not expose it to the
  Internet or untrusted networks.
- **Binding**: `0.0.0.0:<port>`, so same-LAN devices can reach it.
- **Auth**: token is required on WebSocket upgrade; invalid tokens close with
  code 1008.
- **Rate limit**: 60 inbound client messages per 60s per client. M1 ignores
  valid client messages after rate limiting because the protocol is read-only.
- **Max clients**: 10 concurrent WebSocket clients.

## Connection Flow

```text
Mobile                                      Desktop
  |                                           |
  | 1. Open /mobile/?host=&port=&token=      |
  |                                           |
  | 2. WS connect /ws?token=<hex>            |
  |------------------------------------------>|
  |                                           | 3. Validate token
  |                                           |    reject -> close 1008
  |<------------------------------------------|
  | 4. snapshot                              |
  |<------------------------------------------|
  | 5. state / session_deleted updates       |
  |<------------------------------------------|
  | 6. ping                                  |
  |------------------------------------------>|
  | pong                                     |
```

## Message Envelope

All server messages are JSON and include:

| Field | Type | Description |
| --- | --- | --- |
| `version` | string | Always `"v1"` |
| `type` | string | Message type |
| `timestamp` | number | Unix ms |

## Server To Client

### `snapshot`

Sent on initial connection. Contains the currently cached read-only session
preview entries.

```json
{
  "version": "v1",
  "type": "snapshot",
  "timestamp": 1717200000000,
  "sessions": {
    "abc123": {
      "sessionId": "abc123",
      "title": "Fix auth bug",
      "basename": "project",
      "state": "working",
      "recentEvents": [
        { "event": "PreToolUse", "at": 1717199990000, "state": "working" }
      ]
    }
  }
}
```

Preview entry fields:

| Field | Type | Description |
| --- | --- | --- |
| `sessionId` | string | Session identifier |
| `title` | string or null | Sanitized session title or agent id fallback |
| `basename` | string or null | Basename of cwd only, never the full path |
| `state` | string | Clawd display state |
| `recentEvents` | array | Recent event names with timestamps and states only |

`recentEvents[]` entries contain only `{ event, at, state }`. They do not
include tool input, prompts, cwd, transcript contents, or assistant output.

### `state`

Incremental session preview update.

```json
{
  "version": "v1",
  "type": "state",
  "timestamp": 1717200001000,
  "sessionId": "abc123",
  "data": {
    "sessionId": "abc123",
    "title": "Fix auth bug",
    "basename": "project",
    "state": "thinking",
    "recentEvents": [
      { "event": "UserPromptSubmit", "at": 1717200000500, "state": "thinking" }
    ]
  }
}
```

### `session_deleted`

Sent when a session disappears from the desktop session cache.

```json
{
  "version": "v1",
  "type": "session_deleted",
  "timestamp": 1717200002000,
  "sessionId": "abc123"
}
```

### `permission_request`

Sent when a permission bubble appears on the desktop. Read-only observation —
the PWA cannot respond to the request; the desktop bubble remains the sole
approval surface.

```json
{
  "version": "v1",
  "type": "permission_request",
  "timestamp": 1717200003000,
  "permId": "abc123:Bash:1717200003000",
  "sessionId": "abc123",
  "toolName": "Bash",
  "agentId": "claude-code",
  "basename": "my-project",
  "suggestionCount": 2,
  "isElicitation": false,
  "createdAt": 1717200003000
}
```

| Field | Type | Description |
| --- | --- | --- |
| `permId` | string | Unique permission identifier (`sessionId:toolName:createdAt`) |
| `sessionId` | string | Session that triggered the request |
| `toolName` | string | Name of the tool requesting permission |
| `agentId` | string | Agent that triggered the request |
| `basename` | string or null | Basename of the session's cwd |
| `suggestionCount` | number | Number of permission suggestions available |
| `isElicitation` | boolean | True if this is an AskUserQuestion / elicitation |
| `createdAt` | number | Unix ms when the permission was created |

### `permission_resolved`

Sent when a pending permission is resolved (allow, deny, dismiss, auto-close,
DND, etc.). Clients should remove or visually mark the corresponding
`permission_request` card.

```json
{
  "version": "v1",
  "type": "permission_resolved",
  "timestamp": 1717200015000,
  "permId": "abc123:Bash:1717200003000",
  "sessionId": "abc123",
  "toolName": "Bash",
  "reason": "resolved"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `permId` | string | Matches the `permId` from the original `permission_request` |
| `sessionId` | string | Session that triggered the request |
| `toolName` | string | Name of the tool that requested permission |
| `reason` | string | Resolution reason (see below) |

`reason` values: `"resolved"` (user allow/deny), `"deny-and-focus"` (go to
terminal), `"auto-closed"`, `"dnd-enabled"`, `"no-decision"`, `"dismissed"`.

## Client To Server

M1 defines no write messages. The server accepts WebSocket frames only to apply
the inbound rate limit and then ignores them.

## Settings Connection Info

The desktop Settings panel reads connection info through Electron IPC. If the
LAN bridge object exists but has not finished listening yet, the IPC response is:

```json
{
  "status": "starting",
  "message": "LAN bridge is starting"
}
```

Once ready, the response is:

```json
{
  "status": "ok",
  "lanIp": "192.168.1.23",
  "port": 23334,
  "token": "0123456789abcdef0123456789abcdef",
  "pairUrl": "http://192.168.1.23:23334/mobile/?host=192.168.1.23&port=23334&token=0123456789abcdef0123456789abcdef"
}
```

The public `/api/connection-info` endpoint intentionally does not return the
token. Pairing URLs are shown from Settings only.

## Limitations

- LAN only; no TLS.
- Token compromise grants read-only session preview access until the token file
  is deleted or rotated manually.
- Session state is eventually consistent because the bridge polls the desktop
  session cache every 2 seconds.
- Max 10 concurrent PWA clients.
- No remote approval, elicitation, terminal control, prompt sync, tool output
  sync, or transcript sync in M1.
- Permission broadcasting (M2 Slice 2) is read-only observation. The PWA
  cannot approve or deny permissions — the desktop bubble is the sole approval
  surface.

## M2 Planned Work

Secure remote approval can be considered in M2 only after pairing, token
rotation/revocation, approval auditability, and a clear fallback story are
designed. Those message types are intentionally absent from v1 M1.
