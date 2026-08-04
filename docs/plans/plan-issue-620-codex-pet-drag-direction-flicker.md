# Issue #620 Codex Pet 拖动换向闪空帧修复计划

制定日期：2026-08-04

状态：**Draft v3 已落地到工作树并完成独立 code review 修订；自动化验证完成，Windows dev/packaged 真机门禁待执行**

实施记录（2026-08-04）：Change set A、B1、B2 及独立 code review 后的 M1/M2/L1 回归补口已完成；`npm test` 为 6874 tests / 6843 passed / 0 failed / 31 skipped，`npm run verify:electron` 通过。独立 reviewer 已在真 Chromium 对消毒后 V1/V2 wrapper 完成 200 次属性翻转、同一 Animation identity、`currentTime` 单调不归零和单 `<image>` 检查；该证据不等于 packaged Clawd 真机。尚未把合成的 servo trace 冒充真实录制：pre-A tracing、packaged `contentDocument`、60 FPS 录屏与混合 DPI/跨屏 trace 仍按本计划保留为人工合并门禁。

Issue：[#620 宠物动画显示问题](https://github.com/rullerzhou-afk/clawd-on-desk/issues/620)

代码基准：`main@cc7f9589123df091db58530d2c06696f143b70ae`（v0.14.0，2026-08-04）

报告环境：Clawd 0.13.0、Windows 11 23H2 22631.4890、Codex Pet Firefly / 菲比。

---

## 0. 一句话结论

#620 实际包含两个现象：

1. Codex Pet 在持续拖动中左右换向时偶发整只宠物消失约 1–2 帧——这是可复核的真实 bug，当前 `main` 仍保留同一根因链。
2. 开启「低功耗 idle」后，待机动画静置数秒暂停，拖动或开始新任务后恢复——这是当前设计，不是本次要修的 bug。

修复拆成两个可独立验证的 change set，严格按先输入、后渲染的顺序推进：

- **Change set A（先行）**：把换向判断从被拖动窗口内部的 `clientX` 改为稳定的 `screenX` 累计位移 + 小迟滞，先消除窗口跟随反馈回路制造的伪换向，并用一次 30 秒真实拖动的三路同轨计数与可回放 fixture 隔离坐标空间/deadband 贡献；
- **Change set B（A 取证后）**：Codex Pet adapter 生成一份 directional drag SVG，其中只有一个持续绘制的 `<image>`；外层 row `<g>` 在 atlas 的 `running-left` / `running-right` 两行间切 Y 偏移，内层 `<image>` 只做 X 帧动画；
- `fileLeft` 与 `fileRight` 指向同一份已加载 SVG；
- renderer 在这份 SVG document 内切换一个受控的 `data-clawd-drag-direction` 属性；
- 左右换向只改变同一个已绘制 row `<g>` 的 transform，不存在隐藏组，也不再创建新 `<object>`、追加新的 `_t=` 或卸载旧方向 document；
- 初次进入 drag reaction 仍走现有安全 swap，竖直拖动继续使用 neutral `running` 行；

两个缺陷分别决定故障的频率和严重度：局部 `clientX` 反馈回路决定会制造多少次换向，跨 document swap 决定其中一次换向能否出现整宠物空帧。必须先修前者并留下 A/B 证据，再用同文档 row 偏移从结构上移除后者。

---

## 1. 已确认事实、推断与证据边界

### 1.1 Issue 已确认信息

报告者补充：

- 闪烁发生在**持续拖动过程中改变左右方向时**，不是 pointer down / pointer up；
- 「低功耗 idle」已开启；
- 待机动画暂停后，拖动宠物或开始新任务可以恢复；
- Firefly 与菲比两个 Codex Pet 均可见到换向闪烁。

因此，本计划只把第一个现象作为缺陷处理。第二个现象应在 Issue 最终回复中解释为低功耗预期行为，不修改 pause 阈值或唤醒语义。

本方案还有两个已由当前代码链支持、但必须在实现验收中显式钉住的前提：

- 外部 Codex Pet wrapper 不是从源目录直接进入 renderer，而是先由 `src/theme-assets-cache.js` 调用 `sanitizeSvg()`，renderer 最终读取 userData theme cache 中的消毒后 SVG；
- renderer 依赖 `object.contentDocument.documentElement` 同源可读。报告者所述“低功耗暂停后拖动恢复”是该路径当前可用的旁证，因为低功耗暂停本身需要拿到 SVG root；但 packaged build 仍必须单独验证，不能把旁证当发布保证。

### 1.2 录屏逐帧证据

Issue 附件是 528×292、60 FPS、约 27.87 秒的 H.264 录屏。逐帧检查至少确认：

- 约 3.07–3.08 秒，旧方向角色消失两帧，画面只剩桌面与鼠标提示，随后新方向角色出现；
- 约 4 秒和 15 秒附近还能观察到同类空档；
- 不是每次换向都稳定录到空档，符合加载/合成时序型问题“偶发”的表象；
- 空档发生在左右角色之间，不是 spritesheet 某个动作帧自身透明。

逐帧证据能确认“换向产生完整空帧”，但它本身不能直接观测 Chromium 内部 compositor 的精确提交阶段。

### 1.3 当前代码链

当前 Codex Pet adapter：

1. 为 `running-left`、`running-right` 分别生成独立 wrapper SVG；
2. `theme.json` 的 `reactions.drag.fileLeft` / `fileRight` 指向不同文件；
3. `rendering.svgChannel` 强制为 `object`，以允许 wrapper SVG 加载同目录 spritesheet；
4. renderer 每次换向都把方向解析成另一份文件并调用 `swapToFile()`；
5. `swapToFile()` 创建新的 `<object>`，为 URL 添加新的 `_t=`，等待 `load`；
6. `load` 回调内把新对象 opacity 设为 1，并在同一个 JS task 中立即 `releaseObject()` 卸载旧对象。

外部主题随后还会经过：

7. `theme-loader` 调用 `resolveExternalAssetsDir()`；
8. `theme-assets-cache` 对 wrapper 执行 `sanitizeSvg()` 并写入 cache；
9. theme context 把 renderer asset path 指向 cache 中的消毒后文件。

这条行为由 2026-05-31 的 `23309fd5 feat(theme): support directional Codex Pet drag animations` 引入，v0.13.0 与当前 `main` 都包含。

### 1.4 根因判断

根因是双因链：

1. **频率根因**：一次 pointermove 的方向来自移动窗口内部的 `clientX`。hit window 又由主进程按全局 cursor sample 伺服移动，因此被测的局部位移会被窗口跟随主动抵消；事件投递、窗口追平和边缘钳制的时序可以制造多余反号。
2. **严重度根因**：每个方向反号都会触发两份 `<object>` SVG document 之间的完整 media swap；旧 document 在新 document 的真实像素准备好之前就可能被释放。

结合录屏空帧、1536×1872 / 1536×2288 atlas 和实现顺序，高置信推断是：`object.load` 是 nested document 的 DOM 加载信号，不是 atlas decode、首次 raster 或透明 BrowserWindow 最终呈现的屏障。`_t=` 又强制每次得到全新 document 与绘制记录；旧对象在同一 task 中被清空 `data` 并移除后，少数帧里没有任何已呈现的宠物像素。具体落在 decode、RasterTask、paint 还是 Viz/present，仍须 tracing 区分，本文不把其中任一层写成已证实。

即使 tracing 显示更底层阶段不同，只要空帧来自跨 document 换向，同文档 row 偏移仍有效，因为它不再创建新 document 或新 `<image>` 绘制记录。

### 1.5 方向事件的主驱动缺陷：移动窗口内使用 `clientX`

完整反馈链是：

```text
hit-renderer: 相邻 clientX 符号
  -> hitAPI.dragMove()（RAF 合并）
  -> pet-interaction-ipc
  -> pet-window-runtime.moveWindowForDrag()
  -> getCursorScreenPoint()
  -> computeAnchoredDragBounds() 保持抓取偏移
  -> applyPetWindowBounds() + syncHitWin()
  -> 下一批 pointermove 再从移动后的 viewport 读取 clientX
```

因此 `clientX` 不是简单的噪声放大器，而是换向事件频率的主驱动源。匀速拖动时它趋近被窗口跟随抵消；停顿追平、事件延迟和 work-area edge 钳制/解除都可能改变局部 delta 的符号。

这给出一个可证伪的时序预测：若一次 window reposition 之间收到多个 pointermove，帧内 `clientX` 沿真实方向推进，而窗口在 RAF 边界追平后，紧随其后的局部 delta 会出现与 `screenX` 相反的回落，形成与窗口 reposition 对齐的锯齿/反号簇。具体次数取决于 Chromium 的 pointermove 合并、设备采样率和主进程窗口更新时序，不能预设为固定“每秒 60 次”或 30 秒必然 `10³` 次；若同轨记录中看不到“`clientX` 反号而 `screenX` 同向、且靠近窗口同步边界”的模式，就说明频率根因被高估，必须重新评估 Change set A 的优先级。

坐标来源已有两层一手依据，但不替代真机矩阵：W3C UI Events 把 `screenX` 定义为事件发生位置相对桌面/屏幕坐标系原点的 X；Chromium 当前 Windows native mouse-event builder 用 `ClientToScreen(hwnd, point)` 生成 global point，再经 `ScreenToDIPPoint()` 写入 `PositionInScreen`。因此它在定义和实现上都不是 renderer-local `clientX`。剩余风险是窗口移动与 queued native event 的时序、fractional DIP rounding、混合 DPI seam，仍按 §6.1/§9.3 用真实 trace 验证：

- https://w3c.github.io/uievents/event-algo.html#initialize-a-mouseevent
- https://chromium.googlesource.com/chromium/src/+/HEAD/ui/events/blink/web_input_event_builders_win.cc

高频方向请求也不等于同频可见翻转：`cancelPendingSwap()` 会在新请求到来时释放尚未 commit 的 pending object，只有真正完成 `swap()` 的请求才改变可见方向。“高频 request、低频 commit”与报告者看到的偶发空帧而非疯狂可见翻转是自洽的，但仍须基线 trace 验证。

### 1.6 当前自动化证据

调查时执行：

```powershell
node --test test\hit-renderer.test.js test\pet-interaction-ipc.test.js test\codex-pet-adapter.test.js test\renderer-low-power.test.js
```

结果：149 passed / 0 failed。

这不是反证。现有测试验证的是：

- hit renderer 会在方向变化时发送 left/right；
- IPC 只转发合法方向；
- adapter 生成左右文件绑定；
- drag reaction 没有被硬编码到 `<img>` channel；
- DOM stub 中 `load` 后的同步状态正确。

其中 `test/renderer-low-power.test.js` 还有一条源码字符串断言，要求出现 `swapToFile(dragSvg, null);`。它不是 drag 换向行为测试，Change set B 重排 `startDragReaction()` 时必须明确保留、更新或用行为断言替换，不能让它成为意外的实现约束。

Node VM + 手写 DOM stub 没有 Chromium layout/compositor，也没有透明 BrowserWindow 的实际帧，因此无法发现“load 回调逻辑正确，但下一次真实合成出现空帧”。

### 1.7 尚未确认，不能写成已证实

- 尚未在维护者本机 Firefly / 菲比上独立复现；当前逐帧证据来自报告者录屏。
- 尚未通过 Chromium tracing 证明空档具体位于 decode、nested object paint、Viz commit 或透明窗口合成的哪一层。
- 尚未用计数证据量化报告录屏中真实换向与 `clientX` 伪换向各占多少。
- 尚未验证 `screenX` 在所有 Windows 混合 DPI / 跨屏组合上的连续性。
- 尚未验证通用外部主题若也使用 object channel + 两份 directional 文件，是否出现完全相同的闪烁。
- 尚未在 macOS/Linux 真机验证；本报告环境和当前手工验证重点均为 Windows。

---

## 2. 修复目标

1. Codex Pet 已进入 drag reaction 后，left ↔ right 换向不得调用 `swapToFile()`。
2. 左右换向不得创建新的 pet media element、不得更换 asset URL、不得递增 `_imgCacheBustSeq`、不得卸载当前 drag document。
3. 新方向必须在同一已加载 SVG document 内完成切换，不能出现整只宠物透明的中间状态。
4. 初次进入 drag reaction 时，首个可见 directional frame 必须使用**当时最新**方向；pending load 期间再次反向时 latest-wins。
5. 纯竖直起拖仍使用 neutral `codex-pet-running-loop.svg`，不能默认强制面向左或右。
6. 方向判定不再依赖会随窗口移动而变化的局部 `clientX`；小幅抖动不得反复触发换向。
7. Codex Pet V1（8×9）与 V2（8×11）atlas 都生成、升级和播放正确。
8. DND、低功耗 pause/resume、pointer cancel、lost capture、renderer state change 与 drag end 语义保持不变。
9. Clawd / Calico / Cloudling 及使用两份独立 directional assets 的普通用户主题不被强行改写。
10. 不新增依赖、不新增 prefs、不改变 theme schema 的公开格式、不修改窗口模型。

---

## 3. 非目标

- 不改变低功耗 idle 的 5 秒暂停设计，也不把预期暂停包装成“卡住修复”。
- 不全面重写 `swapToFile()` 或解决所有 state/reaction 跨 document 切换的潜在闪烁。
- 不消除拖动期间恰逢 agent state change 时的 `drag → state → drag` 两次跨 document swap；本次 correctness claim 只覆盖 left/right 换向，§9.1 必须单独抽样该残余路径。
- 不删除 SVG `_t=` cache-bust；它仍用于保证一次性动画重新进入时重启时间线。
- 不把 Codex Pet wrapper 强制改成 `<img>`；外部 spritesheet 子资源和当前 object-channel 契约保持不变。
- 不用简单 `scaleX(-1)` 代替左右 atlas 行；Codex Pet 左右行是作者提供的独立素材，不能假定永远严格镜像。
- 不给任意外部主题开放脚本执行、任意 DOM selector 或 renderer callback。
- 不在本修复中改 theme authoring API；普通主题仍可使用 `fileLeft` / `fileRight`。
- 不顺带重做 drag window positioning、mini snap、topmost 或 pointer capture。
- 不在未经单独授权时评论 Issue、commit、push、开 PR 或发布版本。

---

## 4. 方案比较

### 4.1 `load` 后等待 RAF 再删旧对象 —— 不作为主方案，通用路径另立项

优点：改动小，可能缓解所有 object swap。

问题：

- parent document 的 RAF 与 child document atlas 的 decode/raster 没有因果保证；等待一两个 parent RAF 仍只是经验延迟；
- `next.contentWindow.requestAnimationFrame()` 比 parent RAF 更接近 nested document 的样式/布局/绘制生命周期，可作为 `<object>` 通道的独立实验，但仍不是“像素已出现在透明窗口”的正式 present barrier；
- `<img>` / GIF 没有 `contentWindow`，不能被 child-document RAF 覆盖；该通道若另行治理，应单独评估 `img.decode()`、可见帧延后提交与重影风险，不能宣称一个 RAF 方案覆盖两种 channel；
- 旧、新相反方向重叠一至两帧可能出现重影；
- 会影响所有状态切换、fade、附件 follow、eye tracking、low-power 和 fallback 路径，回归面远大于 #620；
- Node 自动化仍很难证明真实不闪。

可作为 §6.3 `<object>` 对照组；若以后治理普通 directional theme，应单开通用 media readiness 议题。本 PR 不用 RAF 猜测替代结构性修复。

### 4.2 drag 生命周期内常驻左右两个 `<object>` —— 公平备选，但不首选

优点：

- drag start 创建并预热两个对象，drag end 全部释放，不需要通用 persistent media cache；
- 两个方向都在换向前加载，换向不重新请求；
- 可适用于更多普通 directional themes。

问题：

- 即使只活在一次 drag 中，仍需双对象 ready gate、取消/迟到 load、方向 reveal、drag end 与 theme reload 清理；
- 两份 1536×1872 或 1536×2288 nested document 增加内存、decode/raster 和 GPU 资源压力；
- 隐藏对象被揭示时仍可能遇到首次 raster/present 风险，必须定义 `display` / `visibility` / `opacity` 语义；
- 当前 renderer 的 `clawdEl`、current/pending/fading、tint、low-power、accessory 和 visibility rescue 都假定单一当前 pet media，双对象会扩大回归面；
- 对只需在同一 atlas 的相邻两行之间换向的 Codex Pet 来说，结构仍然过重。

只有单 `<image>` row 偏移在 packaged build 中失败，且失败被证明来自同文档 transform 更新时，才重新设计该备选；不能直接把它当默认逃生口。

### 4.3 同一 directional SVG：单 `<image>` + row Y 偏移 —— 首选

adapter 生成：

```text
codex-pet-drag-directional-loop.svg
  └─ <g clip-path="url(#codex-pet-frame)">
      └─ <g class="direction-row">      只承担 Y 偏移
          └─ <image class="atlas">      只承担 X 帧动画
```

SVG root 带窄 marker 与枚举状态：

```xml
<svg
  data-clawd-drag-directional="v1"
  data-clawd-drag-direction="right"
  ...>
```

`running-right` 与 `running-left` 当前逐帧 durations 完全相同：

```text
right: [120,120,120,120,120,120,120,220]
left:  [120,120,120,120,120,120,120,220]
```

因此左右共享一套只改变 X 的 keyframes；方向差异由外层 row transform 选择 atlas row 1 或 row 2：

```css
.direction-row {
  transform: translate(0, -208px); /* missing/invalid 默认 running-right */
}
[data-clawd-drag-direction=left] .direction-row {
  transform: translate(0, -416px); /* running-left */
}
```

实际数值由 `row * atlas.frameHeight` 生成，不能写死在通用 helper。renderer 同源访问 `object.contentDocument.documentElement`，只写 `left|right` 枚举属性。SVG 不需要脚本、postMessage、CSS 变量或新的网络/文件能力。

外层 `<g>` 不是可删的装饰层：CSS animation 的 `transform` 会整体替换同一元素上的静态 `transform`，不会自动把 row Y 与逐帧 X 相加。若把两者合并到 `<image>`，X keyframes 会覆盖 Y 偏移并把画面带回错误 atlas row。因此必须由 outer `<g>` 独占 Y、inner `<image>` 独占 animated X。为防 `<style>` 异常丢失时退化到 row 0，outer `<g>` 同时写 presentation attribute `transform="translate(0,-208)"` 作为 right-row 兜底；正常 CSS direction selector 的优先级高于 presentation attribute。

theme binding 保留 neutral file：

```json
{
  "drag": {
    "file": "codex-pet-running-loop.svg",
    "fileLeft": "codex-pet-drag-directional-loop.svg",
    "fileRight": "codex-pet-drag-directional-loop.svg"
  }
}
```

结果：

- 第一次水平起拖：从当前 state swap 到 directional document 一次；
- 同一次 drag 内 left ↔ right：只写 root attribute，由一个已绘制 `<g>` 改 transform；
- 竖直起拖：仍进入 neutral running document；
- 竖直后首次水平移动：最多从 neutral swap 到 directional 一次；
- 松手：按现有 `resumeFromReaction()` 回到真实 state；
- 换向前后动画 phase 天然连续，例如同一时刻的第 5 帧从 right row 第 5 格切到 left row 第 5 格。

这一形态没有隐藏内容、没有 both-hidden 状态、没有第二个 `<image>`，换向使用的是现有 X 动画每 120ms 已反复经过的 transform 绘制路径。它用最窄协议删除 #620 的跨 document 换向路径，因此选为最终方案。

硬约束：left/right durations 必须逐项相等。测试应直接钉住这条不变量；未来若 atlas timing 分叉，更新 timing table 的 PR 必须先把 directional generator 改成能表达两套时间线的设计，不能静默沿用本实现。

### 4.4 CSS 镜像一份方向素材 —— 拒绝

虽然最省资源，但会丢掉作者在左右行中提供的非对称细节，也会改变 Codex Pet atlas 契约。`validatePngAtlasAlpha()` 还明确要求 row 1 和 row 2 的有效单元各自存在可见像素，说明上游把它们作为独立素材维护；不能假定永远严格镜像。

### 4.5 把方向判定移到 main process —— 暂不采用，保留升级门

main process 的 `screen.getCursorScreenPoint()` 已是拖动定位的全局 DIP 真相，把方向计算放进同一次 cursor sample 最稳定；但它会改变 hit → main → renderer 的职责和方向事件所有权，并非“零成本、零协议变化”。

Change set A 先在 hit renderer 使用 `PointerEvent.screenX` + 累积迟滞，保持现有控制边界。若它在混合 DPI / 跨屏 A/B 中仍产生假反向，停止调 3px 参数，直接改为由 `moveWindowForDrag()` 使用同一次 main-process cursor sample 产出方向；不能退回 `clientX`。

不首选 `PointerEvent.movementX`：deadband 需要一个可重新锚定的绝对坐标，`screenX` 直接提供绝对位置；`movementX` 只有增量，必须自行积分，事件合并/丢弃后没有绝对参照可校正。可在 Spike A 中作为观测列与 `screenX` delta 对照，不作为发布算法。

### 4.6 通用 media crossfade —— 拒绝

把所有方向换向改成新旧 media 交叉淡入淡出可以遮住空帧，但 `#clawd` 是 `position: absolute` 叠放；左右方向同时半透明会产生明显的对向重影。它还会改动普通状态、reaction、附件和两种 media channel 的共用生命周期，视觉副作用和回归面都大于 #620。保留现有 fade 配置语义，不把 crossfade 作为方向 correctness 机制。

---

## 5. 强制设计不变量

### D1 — 同一 directional document 换向绝不 swap

当 `isDragReacting=true` 且解析出的 `dragSvg === currentDragSvg` 时：

- 先更新 `currentDragDirection`；
- 尝试把方向应用到已显示 directional object；
- 若 object 仍 pending，则由 commit 读取最新方向；
- 直接返回，不调用 `swapToFile()`。

### D2 — 首帧必须 latest-wins

directional object 的 commit 在 `opacity=1` 和移除旧媒体**之前**写入最新 `currentDragDirection`。不得把初始 direction 永久 closure capture；pending 期间 left → right 后，首次可见帧必须是 right。

### D3 — marker/同源失败时 bounded failure

renderer 只在：

- 元素是 pet `<object>`；
- `contentDocument.documentElement` 可读；
- root marker 精确等于 `data-clawd-drag-directional="v1"`；
- direction 是 `left|right`；

时写属性。任何异常都不得 throw、不得执行 selector heuristic、不得访问其他文档节点。最多按文件/renderer 生命周期记录一次无完整本地路径的 warning。

在正常 `<object>` channel 中，wrapper 的 CSS 默认 right row，marker bridge 失效时应仍有确定方向；但若 `swapToFile()` 已降级到 forced `<img>` channel，外部 wrapper 的同目录 spritesheet 可能因沙箱/子资源限制而不可见。这里的保证只是“不崩溃、不越权、不误写 DOM”，不能笼统承诺“宠物一定显示默认方向”。

### D4 — 单 image 结构不允许隐藏状态

directional wrapper 必须且只能有一个 atlas `<image>`。outer row `<g>` 与 inner animated `<image>` 必须分离，不能把静态 Y 和 animated X 合到同一个 `transform` 属性；原因见 §4.3。missing/invalid direction 使用 presentation attribute 与基础 `.direction-row` 的 right row transform；任何方向 selector 都不得修改 `display`、`visibility` 或 `opacity`。结构上不存在“左右同时隐藏”或“揭示隐藏组”的状态。

### D5 — neutral 竖直拖动保持不变

`drag.file` 继续绑定 row 7 neutral running。只把 `fileLeft` / `fileRight` 合并到 directional wrapper。

### D6 — pending/cancel/end 生命周期完整清理

以下路径都要清空或失效化 `currentDragDirection` 与 `currentDragSvg`：

- `endDragReaction()`；
- renderer `cancelReaction()`；
- theme config/reload（同时清 `isDragReacting`，不能只清 drag file/direction 身份）；
- DND/state change 取消；
- pending swap 被新 state supersede。

迟到的 object load 不能重新应用已结束 drag 的方向。

注意：实施前的 `cancelReaction()` 只把 `isDragReacting` 置为 false，并不清 `currentDragSvg`。本次新增清理是有意的行为变更，不是机械整理。state change 在手指未松开时打断 reaction 后：

- renderer 清 `currentDragSvg/currentDragDirection`；
- hit renderer 保留 direction anchor 与**最后一次已确认方向**，同时清本地 reacting flag 并 arm 一次 restart；
- 下一次 pointermove 只重发最后一次已确认方向，不做新方向判断、不更新 anchor、不绕过 deadband；
- 若此前从未确认 left/right，则保持 neutral，直到后续累计 screen-space delta 正常越过 D9 deadband。

这样既恢复 drag reaction，又不允许 1px 噪声在 restart 路径重新决定方向。不得因残留 same-file fast path 吞掉接续事件。

### D7 — adapter 升级单调且原子

- `ADAPTER_VERSION` 从 4 升到 5；
- 旧 managed Codex Pet theme 在下一次 sync 自动判定为 outdated；
- rebuild 仍先写 in-progress marker、清空 assets、重新生成、最后提交完整 marker；
- 新 wrapper 文件必须进入 materialization completeness 检查；
- 被替代的 `running-left/right` 独立 wrapper 会从 managed theme **源 assets 目录**随重建移除；
- `theme-assets-cache` 当前只回收不再引用的 raster，不回收陈旧 SVG；cache 中旧 left/right wrapper 可能继续占少量磁盘，但 theme JSON 不再引用它们，不影响功能。通用 stale-SVG cache GC 不纳入 #620；
- unmanaged user theme 永不被覆盖。

### D8 — 不扩大脚本信任面

directional wrapper 只包含 SVG/CSS/image，不包含 `<script>`、事件 handler、外部 URL 或用户可控 selector。renderer 只写枚举 attribute。

### D9 — 方向迟滞使用累计全局位移

不得对单个 1px event 直接反号。建议：

```text
directionAnchorScreenX = 上一次越过 deadband 时的 screenX
delta = currentScreenX - directionAnchorScreenX
abs(delta) < 3 CSS px -> 保持当前方向
abs(delta) >= 3       -> 无条件把 anchor 更新为 currentScreenX
                         若 sign(delta) 改变方向，只发一次 direction IPC
                         若方向相同，不发 IPC
```

这保证持续向右 500px 后，只需真实向左约 3–5px 就能换向，而不是退回整个 500px。小于阈值的多个同向事件会相对未更新的 anchor 累积，达到阈值后被接受。

初次超过 drag threshold 时同样使用 pointerdown 到当前事件的 screen-space delta。`screenX` 缺失或非有限时，不得用随窗口移动的 `clientX` 猜新方向：保持当前方向；若尚无方向则发送/保留 `null` neutral fallback。真实 Electron PointerEvent 路径必须由测试证明带有限 `screenX`。

### D10 — 普通 directional themes 兼容

若 `fileLeft !== fileRight`，renderer 继续使用现有 media swap 行为；本 PR 不静默把任意用户素材合并或镜像。只有相同文件且内部带受控 marker 时走 in-document direction 更新。

### D11 — directional timing 必须逐帧相等

`running-left.durations` 与 `running-right.durations` 必须长度相同且每项相等；共享的 X keyframes 只能在该不变量成立时生成。该检查抽成独立导出的纯断言并由 generator 调用，使相等/不等的合成 row 都可直接测试。未来 timing 分叉必须先重做 representation，不能自动取其中一边或合并总时长。

### D12 — sanitizer 是协议边界

生成器输出不是 renderer 的最终输入。directional marker、`data-clawd-drag-direction` 属性、left selector、`.direction-row` transform 和 `.atlas` keyframes 必须经过 `sanitizeSvg()` 后仍完整存在；测试应针对消毒后文本/DOM 断言，不能只看 generator 原始字符串。

---

## 6. 证据计划：同轨对照，再验证渲染形态

证据采集使用当前 Electron 41 和透明 BrowserWindow。诊断计数必须是临时或 debug-gated 的，不默认写入生产日志；最终提交前移除逐事件日志，只保留匿名坐标差分 fixture 与必要测试。

### 6.1 Spike A：旧输入路径基线

在 pre-A 基线构建上，对**同一次真实手部动作**同时运行三路方向计数器：

1. A：当前相邻 `clientX` 裸符号——保持为实际 IPC 驱动；
2. B：候选 `screenX + 3px deadband`——shadow 计数，不驱动；
3. C：相邻 `screenX` 裸符号——shadow 计数，用于把“坐标空间贡献”与“deadband 贡献”拆开。

同轨记录 raw pointermove 数、`clientX/screenX/timestamp`、三路 direction/flip 数和窗口同步时刻。`movementX` 仅作观测对照。work-area edge 是否处于钳制区是可选列；如要精确记录，允许临时插桩 `pet-window-runtime.js` / IPC / preload，但必须在生产 commit 前移除。

固定执行至少一轮 30 秒连续拖动：匀速单向、停一下继续同向、真实反向、原地微抖、靠近工作区边缘再离开。判据不是预设绝对次数，而是：A 是否出现与 window sync 对齐、且 C 保持同向的局部反号锯齿；A vs C 隔离坐标空间贡献，C vs B 隔离 deadband 贡献。如果该模式不存在，重新评估频率根因和实施顺序。

将一次去除绝对屏幕位置、只保留相对 `clientX/screenX/timestamp` 的真实 trace 固化为 `test/hit-renderer.test.js` 可回放 fixture；CI 对同一序列同时运行 legacy 与候选算法，形成确定性 before/after，不用两次不可重放的人手轨迹作对照。

### 6.2 Spike B：候选算法 shadow 验证与落地门

在基线三路计数和 fixture replay 上验证 B：

- `clientX` 回落或反号、`screenX` 持续同向时，不得发伪反向；
- 同方向持续移动不得重复发 direction IPC；
- 真实反向约 3–5 CSS px 后应只发一次新方向；
- 对相同 trace 比较 A/B/C 的 direction 调用数和翻转数，而不是只写“感觉稳定”；
- Windows 100%、125%、150% 以及可用的混合 DPI 跨屏场景分别记录。

Change set A 应作为独立 commit/PR/可发布单元；B 的 shadow/replay 与真机矩阵通过后才允许把实际驱动从 A 切到 B。如果 `screenX` 在混合 DPI 下仍翻车，直接执行 §4.5 的 main-process cursor 方案，不继续调 deadband 参数。

### 6.3 Spike C：旧渲染路径与 tracing

该证据必须与 §6.1 在同一个 pre-A 构建、同一轮开机中采集，不能等 Change set A 合并后再回头复现：

1. 保留独立 left/right wrapper 和当前 `load -> opacity 1 -> release old` 顺序；
2. 对有意的真实反向做 60 FPS 以上录制或逐帧 capture；
3. 能复现时抓 Chromium trace，重点观察 image decode、RasterTask、paint、Viz/present 和旧 object release 的相对顺序；
4. 若维护者机器无法稳定复现，明确记录，并继续以 Issue 逐帧证据作为故障成立依据；
5. tracing 用于校正机制描述，不作为结构性方案有效性的唯一 gate。

### 6.4 Spike D：单 `<image>` row 偏移

1. 生成只有一个 `<image>` 的 directional wrapper，outer row `<g>` 承担 Y、inner image keyframes 只承担 X；
2. 先把原始生成物送入 `sanitizeSvg()`，再用消毒后的 cache 产物加载；
3. 连续快速切换 root attribute 至少 100 次，确认 element/document identity 不变；
4. 逐帧验证 left/right 对应 atlas row 2/1，不颠倒、不透明、不双影；通过 DevTools/CDP 在切属性前后读取 `.atlas.getAnimations()[0].currentTime`，断言同一 Animation identity、时间单调且不归零；
5. 验证 V1/V2 都只有一个内部 `<image>`：SVG root/viewBox 均为 192×208，内部 image 分别为 1536×1872 / 1536×2288；
6. 验证 `object.contentDocument.documentElement` 在 dev 与 packaged Windows build 都可读写；
7. 验证消毒后 marker 和方向 selector 仍完整存在；
8. 验证同一 atlas href 不触发额外文件读取错误。

### 6.5 Stop gate

出现以下任一项不得合并对应 change set：

- `screenX` 在支持矩阵中仍产生不可接受的假反向；此时直接转 main-process cursor truth；
- left/right durations 不再逐项相等；此时单-image shared-keyframes 方案无效，必须先重做 representation；
- 消毒后 marker、方向 selector 或 transform 被移除/改坏；
- packaged build 下 `contentDocument` 不可读；
- 单 `<image>` attribute 切换仍出现完整透明帧、错误 row 或动画相位重启；
- 需要给 SVG 增加脚本执行、宽泛 selector 或 CSP 放宽才能工作。

若单-image Spike D 失败，先定位是 CSS row transform、sanitizer 还是同源边界；只有证明同文档 row transform 本身不可行，才重新设计 §4.2 的 drag-lifetime dual-object 备选。

---

## 7. 实施计划

### Phase 1：Change set A——先修方向输入并独立取证

修改 `src/hit-renderer.js`：

1. 记录 pointer down 的有限 `screenX` 和 direction anchor；
2. 初始 drag threshold **有意继续使用当前 `clientX/clientY` 二维位移**判定“是否成为拖动”，首次方向才来自 screen-space horizontal delta；这是为保持 click/drag 与 2/4-click 累加器的既有 UX 边界，不得为了“统一坐标空间”顺手改成 screen-space threshold；
3. 成为 drag 后按 D9 使用累计 `screenX` anchor + 3 CSS px deadband；
4. 每次 `abs(delta) >= 3` 都更新 anchor；同方向不重复发 reaction，反方向只发一次；
5. `screenX` 不可用时保持当前方向/neutral，不退回随窗口移动的 `clientX`；真实 Chromium PointerEvent 正常应始终有有限 `screenX`，这里是防御分支，只要求合成事件单测，不列入真机复现场景；
6. pointerup、pointercancel、lost capture、blur 清理全部 direction sample；main reaction cancel 若物理拖动仍在继续，则按 D6 保留 anchor/已确认方向，下一 pointermove 只重发该方向而不做新决策；
7. 保留 vertical/no-horizontal 的 null fallback；
8. 不改变 RAF 合并的 `dragMove()` 窗口定位路径。

`src/preload-hit.js`、`src/pet-interaction-ipc.js` 和 `src/preload.js` 的方向 wire 仍是 `left|right|null`，预计无需生产修改。按 §6.1–6.2 保存同轨三路计数与 fixture replay；该 change set 自动化与 Windows QA 完成后才能开始后续 adapter/renderer 改动。

### Phase 2：Change set B1——Codex Pet 单-image directional wrapper

修改 `src/codex-pet-adapter.js`：

1. `ADAPTER_VERSION = 5`。
2. 新增常量，例如 `DIRECTIONAL_DRAG_WRAPPER = "codex-pet-drag-directional-loop.svg"`。
3. 将普通单行 `WRAPPER_SPECS` 与特殊 directional wrapper 的生成职责分开；不要给现有 `generateWrapperSvg()` 塞入含糊的多形态参数。
4. 新增纯函数 `generateDirectionalDragWrapperSvg({ spritesheetHref, atlas })`：
   - 读取 `running-left` / `running-right` row metadata；
   - 先调用独立导出的纯断言 `assertDirectionalTimingParity(leftRow, rightRow)`（或等价命名）执行 D11 durations 逐项一致性检查，让拒绝路径可用合成 row 直接测试；
   - 生成一套只含 X 位移的 shared keyframes；
   - 生成一个 outer `.direction-row`，presentation transform 与基础 CSS 都指向 right row，left selector 指向 left row；
   - 生成且只生成一个 `.atlas` `<image>`，继续使用 escaped spritesheet href；
   - root 写入 v1 marker 和 deterministic right fallback；
   - 所有 id/class 固定由代码生成，不使用 manifest display name/id；
   - 支持 V1/V2 atlas dimensions。
5. materialization 生成 directional wrapper，并把它纳入完整性检查。
6. `buildThemeJson()` 保留 neutral `drag.file`，把 left/right 都指向 directional wrapper。
7. assets 源目录仍整目录重建，确保旧独立方向 wrapper 不残留；cache 的陈旧 SVG 按 D7 记录为非功能残留。
8. export 新 generator/constant 供测试使用。

不修改 theme schema：同一个安全 basename 同时出现在 `fileLeft` / `fileRight` 已是合法输入。当前 canonical asset collection 会容忍重复 usage 记录，并不会自然 dedup；不要把“能通过”误写成“已去重”。

### Phase 3：Change set B2——renderer 同文档方向控制

修改 `src/renderer.js`：

1. 新增 `currentDragDirection = null`，只保存 `left|right|null`。
2. 新增纯规范化 helper，拒绝其他 wire value。
3. 新增窄 DOM helper，例如 `applyDirectionalDragToObject(objectEl, direction)`，严格执行 D3。
4. 调整 `startDragReaction(direction)` 顺序：
   - 先规范化并保存最新方向；
   - 再解析 drag file；
   - same-file active/pending 时只应用/记住方向并返回；
   - different-file 时沿用现有 reaction cancel、eye detach、low-power resume 与 cursor pause；
   - 不重复发送 `pauseCursorPolling()`。
5. object-channel `swap()` 在 reveal/removal 前调用 directional helper；只在仍属于当前 drag reaction 且 file/token 匹配时应用。
6. pending load 的 commit 读取全局最新方向，不捕获第一次方向。
7. `endDragReaction()`、`cancelReaction()` 与 theme re-init 清理方向状态。
8. marker 不存在或 contentDocument 不可读时按 D3 bounded failure；不得声称 forced-img fallback 一定可见。
9. 明确处理 `test/renderer-low-power.test.js` 现有的 `swapToFile(dragSvg, null);` 源码字符串断言：若实现仍保留该行，补行为测试使它不再是唯一护栏；若重构后不再逐字存在，同步替换为等价行为断言。

不要修改通用 `releaseObject()` 的卸载语义；#620 的左右换向已不再经过它。

### Phase 4：升级、文档与收尾

1. 启动 sync 自动把 adapter v4 managed themes 升到 v5。
2. Settings “Refresh Codex Pets” 同样触发 rebuild，并报告 `updated`。
3. 不改变 source pet package；只更新 Clawd userData 中的 managed generated theme。
4. dev 与 packaged build 均从 sanitized cache 产物验证 marker/contentDocument bridge。
5. 版本号确定后更新对应 release note；措辞限定为“Codex Pet 左右换向不再跨 document swap”，不把所有拖动时序概括成已无空帧，也不把低功耗暂停写成 bug fix。
6. Issue 回复分开说明：左右换向空帧路径已修；拖动中 state change 仍属于通用跨 document 残余风险；低功耗暂停是预期行为。

---

## 8. 自动化测试

### 8.1 `test/codex-pet-adapter.test.js`

至少新增/修改：

1. 直接测试 `assertDirectionalTimingParity(leftRow, rightRow)`：相同 durations 通过，长度或任一项不同的合成 row 明确拒绝；另断言 generator 实际调用该约束。
2. directional wrapper 只有一个 `.atlas` `<image>`、一套 X-only keyframes 和一个 `.direction-row`。
3. right/left selector 分别使用 row 1 / row 2 的 Y 偏移；X keyframes 使用正确帧数且不带 Y。
4. root marker、默认 direction、outer `<g transform="translate(0,-208)">` presentation fallback 与 CSS fallback 始终指向可见 right row，不使用 display/visibility/opacity 隐藏。
5. SVG 不含 `<script>`、event handler、外部 URL。
6. spritesheet href 继续经过 XML attribute escaping。
7. SVG root/viewBox 在 V1/V2 都是单帧 192×208；内部 `<image>` 才分别是 1536×1872 / 1536×2288。
8. 将 generator 原始输出喂给 `sanitizeSvg()`，断言消毒后 marker、`data-clawd-drag-direction`、left selector、row transform 和 X keyframes 逐字/语义存活，且仍只有一个 `<image>`。
9. `themeJson.reactions.drag.file` 仍是 neutral wrapper。
10. `fileLeft === fileRight === directional wrapper`。
11. materialization 输出新文件，源 assets 不再输出旧 left/right 独立 wrapper。
12. adapter v4 marker 下一次 sync 变成 `updated`，新 marker 为 v5，旧源方向文件被清除。
13. base theme id 被 unmanaged theme 占用时，原有带 suffix 的 v4 managed theme 升到 v5 后仍保留同一个 theme id，不能重复导入到新 suffix。
14. unchanged v5 theme 仍跳过 rebuild。
15. partial/recovery、Unicode id、V2 alpha cache、orphan theme 测试继续通过。

第 8 条会让该测试显式依赖 `src/theme-sanitizer.js`，这是有意扩大的生产边界测试，不应通过复制 sanitizer 规则到测试里规避依赖。

### 8.2 `test/renderer-low-power.test.js`

扩展 FakeElement/FakeObject，使 object `contentDocument.documentElement` 支持受控 attribute。行为测试至少覆盖：

1. 第一次 left drag 创建一个 directional pending object。
2. pending 完成前收到 right，不创建第二个 object、不增加 swap token；commit 前写入 right。
3. directional object 已显示后 left ↔ right：
   - media element identity 不变；
   - `currentDisplayedAssetUrl` 不变；
   - `activeSwapToken` 不变；
   - root attribute 正确变化；
   - 没有 pending object；
   - 没有 release 当前 object。
4. 重复同方向无额外 DOM 写/IPC。
5. marker 缺失、contentDocument throw、非法方向都不崩溃。
6. `fileLeft !== fileRight` 的普通主题仍走原有 swap。
7. vertical neutral → first horizontal direction 只发生一次 neutral-to-directional swap。
8. cancel/end 后迟到 load 不再写旧方向。
9. renderer-only：state change/cancel 清 `currentDragSvg/currentDragDirection`；随后再次调用 `startDragReaction(已确认方向)` 必须走一次完整 swap，不能被残留 same-file fast path 吞掉。hit 侧重发语义只在 §8.3 harness 测试。
10. state change、DND、low-power resume 和 `resumeFromReaction()` 保持现有调用次数。
11. 现有 `swapToFile(dragSvg, null);` 源码字符串断言被明确保留或改成行为断言，不能意外删除后只修测试字符串。
12. 现有 object visibility rescue、tint、accessory、fade、glyph flip 测试不回归。

测试应断言“换向没有创建新文档”这一结构性事实，而不是在无 compositor 的 VM 中伪造“零闪烁”结论。

### 8.3 `test/hit-renderer.test.js`

至少覆盖：

1. `clientX` 因窗口跟随回落甚至反号、`screenX` 持续右移时，只报告 right，不能误报 left；这是频率根因的核心回归护栏。
2. 真实反向越过迟滞后报告一次 left。
3. 小于迟滞的左右抖动不换向。
4. 多个小步累计超过迟滞可以换向，不能要求单事件跳 3px。
5. 同方向每次越过 deadband 都更新 anchor 但不重复发 reaction；长距离向右后向左 3–5px 即换向。
6. screenX 缺失/非有限时保持当前方向或 neutral，明确证明不会回退用 clientX 猜方向。
7. vertical drag 仍发送 null/default reaction。
8. pointerup/pointercancel/lost capture/blur 清理全部方向状态；main reaction cancel 在 physical drag 继续时保留 anchor 与最后已确认方向并 arm restart。
9. main cancel 后手指未松：下一 pointermove 重发**最后已确认方向**，不从该事件位移做新决策、不更新 anchor；此前从未确认方向则保持 neutral 直到正常越过 deadband。最终 actual drag 仍完成 end handshake。
10. 回放 §6.1 的同一坐标 trace fixture，断言 legacy clientX、screenX naked、screenX+deadband 三路确定性计数，隔离坐标空间与 deadband 的各自贡献。

### 8.4 其他回归

定向命令：

```powershell
node --test test\hit-renderer.test.js test\pet-interaction-ipc.test.js test\codex-pet-adapter.test.js test\renderer-low-power.test.js test\theme-sanitizer.test.js test\theme-assets-cache.test.js test\theme-context.test.js test\theme-schema.test.js
```

合并前：

```powershell
npm test
npm run verify:electron
```

由于问题涉及真实 Chromium 合成，自动化通过不能替代 §9 的 Windows 逐帧 QA。

---

## 9. Windows 真机 QA

### 9.1 主要复现矩阵

至少使用：

- 报告同款 Firefly、菲比（若可取得）；
- 维护者本机任一 V1 Codex Pet；
- 一个 V2 Codex Pet；
- dev 启动和一次 packaged Windows build。

先在 pre-A 构建对同一动作归档 §6.1–6.2 的三路 shadow 计数与 trace fixture；Change set A 后回放同一 fixture 并做真机 smoke。再对 Change set B 做逐帧渲染验收，不能用两次不可重放的人手轨迹作 before/after。

每个 pet：

1. 按住持续拖动，慢速 left ↔ right 20 次。
2. 快速 left ↔ right 50 次。
3. 原地小幅抖动 10 秒。
4. 纯竖直拖动，再转为水平拖动。
5. 水平拖动途中短暂停顿后反向。
6. pointer release 后确认恢复真实 idle/working state。
7. drag 中触发 pointercancel/lost capture 可行场景，确认不残留 running。
8. 开启 DND，确认不播放 drag reaction。
9. 开启低功耗 idle：静置暂停、拖动唤醒、松手后重新进入 idle 并按预期再次暂停。
10. 在 drag threshold 附近做轻微 click/drag smoke，确认保留 `clientX/clientY` threshold 后，单击与 2/4-click reaction 分界未改变。
11. 持续拖动时人为触发一次 agent state change（例如启动/停止一个 session），逐帧记录 `drag → state → drag`；这条用于界定 #620 能否整体关闭，不得把“纯换向已无闪”外推到该路径。

### 9.2 逐帧验收

用 60 FPS 或更高录屏，抽查所有反向点：

- 不得出现整只宠物完全透明的帧；
- 不得出现左右两个方向同时可见的双影帧；
- 换向后方向正确；
- 录屏粗筛不得回到 neutral/idle 帧；动画 phase 是否连续不靠肉眼猜帧号，以 §6.4 的 `.atlas.getAnimations()[0].currentTime` 单调且不归零为准；
- 鼠标提示 overlay 不计作宠物可见内容。

至少完成一轮 30 秒连续压力拖动并记录实际 direction IPC/翻转次数；60 FPS 肉眼抽查是有限抽样的呈现证据，同轨 fixture/计数是输入证据，`currentTime` 是相位证据，三者都要保留。一次偶然“没看到闪”不能单独作为通过标准。

### 9.3 DPI / 多屏

Windows 至少覆盖可用的：

- 100%、125%、150%；
- 不同缩放显示器跨屏；
- 左右跨越 display seam；
- 接近 work-area edge 的持续换向。

验收点：窗口跟手不回归，方向不因局部 client coordinate 复位而反跳。

### 9.4 其他主题回归

- Clawd drag reaction；
- Calico drag reaction；
- Cloudling drag reaction；
- 必须自造一个 `fileLeft !== fileRight` 的 GIF directional user-theme fixture；本仓 Clawd / Calico / Cloudling 都没有该配置，不能把内置主题 smoke 当成普通 directional theme 覆盖；
- click/double reaction；
- working/idle state swap；
- theme hot switch / Codex Pet refresh 后首次 drag。

### 9.5 平台边界

当前开发环境 Windows-first。macOS/Linux 至少完成：

- 全量自动化；
- build/code review；
- 检查标准 `screenX` 路径及“不可用时保持方向/neutral”分支不依赖 Windows-only API；
- 若无真机，明确记录“未真机验证”，不能写成全平台已确认。

---

## 10. 性能、资源与安全

### 10.1 性能

- 同一 directional document 只有一个 `<image>`、一个 X 动画和一个 row transform；不存在隐藏组的持续动画开销或揭示首帧。
- 换向不改变 atlas href、不创建新 image/document、不重启动画时间线。
- 快速反向不再重复创建 nested browsing context，理论上应显著减少 GC、decode 和 compositor churn。
- §6 记录 CPU/GPU/内存只能用于防止明显回归；不把某台机器的具体占用数字写成跨平台保证。

### 10.2 资源与打包

- 新 wrapper 是运行时生成到 userData 的 managed theme asset，不新增仓库二进制素材。
- `package.json build.files/asarUnpack` 无需新增路径。
- adapter 源码已随 `src/**/*` 打包；spritesheet 仍来自用户 Codex Pet package。

### 10.3 安全

- 不执行 Codex Pet manifest 提供的脚本。
- 不把 manifest 字符串插入 id/class/style。
- spritesheet href 继续使用现有 basename/containment validation 与 XML escaping。
- renderer 只设置固定 marker 文档的 `left|right` 属性。
- 不新增 IPC channel、文件读取、网络请求或 CSP 放宽。

---

## 11. 预计文件边界

预计修改：

```text
src/codex-pet-adapter.js
src/renderer.js
src/hit-renderer.js
test/codex-pet-adapter.test.js
test/renderer-low-power.test.js
test/hit-renderer.test.js
docs/releases/<next-release>.md（实现完成后）
```

新增的测试依赖边界：

```text
test/codex-pet-adapter.test.js -> src/theme-sanitizer.js
```

`src/theme-sanitizer.js` 与 `src/theme-assets-cache.js` 预计不修改，但前者必须被 directional generator 的边界测试直接调用，后者的既有 cache 测试必须进入定向 suite。

§6 的 pre-A 证据采集允许临时修改 `src/pet-window-runtime.js`、`src/pet-interaction-ipc.js`、`src/preload-hit.js` 或 preload 以标注 window sync / edge clamp；这些插桩不得进入生产 commit，采集结束后必须恢复。因此它们仍属于“预计无需生产修改”，不与本节边界冲突。

预计无需修改：

```text
src/preload.js
src/preload-hit.js
src/pet-interaction-ipc.js
src/theme-schema.js
src/theme-context.js
src/theme-loader.js
src/index.html
src/styles.css
src/prefs.js
src/settings-controller.js
package.json
hooks/*
themes/*
```

如果实施超出该边界，必须说明原因并重新评估是否仍属于 #620。

---

## 12. 实施顺序

1. [ ] 在同一个 pre-A 构建/开机中完成：三路同轨方向计数、匿名坐标 trace fixture、旧 object 路径录屏/tracing；记录 decode/raster/present 证据或本机不可复现边界。
2. [x] 编写 hit renderer 红测试：trace replay、clientX 伺服回落、screenX deadband/anchor、cancel 重发已确认方向。
3. [x] 实现 Change set A screen-space resolver，不改 adapter/renderer。
4. [ ] 跑 Change set A 定向 suite与 DPI/边缘真机 smoke；对同一 fixture 比较 legacy / naked screenX / deadband 三路结果，失败则转 main-process cursor truth。
5. [ ] 将 Change set A 作为独立可审核/可合并单元完成 review；不与渲染大改混淆归因。
6. [x] 编写 adapter 红测试：single image、presentation fallback、timing parity pure assertion、sanitize contract、v4→v5 rebuild。
7. [x] 实现 single-image directional wrapper generator 与 adapter v5 materialization。
8. [ ] 在 dev 与 packaged build 完成 sanitized cache + contentDocument + animation currentTime Spike D。
9. [x] 编写 renderer 红测试：pending latest-wins、same-file direction no swap、cancel 后再次 start 完整 swap、既有源码断言处理。
10. [x] 实现 renderer root attribute bridge 与生命周期清理。
11. [x] 跑完整定向 suite。
12. [x] 跑 `npm test` 与 `npm run verify:electron`。
13. [ ] Windows dev / packaged build 按 §9 做有限抽样录屏、相位与 click/drag smoke。
14. [ ] 回填证据、更新 release note。
15. [x] 已完成独立 code review；结论是先进入真机 QA，§13 未满足前不关闭 #620。

---

## 13. 合并标准

以下全部满足才可合并：

1. Change set A 对同一 trace fixture 产出 legacy clientX / naked screenX / screenX+deadband 三路确定性计数，`clientX` 反号而 `screenX` 同向的回归测试通过；DPI 失败时已转 main-process cursor truth。
2. 按 §6.4.3 的至少 100 次 attribute 切换和 §9.2 的 30 秒/60 FPS 有限抽样协议，未观测到消毒后 single-image document 的完整透明帧或错误 row；`.atlas` Animation identity 不变且 `currentTime` 单调不归零。该标准是明确抽样门，不声称证明连续过程上的全称否定。
3. Codex Pet left/right 同文件绑定，neutral vertical fallback 保留。
4. directional wrapper 只有一个 `<image>`，left/right durations 逐项相等，sanitizer contract 测试通过。
5. dev 与 packaged build 的 `contentDocument` 同源 bridge 均已验证。
6. active directional drag 换向不会调用 `swapToFile()`；pending load latest-wins，无首帧错误方向。
7. cancel/state change 后继续按住拖动会重发最后已确认方向而不绕过 deadband，renderer 再次执行完整 swap，`currentDragSvg` 不残留。
8. V1/V2 adapter 生成与 v4→v5 upgrade 通过。
9. 没有 script、宽泛 selector、CSP 放宽或新信任面。
10. 相关定向测试、`npm test`、`verify:electron` 全绿。
11. Windows 60 FPS 逐帧录屏没有整宠物透明帧或双影帧，且 30 秒 direction 计数归档。
12. Clawd / Calico / Cloudling 与自造 GIF directional user theme 回归通过。
13. 低功耗 idle 行为保持预期，没有为“不卡住”而禁用节能暂停。
14. macOS/Linux 未真机覆盖的残余风险在 PR 中明确披露。

---

## 14. 回滚与发布后升级规则

### 合并前回滚

若尚未发布 adapter v5，可以整体回退 adapter/renderer/hit 三部分，并恢复 v4 生成物测试。

### 已发布后的回滚

adapter version 必须单调递增。若 v5 已进入用户环境：

- exact-version 检查意味着把常量降回 v4 **技术上会让 v5 marker 进入 rebuild**，所以“降号完全不会重建”不是成立理由；
- 真正的必要条件是：若回滚后的生成物与历史 v4 不是逐字节/协议等价，复用 v4 会让仍停留在旧 v4 的用户被判 unchanged，从而永远拿不到新的回滚产物，同时让同一版本号代表两种内容；
- 不得在保持 v5 的情况下悄悄改变生成内容；现有 v5 theme 会被判定 unchanged，不会重建；
- 降回 v4 还会让 `collectManagedMarkersByPackagePath()` 忽略所有 v5 marker，使 PNG alpha validation cache 在下一次扫描整体失效并全量重算；结果慢但应保持正确；
- 若是逐字节等价的干净 revert，复用 v4 在纯功能上可以自洽；仍推荐发布 v6，是因为 marker 版本号需要唯一标识产出协议/构建路径，降号会切断运维诊断链，而任何部分回滚都会静默制造“同号不同内容”。v6 应显式生成回滚后的资产/binding，并测试 v4→v6、v5→v6 migration，包括原 theme id / suffix 保持不变。

renderer 与 hit-direction 修复可以独立禁用，但 adapter 生成协议一旦发布就必须按新版本迁移。

---

## 15. 残余风险与后续

1. 普通外部主题若使用 object channel + 两份独立 directional files，仍可能走跨 document swap；本计划只对 managed Codex Pet 建立无 swap fast path。若收到同类报告，应单开通用 media readiness 议题，分别评估 object child-RAF、img decode 和 drag-lifetime dual-object，而不是默认引入永久 cache。
2. 初次进入 drag reaction、drag end 回真实 state，以及拖动中途被 agent state change 打断后的 `drag → state → drag`，仍是普通 media swap；#620 录屏聚焦中途换向，本计划不声称消除所有 object swap 的潜在空档。
3. theme cache 中不再被 source/theme JSON 引用的旧 directional SVG 当前不会被 GC；只造成少量磁盘残留，不影响 renderer 选择。通用 SVG cache cleanup 另立项。
4. `screenX` 的混合 DPI 行为是实现前 gate，不应凭 Web 标准假定等同于 Electron main-process DIP。
5. Chromium/Electron 升级或 sanitizer 收紧后仍需保留 directional sanitizer contract 与真机 drag smoke，因为透明窗口合成不能完全由 Node DOM stub 覆盖。
6. 按 `src/renderer.js` 的既有实证注释，同 URL 的 object load 可能复用 SVG document/animation timeline；对无限 drag loop 跳过 `_t=` 因而可能复用已解析/解码资源，是真实存在的廉价缓解手段。但 left/right 当前仍是两个 URL，首次换向与 distinct media element commit 风险仍在，且依赖缓存复用不能成为 correctness 保证；若要尝试，作为独立性能实验，不并入 #620 主修复。

---

*本文档只定义 #620 中 Codex Pet 持续拖动换向的空帧修复。低功耗 idle 暂停是已确认的预期行为，不进入代码修改。*
