# Slack Notifications

[Back to setup guide](setup-guide.md)

Slack notifications are **one-way**. Clawd posts to a Slack channel when a
session finishes, when one ends with an error, and when a tool needs approval —
but Slack cannot send a decision back. Every Allow or Deny still happens in
Clawd: in the desktop bubble, or in an interactive remote channel such as
Telegram or Feishu.

That is the difference from [Telegram Approval](telegram-approval.md) and
[Feishu / Lark Approval](feishu-lark-remote-approval.md), which resolve the
pending permission. Slack only tells you something is waiting.

## What leaves your machine

Read this before choosing a channel. Everything below is delivered to Slack,
readable by everyone in that channel, and retained in your workspace's history
and exports under your workspace's own retention and admin policy. Deleting a
message in Slack does not necessarily remove it from an export.

| Field | Sent when | Where it comes from |
|---|---|---|
| Session title | every completion | often the first line of **your own prompt** |
| Project folder name | completions, permissions | the session's working directory (basename only) |
| Host name | completions | local machine name, or the Remote SSH host |
| Agent and tool name | permissions | e.g. `claude-code`, `Bash` |
| Permission summary / detail | permissions | the agent's own `description` for the call |
| Assistant's last output | **only if** *Include assistant output* is on | the model's final message, redacted and truncated |
| Short session id | completions | Clawd's internal id, first 6 characters |

Clawd redacts recognisable secrets before sending — provider token prefixes,
`Authorization` headers, secret-named `key=value` pairs, and Slack webhook URLs.
That is a **best-effort safety net, not a scanner**: it matches shapes that are
almost always secrets and deliberately does not chase completeness, because a
pattern list broad enough to catch everything also mangles ordinary prose. It
does not make the remaining content less sensitive either — a session title is
still your prompt.

**Use a private channel that only you can read**, and leave *Include assistant
output* off unless you have decided that channel is an appropriate home for
model output.

## Supported events

| Event | Fires when |
|---|---|
| Task done | a session reaches a `done` badge on a completion event |
| Errors & interruptions | a session ends with an error or is interrupted |
| Permission requests | a tool needs approval **and no automation already handled it** |

Each has its own switch.

A permission message is only posted once the request genuinely needs a human. If
permission automation (*auto-tools* or *unattended*) or a session-scoped "always
allow" resolves it, Clawd stays silent — an auto-approved tool call must never
produce an "approval needed" ping for something you never had to act on.

### What Do Not Disturb does, precisely

DND **suppresses permission messages but not completion messages**, and that is
deliberate.

DND's job is to stop things that demand action from interrupting you. A
permission request is dropped at the HTTP route, before Clawd ever announces it,
so no Slack card is posted and the agent falls back to its own terminal prompt.
A completion notification demands nothing — it is the "walk away and come back
when it's done" signal, which is the reason to leave notifications on while you
are away from the desk. Completions therefore continue to arrive during DND, on
Slack and on the other channels that share the same snapshot fanout.

## Choosing a transport

**Incoming Webhook (recommended).** A URL bound to one channel at creation time.
No bot user, no OAuth scopes, no channel id. It can only post.

**Bot token.** An OAuth token for a Slack app, used with `chat.postMessage`.
Needed if you want one app posting to a channel you pick at send time. Requires:

- scope `chat:write`;
- scope `chat:write.public` **only** to post to a public channel the bot has not
  joined — otherwise invite the bot to the channel with `/invite @YourApp`;
- the channel id (`C…`), not the channel name.

Only `xoxb-` (bot) tokens are accepted. `xoxp-` user tokens act as *you* — every
channel and DM you can reach — and `xoxe-` tokens configure the app itself. Both
carry far more authority than posting a notification needs, so a field labelled
"Bot token" refuses them rather than silently accepting a much larger blast
radius.

When both are configured the **webhook wins**, because it needs no scopes and no
channel id.

## Setup

1. **Create the credential.** At [api.slack.com/apps](https://api.slack.com/apps)
   → **Create New App** → **From scratch**, pick your workspace, then either:
   - **Incoming Webhooks** → enable → **Add New Webhook to Workspace** → choose a
     private channel; or
   - **OAuth & Permissions** → add `chat:write` → **Install to Workspace** → copy
     the `xoxb-` token, and note the target channel's id.

   A webhook URL has the form
   `https://hooks.slack.com/services/<team>/<app>/<secret>`, where the last
   segment is the credential. Treat the whole URL as a password: anyone holding
   it can post to that channel.

2. **Save it in Clawd.** **Settings → Remote Approval → Slack**, paste into
   step 1, then **Save**. For the bot transport also fill in the channel id.

   Clawd only accepts `https://hooks.slack.com/…`, compared by exact hostname —
   never a suffix or substring match — so `evil-slack.com` and
   `hooks.slack.com.evil.example` are rejected. Redirects are refused for the
   same reason: a 3xx would move the request, and on the bot transport the
   `Authorization` header, to a host the pin never vetted.

3. **Choose what to send.** Step 3 has the enable switch and the per-event
   switches. *Include assistant output* is off by default.

4. **Send a test.** Step 4 posts a test message so you can confirm it reaches the
   channel you expect before relying on it.

## Where credentials are stored

Outside `clawd-prefs.json`, in `slack-notify.env` in Clawd's user-data
directory, written atomically (temp file + rename).

On macOS and Linux the file is `0600` — owner read/write only. **Windows has no
POSIX permission bits**, so the mode is not applied there; the file relies on the
ACL of your user's AppData directory, which by default is not readable by other
standard users but is readable by administrators.

After saving, the field collapses to a masked preview. The raw value never
crosses the IPC boundary back to the UI.

### Removing a credential, and switching transports

Each saved credential shows a masked preview with a **Remove** button beside it.
Removing one leaves the other in place, so this is also how you switch: a valid
webhook always outranks a bot token, so removing the webhook hands sending over
to the token. The card names the transport currently in use, so you can see
which one is live rather than inferring it.

Invalid values are rejected before they are written, so a malformed webhook can
never be stored — which also means it can never mask a working bot token.

**Removing a credential here is not revocation.** The credential still works for anyone
else who has it. To actually revoke:

- **Webhook** — api.slack.com/apps → your app → **Incoming Webhooks** → remove
  the webhook. The URL stops working immediately.
- **Bot token** — **OAuth & Permissions** → **Revoke All OAuth Tokens**, or
  uninstall the app from the workspace.

Revoke first, then clear locally. A revoked credential returns a permanent
failure, which Clawd logs and does not retry.

## Delivery behaviour

Sends are queued and delivered one at a time, so a burst of finished sessions
does not open several sockets at once.

- A rate-limited (429) send honours Slack's `Retry-After`; network, timeout and
  5xx failures retry with capped exponential backoff.
- Permanent failures — a revoked webhook (404) or a rejected token (401/403) —
  are not retried.
- Both the queue length and the retry count are bounded. If Slack is unreachable
  long enough for the queue to fill, the oldest notification is dropped and the
  drop is logged.
- Nothing here blocks the desktop pet; a failed notification never propagates
  into the event path.

Messages are not retractable. Once posted, a permission card stays in the
channel even after you answer in the app.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid-secret` in Settings | the URL is not on `hooks.slack.com`, or the token is not `xoxb-` |
| `missing-secret` | nothing saved yet, or the env file was cleared |
| Test works, notifications never arrive | the master switch or the per-event switch is off (Send Test only needs a valid credential, so it works during setup) |
| Permission cards never arrive | permission automation is resolving them, or DND is on (both are intended — see above) |
| Nothing arrives after a restart | previously a bug where the first completion after startup recovery was swallowed; fixed by priming the notifier with the recovered snapshot |
| `not-found` (404) | the webhook was deleted, or the bot is not in the channel |
| `unauthorized` (401/403) | the token was revoked, or is missing `chat:write` |
| `channel_not_found` | wrong channel id, or the bot has not joined a private channel |
| Messages stop during a busy burst | rate limited; they are retried, and drops are logged |

Failures are logged with the webhook and token redacted, so the log is safe to
paste into an issue.

## Limitations

- **No approvals from Slack.** Interactive buttons need Socket Mode or a public
  request URL. Until then Slack announces and Clawd decides.
- **One channel per webhook.** Bound at creation. To post elsewhere, create a new
  webhook and replace the saved URL.
