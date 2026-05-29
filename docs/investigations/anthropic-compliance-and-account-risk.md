# Clawd Telegram Remote Approval — Anthropic Compliance & Account Risk Analysis

Status: Public research note
Last updated: 2026-05-28
Maintainer: [@rullerzhou-afk](https://github.com/rullerzhou-afk)

## TL;DR

Clawd's Telegram remote approval feature operates entirely within Anthropic's
officially documented extension surface for Claude Code. It:

- does **not** call the Anthropic API
- does **not** spawn the `claude` binary
- does **not** read, store, or route Anthropic OAuth tokens / API keys
- does **not** consume Pro / Max subscription quota
- does **not** use the Agent SDK or `claude -p`

The functional category Clawd participates in — *remote permission relay via
messaging platforms* — is itself officially supported by Anthropic's own
**Channels** feature (research preview, ships in Claude Code v2.1.80+ with
official Telegram / Discord / iMessage plugins).

This document collects the policy references and architectural facts behind
that statement so users, contributors, and reviewers can verify independently.

## How Clawd connects to Claude Code

```
User runs `claude` in terminal → interacts with Claude Code
   ↓
Claude Code decides to invoke a tool (Edit / Bash / etc.)
   ↓
Claude Code fires the PreToolUse hook
   (a shell command the user configures in ~/.claude/settings.json)
   ↓
The hook script (hooks/clawd-hook.js) is executed
   ↓
The hook POSTs to Clawd Electron main process over localhost HTTP
   ↓
Clawd main process:
   - Renders a desktop permission bubble (local approval path)
   - Forwards the permission request to Telegram (remote approval path)
   ↓
The user decides — locally or remotely — Allow / Deny
   ↓
Clawd echoes the decision back to the hook
   ↓
The hook returns the decision to Claude Code via stdout + exit code
   ↓
Claude Code proceeds or aborts the tool invocation
```

Clawd's role in this chain is a **human-in-the-loop reviewer**. The decision
returned to Claude Code is always made by the human operator, in real time, on
a device the operator controls. Clawd does not synthesize approvals, does not
batch-approve unattended, and does not impersonate the user to Anthropic's
infrastructure.

## What Anthropic explicitly permits

### Hook system (officially documented extension point)

Source: [Hooks Guide — Claude Code documentation](https://code.claude.com/docs/en/hooks-guide) (accessed 2026-05-28)

> "Hooks are user-defined shell commands that execute at specific points in
> Claude Code's lifecycle. They provide deterministic control over Claude
> Code's behavior... Use hooks to enforce project rules, automate repetitive
> tasks, and **integrate Claude Code with your existing tools**."

PreToolUse hooks can allow or deny tool requests; this is the mechanism Clawd
relies on. The hooks system is a first-class, documented integration surface
exposed by Anthropic for exactly this kind of extension.

### Remote permission relay (officially shipped by Anthropic)

Source: [Channels — Claude Code documentation](https://code.claude.com/docs/en/channels) (accessed 2026-05-28)

> "If Claude hits a permission prompt while you're away from the terminal, the
> session pauses until you respond. **Channel servers that declare the
> permission relay capability can forward these prompts to you so you can
> approve or deny remotely**."

Anthropic ships official Channel plugins for **Telegram, Discord, and iMessage**
under [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official).
The product category Clawd's Telegram approval participates in is therefore
built and endorsed by Anthropic itself.

## What Anthropic prohibits (and why Clawd does not trip these lines)

Source: [Legal and Compliance — Claude Code documentation](https://code.claude.com/docs/en/legal-and-compliance) (accessed 2026-05-28)
+ [Anthropic Acceptable Use Policy](https://www.anthropic.com/legal/aup)
+ [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)

| Anthropic prohibition | Does Clawd trigger it? |
|---|---|
| *"Anthropic does not permit third-party developers to offer Claude.ai login"* | No — Clawd never touches OAuth or any login flow |
| *"...or to route requests through Free, Pro, or Max plan credentials on behalf of their users"* | No — Clawd holds no credentials, makes no requests to Anthropic |
| Effective **2026-06-15**: *"Agent SDK and `claude -p` usage on subscription plans will draw from a new monthly Agent SDK credit, separate from your interactive usage limits"* | Not applicable — Clawd uses neither the Agent SDK nor `claude -p` |
| AUP rules on automated / non-human access to Claude services | No — every Clawd-mediated approval is a real human tapping a real button in real time |
| AUP rules on prompt routing / output redistribution at scale | No — Clawd does not generate, modify, or redistribute prompts or outputs; the only payload it forwards is tool-use metadata for the operator to inspect |

### Public enforcement context

Anthropic's publicly reported enforcement actions in 2026 (see references)
targeted third-party agentic frameworks — typified by OpenClaw — that consume
Pro / Max subscription quota to drive non-interactive agent harnesses. The
sequence of events:

- **2026-04-04** Anthropic restricted subscription credentials from powering third-party agent harnesses ([VentureBeat](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and))
- **2026-05** Anthropic reinstated some third-party access via a new "Agent SDK credit" tier ([VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch))
- **2026** Anthropic shipped first-party Channels ([VentureBeat](https://venturebeat.com/orchestration/anthropic-just-shipped-an-openclaw-killer-called-claude-code-channels))

Clawd is architecturally different from the tools in the affected category:
it does not consume subscription quota, does not run unattended on a user's
credentials, and does not present itself as a Claude harness to Anthropic's
backend. It is a desktop GUI shell + human-approval UX layer over the
officially supported hook surface.

## What you (as a Clawd user) should know

Even though Anthropic compliance is not the concern, Clawd's remote approval
involves your own data choices and bot security. The following are
recommendations, not regulatory requirements:

- **Privacy**: Telegram messages from Clawd contain tool-use metadata — tool
  name, command preview, file paths, edit snippets. Clawd defaults to a strict
  truncation tier in Settings. Adjust the privacy tier if you need richer or
  poorer detail in your Telegram notifications.
- **Bot ownership**: Connect Clawd only to a Telegram bot **you control**
  (created via your own BotFather session) and a chat where **you control the
  sender allowlist**. Do not share approval rights with people you would not
  trust to run those tools on your machine.
- **Always Allow**: Clawd's "Always Allow" matches Claude Code's permission
  semantics. Use fine-grained rules rather than blanket approvals.
- **Official alternative**: Anthropic's [Channels](https://code.claude.com/docs/en/channels)
  feature offers a similar remote approval workflow via
  `/plugin install telegram@claude-plugins-official`. This document does not
  recommend Clawd over the official path or vice versa — they are
  architecturally similar and the choice is a matter of UX preference.

## Verification

The claims in this document can be verified independently:

1. **Read the cited Anthropic pages.** All URLs and access dates are given.
2. **Read Clawd's source.** Relevant files:
   - `hooks/clawd-hook.js` — the hook script invoked by Claude Code
   - `src/permission.js` — local permission decision routing
   - `src/telegram-approval-*.js` — Telegram transport (v0.8.x sidecar path)
   - `src/main.js` — Electron main process
3. **Grep for API endpoints.** Run `grep -r "anthropic.com" src/ hooks/` in
   the Clawd source tree. There are no API calls to Anthropic.
4. **Inspect outbound network traffic.** Clawd makes outbound network calls
   only to Telegram Bot API (api.telegram.org) and GitHub (for update checks).
   It does not make outbound calls to anthropic.com from the main process.

## References

### Anthropic documentation
- [Hooks Guide — Claude Code](https://code.claude.com/docs/en/hooks-guide)
- [Channels — Claude Code](https://code.claude.com/docs/en/channels)
- [Legal and Compliance — Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
- [Anthropic Acceptable Use Policy](https://www.anthropic.com/legal/aup)
- [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) — official Channel plugins for Telegram / Discord / iMessage

### Public enforcement reporting
- VentureBeat — [Anthropic cuts off subscription use for OpenClaw and third-party agents](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and)
- VentureBeat — [Anthropic reinstates OpenClaw and third-party agent usage with conditions](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch)
- VentureBeat — [Anthropic ships Claude Code Channels](https://venturebeat.com/orchestration/anthropic-just-shipped-an-openclaw-killer-called-claude-code-channels)

## Notes

- This document represents the maintainer's good-faith reading of Anthropic
  policy as of the date above. It is not legal advice. Policy and product
  documentation may change; check the cited URLs for current text.
- This analysis was developed with assistance from Claude (for cross-checking
  Clawd source against the cited documents) and GPT-5.5-Pro (for independent
  legal/compliance review). All quoted policy text was fetched directly from
  Anthropic's documentation on the access date noted above and is not
  paraphrased.
- Found something inaccurate? Please open an issue on the Clawd repository.
