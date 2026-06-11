# CodeWhale 集成 Phase 1 — Review 修复记录

> 状态：已修复并验证
> 范围：CodeWhale state-only hooks 适配、Settings / Doctor / cleanup 接入、测试与文档收敛

---

## Review 输入问题

本次修复覆盖以下 review 反馈：

1. `hooks/codewhale-install.js` 不是幂等的。`# managed by clawd-on-desk` marker 被写在 `[[hooks.hooks]]` 前一行，但 `parseTomlSections()` 在遇到 `[[hooks.hooks]]` 时才开始新 section，所以 marker 会落到前一个 section 里。重复运行注册会不断残留旧 hook 并追加新 hook；本地复现里 hook block 数从 `7 -> 8 -> 9 -> 10` 增长。更严重的是，安装后再卸载也只删掉 `6/7` 个 managed hook，会留下一个孤儿 hook。这需要先修掉，避免污染用户的 `~/.codewhale/config.toml`。
2. hook command 里的 Node 路径没有加引号：`const command = ${nodePath} "${hookPath}" ${event};`。手动运行 installer 时，常见的 Windows 路径比如 `C:\Program Files\nodejs\node.exe` 会被空格拆坏。应复用现有 helper，比如 `formatNodeHookCommand`，不要单独手写 quoting 逻辑。
3. 当前 PR 会让现有测试失败：
   - `test/registry.test.js` 的 supported agent list 没更新。
   - `test/state-agent-icons.test.js` 发现 `assets/icons/agents/codewhale.png` 是 `32x32`，但 runtime agent PNG 要求 `64x64`。
   - `test/package-build-config.test.js` 因为 `npm start` 不再跑 sidecar preflight 而失败。
   - `package.json` 删除 `node scripts/ensure-sidecar-binaries.js &&` 和 CodeWhale 集成本身无关，而且会回退源码启动时 Telegram sidecar 二进制预检查 / 预拉取保障。应在这个 PR 里回退这处改动，除非单独解释并配套调整相关测试。
4. CodeWhale 的 Settings / Doctor / cleanup 接入不完整。它被加入了一些 settings surface，但没有进入 `src/doctor-detectors/agent-descriptors.js` / integration checks，也没有进入 managed integration cleanup 列表。这样用户可能会被写入 CodeWhale hooks，但 Doctor 看不到、cleanup 也清不掉。
5. `src/prefs.js` 和 `agents/registry.js` 里有一些和本 PR 无关的注释编码污染，需要恢复，保持 diff 聚焦在 CodeWhale 集成本身。

---

## 已完成修复

### 1. Installer 幂等性和孤儿 hook 清理

`buildHookEntry()` 现在把 managed marker 放在 `[[hooks.hooks]]` section 内：

```toml
[[hooks.hooks]]
# managed by clawd-on-desk
event = "session_start"
command = '''node "/path/to/codewhale-hook.js" session_start'''
background = true
timeout_secs = 5
```

`parseTomlSections()` 同时兼容旧格式：如果 marker 仍在 `[[hooks.hooks]]` 前一行，会把它归并到即将开始的 hook section。这样旧配置会在下一次注册时被收敛，而不是继续追加。

额外修复了 marker 已丢失的历史孤儿 hook：只要 `[[hooks.hooks]]` section 的 `command` 指向 `codewhale-hook.js`，就按 legacy managed hook 处理。注册会先删除这些旧 block，再写入 7 个 canonical hooks；卸载也会把这些 markerless orphan 一并清掉。

实测临时副本中，历史污染配置可以从 15 个 Clawd hook 引用收敛到 7 个；第二次注册保持 7 个且不写文件；卸载后变为 0 个。真实 `~/.codewhale/config.toml` 未被本次验证写入。

### 2. TOML section 边界修复

旧 parser 在进入 `[[hooks.hooks]]` 后，遇到其他 TOML array table 也可能继续归到当前 hook section。现在遇到任意非 hooks 的 TOML header 会结束当前 hooks section，避免 unregister 误删无关配置。

新增测试覆盖：

- marker-before-header legacy block 的幂等升级；
- markerless `codewhale-hook.js` orphan 清理；
- 不吞掉无关 `[[other.array]]`；
- repeated register 的 `added: 0` / `removed: 0` / `updated: false` 语义。

### 3. `[hooks].enabled` 修复

如果用户已有：

```toml
[hooks]
enabled = false
```

注册时现在会替换为 `enabled = true`，而不是追加第二个 `enabled` key。带行尾注释的 enabled 行也统一由 `ensureHooksEnabled()` 处理，避免重复判断逻辑分叉。

### 4. Windows Node 路径 quoting

hook command 不再手写拼接，而是复用 `formatNodeHookCommand()`：

```js
const command = formatNodeHookCommand(nodePath, hookPath, {
  platform: options.platform || process.platform,
  windowsWrapper: "none",
  args: [event],
});
```

这样 Windows 常见路径如 `C:\Program Files\nodejs\node.exe` 会被正确引用，不会被 shell 按空格拆坏。

### 5. CodeWhale config path 兼容

本机 `codewhale config path` 验证显示 CodeWhale 会尊重：

- `CODEWHALE_CONFIG_PATH`
- `DEEPSEEK_CONFIG_PATH`
- 默认 `$HOME/.codewhale/config.toml`

installer 和 Doctor descriptor 现在共用 `resolveCodewhaleConfigPath()`，并尊重这些环境变量。显式 config path 存在时，即使默认 `~/.codewhale` 不存在也会创建父目录并写入，符合 CodeWhale CLI 行为。

### 6. Hook runtime 可测性

`hooks/codewhale-hook.js` 现在只在 `require.main === module` 时执行 CLI 主流程，并导出测试入口。新增测试覆盖：

- env vars 到 Clawd payload 的映射；
- CodeWhale 缺少 session id 时复用缓存；
- `tool_call_after` 失败映射到 `PostToolUseFailure`；
- passive events 使用短 timeout；
- `session_end` 等待更长 timeout 并清理 session cache；
- 未知事件静默退出且返回 0。

### 7. Settings / Doctor / cleanup 补齐

CodeWhale 已接入：

- `src/doctor-detectors/agent-descriptors.js`
- `src/doctor-detectors/agent-integrations.js`
- `hooks/cleanup-integrations.js`
- `src/integration-sync.js` startup sync 测试覆盖
- Settings agent order / prefs 默认值测试

Doctor 使用专门的 `codewhale-hooks-toml` 检查模式，校验 7 个 required hook events、script path、broken command，并能识别 `[hooks].enabled = false`。cleanup 会调用 `unregisterCodewhaleHooks()`，可清理 canonical hooks 和 legacy orphan hooks。

### 8. 现有测试失败项修复

- `test/registry.test.js` 已更新 supported agent list，并覆盖 CodeWhale lookup / capabilities / eventMap。
- `assets/icons/agents/codewhale.png` 已更新为 `64x64` runtime PNG。
- `package.json` 已恢复：

```json
"start": "node scripts/ensure-sidecar-binaries.js && node launch.js"
```

这保留源码启动时 Telegram sidecar 的预检查 / 预拉取保障，避免把无关行为回退混进 CodeWhale 集成。

### 9. Diff 噪声清理

`src/prefs.js` 和 `agents/registry.js` 中与本 PR 无关的注释编码污染已恢复，保留的改动仅限 CodeWhale 集成本身需要的 agent 注册、默认 prefs、测试覆盖。

---

## 是否需要启动 CodeWhale 验证

不需要启动真实交互式 CodeWhale 会话作为本 PR 的阻塞项。原因：

- 真实 TUI 会话可能触发 API 调用，不适合做无副作用验证。
- installer 行为已经用临时 config path 和真实本机配置副本验证，不写入用户真实 `~/.codewhale/config.toml`。
- 本机已运行非交互 CLI 验证：
  - `codewhale --version`：确认本机 wrapper / binary 可用；
  - `codewhale config path`：确认默认路径和环境变量覆盖；
  - 临时 `HOME` 下 `codewhale doctor`：确认不会依赖真实用户配置；
  - 包内字符串检索：确认 CodeWhale v0.8.47 使用的 hook event / env 命名与当前集成一致。

如果后续要做端到端演示，可以在 Clawd 已运行后手动启动 `codewhale`，但这属于人工 smoke test，不应替代 installer / Doctor / cleanup 的可重复自动测试。

---

## 验证结果

聚焦套件通过：

```bash
node --test \
  test/codewhale-install.test.js \
  test/codewhale-hook.test.js \
  test/doctor-agent-descriptors.test.js \
  test/doctor-agent-integrations.test.js \
  test/cleanup-integrations.test.js \
  test/registry.test.js \
  test/state-agent-icons.test.js \
  test/package-build-config.test.js \
  test/integration-sync.test.js \
  test/prefs.test.js \
  test/settings-agent-order.test.js \
  test/settings-actions-agents.test.js
```

结果：`231 pass, 0 fail`。

完整 `npm test` 仍存在非 CodeWhale 失败：

- `test/install.test.js`：Claude package.json fallback / version detection 相关。
- `test/kiro-install.test.js`：Windows `LOCALAPPDATA` Kiro 默认路径相关。

这些失败与 CodeWhale 修改面没有交叉，已单独记录为残留风险，不在本 PR 中扩大修复范围。

---

## 改动文件清单

| 文件 | 说明 |
|---|---|
| `hooks/codewhale-install.js` | 幂等注册、legacy orphan cleanup、TOML 边界、enabled 替换、shared command formatter、config path resolver |
| `hooks/codewhale-hook.js` | 可测试入口、payload/session cache/timeout 行为测试化 |
| `src/doctor-detectors/agent-descriptors.js` | CodeWhale descriptor + env-aware config path |
| `src/doctor-detectors/agent-integrations.js` | `codewhale-hooks-toml` integration check |
| `hooks/cleanup-integrations.js` | managed cleanup 接入 CodeWhale |
| `src/prefs.js` | CodeWhale prefs 默认值并清理无关注释噪声 |
| `agents/registry.js` | CodeWhale agent 注册并清理无关注释噪声 |
| `assets/icons/agents/codewhale.png` | runtime icon 更新为 64x64 |
| `package.json` | 恢复 `npm start` sidecar preflight |
| `test/codewhale-install.test.js` | installer 幂等 / legacy / quoting / config path 覆盖 |
| `test/codewhale-hook.test.js` | runtime hook payload / cache / timeout 覆盖 |
| `test/*doctor*`, `test/*cleanup*`, `test/*prefs*`, `test/*registry*`, `test/*settings*` | 补齐 Settings / Doctor / cleanup / registry 覆盖 |
