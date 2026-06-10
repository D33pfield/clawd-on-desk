# 变更日志

## 2026-06-10 修复 Ghostty 跨桌面跳转把窗口拉到当前桌面
- 点击会话列表跳转时，若目标终端位于另一桌面某窗口的「未选中标签页」，原先会把整个窗口拉到当前桌面，而非把用户切换过去
- 根因：Ghostty AppleScript `focus` 用 `makeKeyAndOrderFront`，对屏外（未选中标签）的 NSWindow 上屏会将其吸附到当前 Space；`select tab` 同理
- 修法（踏板法）：先用只读 probe 判断目标标签是否选中——已选中则直接 focus；未选中则先 focus 该窗口当前选中标签的终端（唯一验证可靠切换 Space 的操作），待切换完成再 focus 目标，标签切换发生在已激活的 Space 内，不再拉窗
- `src/focus.js` 新增 `buildGhosttyIdProbeScript` / `buildGhosttyCwdProbeScript` 与 `runWithSteppingStone` 编排；`focus` 脚本还原为原版扁平查询
- 新增 `test/focus-ghostty-space.test.js`；Ghostty 1.3.1 / macOS 26 真机验证通过
