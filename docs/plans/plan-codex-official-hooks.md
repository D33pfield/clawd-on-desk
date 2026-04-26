# Plan: Codex CLI 官方 Hooks 适配

> 状态：Draft v3.1，已按官方 docs + generated schemas + codex-rs/hooks 源码复核 Claude review
> 日期：2026-04-26
> 目标分支建议：`feat/codex-official-hooks`
> 官方依据：
> - OpenAI Codex Hooks 文档：https://developers.openai.com/codex/hooks
> - OpenAI Codex generated hook schemas：https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated
> - Codex PR #19012：https://github.com/openai/codex/pull/19012

v3 修订重点：保留 Claude review 中确认成立的风险项；撤回两条过度修正：`permission_mode` 在 generated schemas 里存在，`SessionStart.source=clear` 在 matcher 表和 schema 里存在。后续实现以 generated schemas 作为完整 wire format，docs prose 作为行为说明。

v3.1 修订重点：补上 PermissionRequest sanitizer 的 **omit key** 约束、`stop_hook_active=true` 的 v1 no-op 行为、hook timeout 的源码核查路径，以及 `{}`/空 stdout 的 schema/runtime 边界。

---

## 1. 背景

当前 Clawd 的 Codex CLI 集成仍以 JSONL 轮询为主：

```text
Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  -> agents/codex-log-monitor.js polls every ~1.5s
  -> main.js callback
  -> updateSession(...)
  -> renderer animation / passive Codex permission notification
```

这条链路能工作，但有三个结构性问题：

1. **延迟**：轮询天然有约 1.5s 延迟。
2. **权限只能通知**：目前 `codex-permission` 是被动 "Got it" 气泡，不能真正 Allow/Deny。
3. **事件语义靠日志猜**：权限等待、turn end、tool use 都依赖 rollout JSONL 的非正式字段和启发式。

OpenAI 现在公开了 Codex lifecycle hooks，可以把 Codex 从 "log-poll agent" 升级成 "hook primary + log-poll fallback"。

注意：官方 docs 当前仍写着 hooks behind feature flag。PR/release 语言不能替代实测结论；Phase 0 必须验证未设置 `[features].codex_hooks = true` 时 `hooks.json` 是否生效。

---

## 2. 官方 Hook 能力摘要

截至 2026-04-26，官方可用事件：

| Hook | 触发点 | 对 Clawd 的价值 |
|---|---|---|
| `SessionStart` | session 启动 / resume / clear | 注册 live session，拿 `session_id/cwd/model` |
| `UserPromptSubmit` | 用户 prompt 发送前 | 立即切 `thinking`，消除轮询延迟 |
| `PreToolUse` | 支持的 tool 调用前 | 切 `working`，记录 `tool_name/tool_input/tool_use_id` |
| `PermissionRequest` | Codex 准备请求 approval | 通过 Clawd bubble 做真正 Allow/Deny |
| `PostToolUse` | 支持的 tool 调用后 | 保持/刷新 `working`，清理权限等待 |
| `Stop` | 本轮 assistant 停止 | 按本 turn 是否用过 tool 切 `attention` 或 `idle` |

官方文档的 common fields 表列出：

```text
session_id, transcript_path, cwd, hook_event_name, model
```

但官方 generated schemas 里还要求 `permission_mode`，枚举值包括 `default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions`。结论：实现上可以读取/透传 `permission_mode` 用于 debug 或未来 UI，但 Clawd 状态机不依赖它；Phase 0 仍要用真实 Codex 验证它是否稳定出现。

turn-scoped hooks 还包含：

```text
turn_id
```

tool hooks 还包含：

```text
tool_name, tool_input, tool_use_id
```

`PermissionRequest` 当前没有 `tool_use_id`，但有 `tool_name/tool_input/turn_id`。官方 docs 还明确 `tool_input.description` 可包含 Codex 生成的人类可读 approval reason；Clawd bubble 应优先用它作为展示文案，原始 `tool_input` 留作 fallback/detail。

`Stop` 还包含：

```text
stop_hook_active, last_assistant_message
```

Clawd 不计划 block/continue `Stop`，但仍要读取 `stop_hook_active` 做防御，避免未来误把续跑 Stop 当普通 Stop 造成循环。

`SessionStart.source` 在 docs 里有内部不一致：matcher 表写当前值是 `startup`、`resume`、`clear`，generated schema 也包含三者；但 `SessionStart` 小节正文只写 `startup` / `resume`。因此 installer 仍省略 matcher，让全部 source 触发，并把 source 取值集合列入 Phase 0 实测。

官方限制必须进入设计：

- `PreToolUse` / `PostToolUse` 目前不拦所有 shell 路径，只覆盖简单 Bash、`apply_patch`、MCP tools；不覆盖 `WebSearch` 等非 shell、非 MCP tool。
- `PermissionRequest` 只在需要 approval 时触发，不是所有 tool 都触发。
- `PreToolUse.additionalContext`、`updatedInput`、`permissionDecision: "allow"/"ask"` 解析但未支持。
- `PermissionRequest.updatedInput`、`updatedPermissions`、`interrupt` 是未来字段，今天会 fail closed；Clawd 对 Codex **绝对不得返回这些字段**。
- `suppressOutput` 解析但未实现，不能依赖它消除 hook UI 噪声。
- 多个匹配 hook 会并发启动；`PermissionRequest` 多 hook 决策中任意 deny 会赢。
- `UserPromptSubmit` / `Stop` matcher 不生效；不要配置 matcher。
- `PreToolUse` / `PostToolUse` matcher 支持 `Bash`、`apply_patch`、MCP tool name。官方文档明确 `"*"`、`""`、省略 matcher 都可匹配全部；installer 仍省略 matcher，减少配置噪声。

---

## 3. 目标

1. **Codex 状态感知改为官方 hook primary**：启动、prompt、tool、stop 都走 hook 即时上报。
2. **Codex 权限气泡升级为真正 approval**：`PermissionRequest` hook 等待 Clawd `/permission`，用户 Allow/Deny 后把官方输出写回 Codex。
3. **保留 JSONL fallback**：旧版 Codex、hooks 未启用、Windows/WSL 行为漂移、用户配置损坏时仍能退回轮询。
4. **自动同步 hook 配置**：跟 Gemini/Cursor/Kimi/opencode 一样，Clawd 启动后异步补齐 Codex hooks。
5. **不破坏用户 Codex 配置**：append-only、idempotent，只更新 Clawd-owned hook command。

非目标：

- 不在 v1 支持 project-local `.codex/` hooks；只装用户级 `~/.codex/`。
- 不实现 Codex `additionalContext` 注入功能；Clawd 只做状态和权限。
- 不移除 JSONL monitor；至少保留一个 release 周期。
- 不支持 Codex `updatedPermissions` / suggestion 写回；官方当前不支持。
- 不强行打开用户主动设置的 `codex_hooks = false`；这种情况只记录 warning。

---

## 4. 总体方案

```text
Codex official command hook
  -> hooks/codex-hook.js
    -> non-permission events:
         POST /state { agent_id:"codex", state, session_id, event, ... }
    -> PermissionRequest:
         POST /permission { agent_id:"codex", tool_name, tool_input, session_id, ... }
         wait for Clawd bubble result
         stdout Codex-compatible sanitized JSON decision
  -> Codex continues
```

同时保留：

```text
agents/codex-log-monitor.js
  -> fallback only
  -> main.js wrapper suppresses only log events already covered by hooks
```

### 4.1 新增 `hooks/codex-hook.js`

职责：

- 只依赖 Node 内置模块，以及同目录现有 helper：`server-config.js`、`shared-process.js`。不要引入 npm deps。
- 从 stdin 读取 Codex hook JSON。
- 统一 session id：`codex:${payload.session_id || "default"}`。
- 读取 `permission_mode`（若存在）并放入 debug/meta，不让状态映射依赖该字段。
- 用 `createPidResolver()` 获取 `source_pid/agent_pid/pid_chain/editor`，遵守现有约束：稳定终端 PID 必须走进程树解析，不用 `process.ppid` 简化。
- 对普通事件 POST `/state`。
- 对 `PermissionRequest` POST `/permission` 并等待结果。
- 对 `Stop` stdout 保持空（exit 0）或只输出合法 Stop JSON，避免 Codex 把 plain text 当非法输出。
- 读取 `Stop.stop_hook_active`。Clawd 不返回 block/continue；如果该字段为 true，v1 直接 no-op：不 POST `/state`，不更新 turnMap，立即 exit 0。turnMap 泄漏风险用 TTL/后续正常 Stop 清理兜底。

事件映射：

| Codex hook | Clawd state | Clawd event |
|---|---|---|
| `SessionStart` | `idle` | `SessionStart` |
| `UserPromptSubmit` | `thinking` | `UserPromptSubmit` |
| `PreToolUse` | `working` | `PreToolUse` |
| `PostToolUse` | `working` | `PostToolUse` |
| `Stop` | 由 main-side `turn_id` 追踪决定 `attention/idle` | `Stop` |

`PermissionRequest` 不走 `/state` 直接状态映射；它走 `/permission`，由 server/permission bubble 触发 permission UI。

### 4.2 新增 `hooks/codex-install.js`

职责：

- 安装用户级 `~/.codex/hooks.json`。
- 确保 `~/.codex/config.toml` 里有 `[features].codex_hooks = true`，但不覆盖用户主动设置的 false。
- append-only 合并，不覆盖用户已有 hooks。
- 识别 Clawd-owned hook command（marker: `codex-hook.js`），更新 stale path / node path。

前置要求：先把 Cursor/Kiro/其他 installer 里重复的 Windows hook command formatter 合并到 `hooks/json-utils.js`，Codex installer 必须复用共享 formatter，不能再新增一份 quoting 逻辑。

建议写入 `~/.codex/hooks.json`，而不是直接维护 inline TOML hooks，原因：

- JSON 可安全 parse/merge/write，测试成本低。
- TOML 无现成依赖，字符串改写风险高。
- 官方明确支持 `hooks.json`。

已知代价：

- 如果用户同一层 `~/.codex/config.toml` 已有 inline `[hooks]`，Codex 会 merge 并在启动时 warning。v2 仍建议接受这个 warning；二审可决定是否为了避免 warning 改成 TOML string surgery。

`config.toml` 处理规则：

| 现有状态 | 行为 |
|---|---|
| 没有 `[features]` | append `[features]` + `codex_hooks = true` |
| 有 `[features]` 但没有 `codex_hooks` | 在该 section 下追加 `codex_hooks = true` |
| `codex_hooks = true` | 不动 |
| `codex_hooks = false` | **不动**，返回 warning；这是用户主动关闭，不由 Clawd 强翻 |
| TOML 解析/改写不确定 | 不写入，返回 warning，避免破坏用户配置 |

建议 hook 配置（省略 matcher）：

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 30 }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 30 }]
    }],
    "PreToolUse": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 30 }]
    }],
    "PostToolUse": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 30 }]
    }],
    "PermissionRequest": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 600 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "\"node\" \".../codex-hook.js\"", "timeout": 30 }]
    }]
  }
}
```

### 4.3 `/permission` 复用与 Codex sanitizer

现有 `src/permission.js` 的 `sendPermissionResponse()` 形状接近 Codex `PermissionRequest` 输出，但不能直接复用所有路径：Claude Code 的 suggestion/elicitation 会产生 `updatedPermissions` 或 `updatedInput`，而 Codex 今天会 fail closed。

Codex path 必须有专门 sanitizer，只允许：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

或：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied by user."
    }
  }
}
```

必须约束：

- Codex path 不返回 `updatedInput`、`updatedPermissions`、`interrupt`。
- 这里的“不返回”必须是 **omit key**，不是设为 `null`。`updatedInput: null` / `updatedPermissions: null` 仍然是 field present，按官方语义存在 fail-closed 风险；sanitizer 应从 allowlist 构造新对象，只写 `behavior` 和可选 `message`。
- Codex path 强制 `suggestions=[]`、`isElicitation=false`，不能让 UI 出现 suggestion 或 elicitation 分支。
- Codex bubble 文案优先使用 `tool_input.description`；没有 description 再格式化原始 `tool_input`。
- DND 不替用户做 deny；fallback 到 Codex 原生提示。
- permissions sub-toggle off 时同样 fallback 到 Codex 原生提示。

可能需要新增 helper：

```text
hooks/server-config.js
  postPermissionToRunningServer(body, {
    connectTimeoutMs: 100,
    responseTimeoutMs: 590000
  }, callback)
```

`/state` 仍用 100ms 快速 fire-and-forget；`/permission` 需要长连接等待用户决策。Phase 0 必须验证 Codex 是否真的允许 600s hook timeout。

### 4.4 JSONL fallback 去重

不能简单同时开 hook 和 log monitor，否则会出现：

- 同一 session 双份状态更新。
- `PermissionRequest` 真权限气泡出现后，JSONL heuristic 又弹旧的 Codex passive notify。
- Dashboard 出现两个 Codex session，如果 official hook `session_id` 与 rollout filename uuid 不完全一致。

去重不放进 `agents/codex-log-monitor.js`。该文件已经承担轮询、backfill、approval heuristic、session title、PID 查找等职责，继续塞 suppression 会让复杂度失控。正确位置是 `main.js` 里的 Codex monitor callback wrapper：monitor 仍 emit 全量事件，wrapper 决定是否丢弃。

建议引入两个 main-side 记录：

```text
Map<sessionId, { lastHookAt, lastTurnId, source: "official-hook" }>
Map<turnId, { sessionId, hadToolUse }>
```

行为：

- `codex-hook.js` 发来的 `/state` 增加 `source: "codex-hook"` 或 `hook_source: "codex-official"`。
- main/server 在 updateSession 前记录该 session 为 hook-active，并按 `turn_id` 追踪 tool use。
- `CodexLogMonitor` callback 进入 main.js 后先查：
  - **按事件类型决定**是否丢弃，而不是 hook-active 就压住整个 session。
  - 已被 official hooks 覆盖的 log events 丢弃，例如 `event_msg:task_started`、`event_msg:user_message`、`response_item:function_call`、`event_msg:exec_command_end`、`event_msg:patch_apply_end`、`event_msg:task_complete`。
  - official hooks 不覆盖或覆盖不完整的 events 放行，例如 `response_item:web_search_call`、`event_msg:context_compacted`、`event_msg:turn_aborted`。
  - hook-active session 的 log-poll `codex-permission` 必须丢弃，避免 passive notify 与真 permission bubble 重叠。
  - 未见过 hook 的 session：继续按旧 fallback 逻辑处理。

Phase 0 必须验证 official `session_id` 是否等于 rollout filename uuid。如果不等，fallback suppression 不能只靠 session id，需要加 `transcript_path` 或 `cwd + recent time` 关联。

### 4.5 Stop 的 `attention` vs `idle`

现有 JSONL monitor 在 `task_complete` 时：

- 本 turn 用过工具：`attention`
- 没用工具：`idle`

官方 `Stop` hook 本身只给 `last_assistant_message` 和 `stop_hook_active`，不直接给 "本 turn 是否用过 tool"。v1 直接选 main-side 内存追踪：

```text
UserPromptSubmit(turn_id) -> initialize turnMap[turn_id]
PreToolUse(turn_id) -> turnMap[turn_id].hadToolUse = true
PostToolUse(turn_id) -> optional refresh only
Stop(turn_id) -> hadToolUse ? attention : idle; delete turnMap[turn_id]
```

这样避免 hook-side TTL 文件，也避免 `Stop` 一律 happy 的行为退化。`stop_hook_active` 为 true 时 v1 直接 no-op，不触发 state 更新、不更新 turnMap、不写 continuation 输出。这样避免 Codex 因其他 Stop hook block 后续跑时，Clawd 在续跑边界把状态抖到 `attention/idle`。

---

## 5. 具体改动清单

| 文件 | 改动 |
|---|---|
| `hooks/json-utils.js` | 新增共享 hook command formatter，Codex/Cursor/Kiro 等 installer 复用 |
| `hooks/codex-hook.js` | 新增官方 Codex command hook 入口 |
| `hooks/codex-install.js` | 新增 `~/.codex/hooks.json` + `config.toml` feature flag installer |
| `hooks/server-config.js` | 新增长连接 `/permission` POST helper |
| `src/server.js` | 新增 `syncCodexHooks()`，启动后异步同步 |
| `src/main.js` | Codex monitor callback wrapper 做事件级 suppression；main-side per-turn tracking |
| `agents/codex.js` | `eventSource` 调整为 hook-primary；`permissionApproval` 改 true；保留 fallback log config |
| `src/permission.js` | 必加 Codex-specific sanitizer；Codex 禁用 suggestions/elicitation/updated* 字段 |
| `src/bubble.html` | 真 Codex permission 走普通 Allow/Deny UI或 Codex 标题+Allow/Deny；现有 `CodexExec` passive notify 仅 fallback 使用 |
| `package.json` | 新增 `install:codex-hooks` 调试脚本 |
| `test/codex-hook.test.js` | 新增 hook payload/state/output 单测 |
| `test/codex-install.test.js` | 新增 installer merge/idempotency/feature flag 单测 |
| `test/codex-log-monitor.test.js` | 保证 fallback 行为不退化 |
| `test/registry.test.js` / `test/agents.test.js` | 更新 Codex capability 期望 |
| `docs/project/agent-runtime-architecture.md` | 实施后更新 Codex 数据流 |
| `docs/guides/setup-guide.md` / `codex-wsl-clarification.md` | 实施后更新用户说明 |

---

## 6. 分阶段实施

### Phase 0: Spike 验证

目标：不要在未知 payload 上直接写正式实现。可以现在做，只装一个 debug hook 收 payload，不入主流程，零风险。

1. 在临时 `~/.codex/hooks.json` 写最小 debug hook，把 stdin JSON 追加到 `~/.clawd/codex-hook-debug.jsonl`。
2. 在 Codex CLI 里跑：
   - 新会话
   - resume
   - clear
   - 普通 prompt
   - Bash/tool 调用
   - apply_patch
   - 触发 approval 的 shell escalation
   - Stop
3. 验证字段：
   - `session_id` 是否稳定，是否和 rollout filename uuid 一致
   - `transcript_path` 是否可用
   - `cwd/model/turn_id/permission_mode` 是否始终存在
   - `SessionStart.source` 实际取值集合；docs 内部对 `clear` 有冲突，需实测确认
   - `PermissionRequest.tool_input` 对 Bash/apply_patch/MCP 的形状
   - `PermissionRequest.tool_input.description` 是否稳定可用于 bubble 展示
   - `Stop.stop_hook_active` 的实际行为
   - Windows native 与 WSL 是否一致
4. 验证 `PermissionRequest` stdout：
   - allow
   - deny + message
   - `{}` / 空 stdout 无决策时是否回到 Codex 原生 prompt，还是默认 deny
   - hook exit code 1 是否不阻断，还是如何影响 Codex
   - hook timeout 后 Codex 行为
   - 先 grep `codex-rs/hooks/src` 的 timeout / `Duration` / `timeout_sec`。当前 main 源码显示 discovery 默认 `timeout_sec = timeout_sec.unwrap_or(600).max(1)`，command runner 直接 `Duration::from_secs(handler.timeout_sec)`，未见 60s clamp；仍需用实际安装版本验证 600s timeout 是否生效
5. 验证 feature flag：
   - 仅写 `hooks.json`、不写 `codex_hooks = true` 时 hooks 是否生效
   - `codex_hooks = false` 时 Codex 行为和 warning

输出：把 payload 样本整理进 issue/PR 描述，不提交真实用户路径。

### Phase 1: 状态 hook 接入

实现：

- `hooks/codex-hook.js` 支持除 `PermissionRequest` 外的 5 个事件。
- `hooks/codex-install.js` 注册 hooks。
- `src/server.js` 启动后 `syncCodexHooks()`。
- `/state` body 接收 `hook_source/turn_id/tool_name/tool_input/tool_use_id` 中必要字段。
- main 层记录 hook-active session，在 callback wrapper 按事件类型压住已覆盖的 log-poll fallback。
- main 层维护 per-turn `hadToolUse`，Stop 决定 `attention/idle`。

验收：

- Codex prompt 后 Clawd 立即 `thinking`。
- Tool 调用立即 `working`。
- Stop 后回 `attention/idle`。
- 旧版/未触发 hook 时 JSONL monitor 仍工作。

### Phase 2: 真权限气泡

实现：

- `codex-hook.js` 对 `PermissionRequest` 调 `/permission` 并等待。
- `/permission` 对 `agent_id:"codex"` 使用 Codex-sanitized permission bubble。
- `sendPermissionResponse()` 或新 helper 对 Codex 输出只保留 `behavior/message`。
- Codex bubble payload 强制 `suggestions=[]`、`isElicitation=false`，展示优先用 `tool_input.description`。
- DND / disabled / permission toggle off / no server 全部 fallback 到 Codex 原生 prompt。
- 禁止 `deny-and-focus` 让 hook 悬挂；Codex 真权限卡片只显示 Allow / Deny。

验收：

- Allow 后 Codex 继续执行。
- Deny 后 Codex 收到 deny message。
- DND 不弹 Clawd bubble，Codex 自己提示。
- Settings 里关闭 Codex permissions，不弹 Clawd bubble，Codex 自己提示。
- app quit / bubble close 不让 Codex hook 卡死到 600s。

### Phase 3: Fallback 收敛与 UX

实现：

- Codex passive notify 只保留给 log-poll fallback。
- hook-active session 不再触发 `showCodexNotifyBubble()`。
- log-poll 中 hook 未覆盖的事件仍放行，例如 web search / compaction / abort。
- Settings agent badge 从 "Log poll" 更新为 "Hook"，Codex 显示 permission bubble 能力。
- Debug log 增加 `codex-hook` 来源，便于定位。

验收：

- Dashboard 不出现重复 Codex session。
- 同一个权限请求不会同时出现 Allow/Deny 气泡和旧的 Got it 气泡。
- 禁用 Codex agent 后，hook POST 被 server 快速 no-op，Codex 本身不受影响。

### Phase 4: 远程与文档

远程策略建议分两步：

1. v1 仍保留 `codex-remote-monitor.js` 文档和行为。
2. 后续给 `scripts/remote-deploy.sh` 增加 Codex official hooks remote install：
   - scp `codex-hook.js`
   - 远程注册 `~/.codex/hooks.json`
   - hook command 带 `CLAWD_REMOTE=1`
   - 通过 SSH 反向端口转发 POST 本地 Clawd

实施后更新：

- `docs/project/agent-runtime-architecture.md`
- `docs/guides/setup-guide.md`
- `docs/guides/codex-wsl-clarification.md`
- `AGENTS.md` Runtime Summary / Constraints

---

## 7. 测试计划

### 7.1 单元测试

`test/codex-hook.test.js`

- `SessionStart` -> `/state idle` body
- `UserPromptSubmit` -> `/state thinking`
- `PreToolUse` -> `/state working` with `tool_name/tool_input/tool_use_id/turn_id`
- `PostToolUse` -> `/state working`
- `Stop.stop_hook_active=false` 时状态符合 main-side turn tracking
- `Stop.stop_hook_active=true` 时 no-op：不调用 `/state`，不更新 turnMap，exit 0 且 stdout 空
- `PermissionRequest` allow response -> stdout canonical Codex JSON
- `PermissionRequest` deny response -> stdout canonical Codex JSON with message
- `PermissionRequest` response sanitizer omits `updatedInput/updatedPermissions/interrupt` keys entirely；断言 `Object.hasOwn(...) === false`，不要测它们等于 `null`
- Codex permission bubble payload strips suggestions and elicitation flags
- `PermissionRequest.tool_input.description` is preferred for display
- `/permission` connection failure -> no decision fallback
- DND-style socket destroy -> no decision fallback

`test/codex-install.test.js`

- fresh `~/.codex` 写入 `hooks.json`
- 保留用户已有 hooks
- stale command path 更新
- repeated register idempotent
- `config.toml` 无 `[features]` 时追加
- `config.toml` 已有 `[features]` 时只加/改 `codex_hooks = true`
- `codex_hooks = false` 时不改写，只 warning
- 用户已有 inline hooks 时不破坏，只记录/返回 warning 状态
- Windows command quoting
- installer uses shared hook command formatter from `hooks/json-utils.js`

`test/server-config.test.js` 或新增 helper test

- permission POST port discovery
- long timeout 与 connect timeout 分离
- 只接受 Clawd response header / body

现有测试更新：

- `test/registry.test.js`
- `test/agents.test.js`
- `test/agent-gate.test.js` 如 capability 影响 UI/order
- `test/codex-log-monitor.test.js` 保证 fallback 行为不退化
- main-level wrapper tests for event-level suppression if testable without Electron

### 7.2 手动测试

必须用真实 Codex CLI，不能只 curl：

1. Windows native Codex CLI：
   - prompt -> thinking
   - shell/tool -> working
   - permission request -> Clawd Allow/Deny 真生效
   - DND -> Codex 原生 prompt 接管
2. WSL Codex CLI：
   - 同上
   - 验证路径和 `transcript_path` 不污染 Windows session key
3. 多 session：
   - 两个 Codex terminal 同时跑
   - Dashboard session 不重复
   - permission bubble 堆叠正确
4. Settings：
   - Codex enabled off -> 无 Clawd 状态/气泡
   - Codex permissions off -> 状态仍可更新，但权限走 Codex 原生 prompt
5. Clawd 关闭/崩溃：
   - Codex hook 快速 fallback，不阻塞普通使用

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `session_id` 与 rollout uuid 不一致 | hook/log fallback 去重失败，Dashboard 重复 | Phase 0 必验；必要时用 `transcript_path` 关联 |
| hooks.json + inline TOML hooks 同层 warning | 用户启动 Codex 看到 warning | v2 接受；二审决定是否改 TOML inline merge |
| 用户设置 `codex_hooks = false` | Clawd 自动开启违背用户意图 | installer 不改写，只 warning |
| `/permission` 长连接被 hook timeout 杀掉 | Codex 卡住或 fallback 不顺 | 源码先验显示默认 600s 且未见 60s clamp，但 Phase 0 仍用实际 CLI 验证；hook timeout 600s 仅作为候选 |
| Codex PermissionRequest fail-closed | 用户点 suggestion/elicitation 后被反向 deny | Codex-specific sanitizer，只输出 behavior/message |
| 多 hook 并发时别的 hook deny | Clawd Allow 后 Codex 仍拒绝 | 文档说明：官方语义 deny wins，Clawd 不是唯一 arbiter |
| Pre/PostToolUse 覆盖不完整 | 部分 tool 不显示 working 细节 | UserPromptSubmit/Stop 仍覆盖 turn 粗状态；JSONL fallback 保留 |
| session-level suppression 太激进 | WebSearch/compaction/abort 消失 | main wrapper 做事件级 suppression，未覆盖事件放行 |
| DND/disabled 误 deny | 替用户做权限决定 | 连接失败/销毁统一输出 no decision，交回 Codex 原生 prompt |
| app quit 时 pending `/permission` | Codex hook 等到超时 | cleanup 需 resolve/destroy pending Codex perms，hook 捕获后 no decision |

---

## 9. 审核重点

请 Claude 重点审这几处：

1. **installer 选 `hooks.json` 是否接受**：如果同层 `config.toml` 已有 inline hooks，官方会 warning；是否值得为避免 warning 做 TOML string surgery？
2. **Codex sanitizer 边界**：是否把 sanitizer 放在 `permission.js`，还是 `codex-hook.js` stdout 前双保险？
3. **fallback 去重键与事件白名单**：只用 `session_id` 是否够，事件级 suppression 白名单是否完整？
4. **Stop per-turn tracking**：main-side Map 的 TTL/cleanup 放哪里最稳？
5. **DND / disabled fallback**：command hook 收到 socket destroy 后 stdout 空或 `{}` 是否是最稳的 no-decision 行为？schema 只说明 wire 合法，runtime 是否回原生 prompt 仍要 Phase 0 实测。
6. **权限 bubble UI**：Codex 真权限是否应复用普通 Allow/Deny UI，还是保留 Codex-specific title/pill 但按钮变 Allow/Deny？
7. **feature flag 行为**：`codex_hooks = false` 是否只 warning；如果 feature flag 默认已开，是否仍显式写 true？

---

## 10. 节奏建议

当前主线还有 v0.6.0 follow-up 和若干工作区杂项未清；Codex official hooks 也仍有 feature flag / timeout / fallback 行为未知数。

建议节奏：

1. Phase 0 spike 可以现在做，只装 debug hook 收 payload，不入主流程。
2. Phase 1-3 排到 0.7.0；0.6.x 先清 follow-up。
3. 官方 hook 默认开启之前，不把 JSONL fallback 移出主流程，至少观察一个 release 周期。

---

## 11. 推荐结论

方向强烈推荐做。只要 `PermissionRequest -> /permission -> sanitized stdout decision` 实测成立，Codex 就能从当前 "轮询 + 被动通知" 升级为 "官方 hook + 真权限审批"，用户感知会很明显。

但实施顺序必须保守：

1. Phase 0 spike 拿真实 payload。
2. Phase 1 状态 hook primary。
3. Phase 2 真权限气泡。
4. Phase 3 事件级去重和 UI 收敛。

---

## 12. v1 -> v2 修订记录

| Claude review 项 | v2 处置 |
|---|---|
| `permission_mode` 不应作为官方共同字段依赖 | v2 从 common docs 表删除；v3 复核 schema 后改为“schema 有，状态机不依赖，Phase 0 验稳定性” |
| `SessionStart` 不假设 `clear` source | v2 采纳；v3 复核 matcher 表 + schema 后确认 `clear` 存在，但 installer 仍省略 matcher 覆盖全部 |
| `PermissionRequest` unsupported fields fail closed | sanitizer 升级为必做；只允许 `behavior/message` |
| 漏 `tool_input.description` | Codex bubble 展示优先使用 description |
| 漏 `stop_hook_active` | Stop 读取并防御，不做 continuation |
| session-level suppression 太激进 | 改为 main callback wrapper 里的事件级 suppression |
| `codex_hooks` 仍是 feature flag | Phase 0 明确验证；installer 显式处理 config |
| `"*"` matcher 无文档保证 | v3 复核：官方 docs 明确支持 `"*"`；installer 仍省略 matcher |
| Windows command formatter 重复 | Codex installer 前置合并共享 formatter |
| suppression 不进 monitor | 明确放 main.js wrapper |
| Stop 策略 | 直接选 main-side per-turn Map |
| `codex_hooks=false` | 不改写，只 warning |
| Phase 0 必验项不足 | 补 timeout 上限、`{}`、exit code、source、session_id 对齐等 |

## 13. v2 -> v3 复核修订记录

| 复核项 | 结论 |
|---|---|
| `permission_mode` | Claude 说“字段不存在”不准确。docs common table 没列，但 generated schemas 要求该字段。计划改为读取但不依赖。 |
| `SessionStart.source=clear` | Claude 说官方只有 startup/resume 不完整。docs 小节只写二者，但 matcher 表和 schema 都有 clear。计划仍省略 matcher。 |
| `"*"` matcher | Claude 说无文档证实不准确。docs 明确 `"*"` / `""` / omit 都 match all。计划仍省略 matcher。 |
| `PermissionRequest` fail-closed | Claude 正确。`updatedInput` / `updatedPermissions` / `interrupt` 必须从 Codex response 中剥离。 |
| `tool_input.description` | Claude 正确。应优先用于 Codex permission bubble 展示。 |
| `stop_hook_active` | Claude 正确。应读取并防御，虽然 Clawd 不 block Stop。 |
| WebSearch / compaction / abort fallback | Claude 正确。不能 session-level suppress 整个 log stream，必须事件级放行未覆盖事件。 |

## 14. v3 -> v3.1 复核修订记录

| 复核项 | 结论 |
|---|---|
| sanitizer omit vs null | 采纳。`updatedInput` / `updatedPermissions` 是 present 即 fail-closed 风险；Codex sanitizer 必须 allowlist 构造并 omit keys，测试断言 no own key。`interrupt` 也不写，避免未来误设 true。 |
| `stop_hook_active=true` | 采纳。v1 直接 no-op：不 POST `/state`，不更新 turnMap，exit 0，避免其他 Stop hook 触发续跑时 Clawd 状态抖动。 |
| timeout 源码 grep | 采纳并已初查。当前 `codex-rs/hooks/src/engine/discovery.rs` 默认 600s、`command_runner.rs` 直接按 `timeout_sec` 等待，未见 60s clamp；仍需 Phase 0 用实际安装版本验证。 |
| PermissionRequest `{}` | 采纳。schema 层 `{}` 是合法 no-decision 输出，但 runtime 是回原生 prompt 还是默认 deny 仍必须实测。 |
