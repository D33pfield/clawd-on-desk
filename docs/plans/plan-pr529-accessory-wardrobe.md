# 计划：PR #529 配饰衣柜核心

> 状态：草稿 v2（已完成首轮独立交叉审查；仅计划，暂无配饰功能代码）
> 日期：2026-07-23
> 来源：PR #529
> 基线：`origin/main` @ `b8a0e50`（PR #728 宠物颜色滤镜已合并）
> 计划分支：`feat/pr529-accessory-wardrobe`
> 目标 PR：配饰衣柜核心（原拆分方案中的 PR B）

---

## 1. 结论

配饰继续作为独立 PR 落地，但不再复用 PR #529 把 `<image>` 注入宠物 SVG 的实现。

本 PR 只提供手动选择配饰的衣柜核心：

- 内置 7 件配饰与“无”；
- 按主题分别保存选择；
- 入口只在 `Settings -> Theme -> 对应桌宠 -> 装扮`；
- Clawd 与 Cloudling 在满足技术 spike 门槛后启用；
- Calico 明确不启用，不显示“装扮”入口；
- 配饰是宠物媒体元素的兄弟层，不能被宠物颜色滤镜染色；
- 不改变当前 SVG `<object>` / `<img>` 通道选择。

本 PR 不包含：

- 应季自动换装；
- 测试通过/失败反应；
- 花费统计；
- tray / 桌宠右键菜单里的配饰入口；
- Calico 配饰；
- 扩大宠物窗口、改变 hitbox 或修改窗口/原生空间的气泡 dodge。

应季换装继续作为后续独立 PR，依赖本 PR 提供的 catalog、持久化和渲染能力。

---

## 2. 已核实的当前基线

### 2.1 Git 与范围

- PR #728 已以 merge commit `b8a0e50` 合入 `main`。
- 当前颜色选择是 per-theme 的 `petTint` 映射，缺失键表示原色。
- 颜色入口只在 Theme 卡片的“装扮”详情页；tray / 右键菜单没有颜色入口。
- `supportsThemeCustomization()` 当前只检查 `capabilities.petTint`。
- Calico 声明 `customization.petTint: false`，因此当前没有“装扮”按钮。

### 2.2 当前 renderer DOM

当前结构为：

```text
#pet-clip
  #pet-container
    object#clawd / img#clawd.clawd-img
```

当前职责：

- `#pet-clip`：多显示器 seam clip，保持在屏幕空间，不能被翻转；
- `#pet-container`：拖拽 cursor、左侧 mini 的 `scaleX(-1)`；
- 宠物媒体元素：素材缩放、素材方向镜像、颜色 filter；
- 无专门的配饰层。

当前 synthetic roam bob 由：

```css
#pet-container.roam-walk #clawd
```

直接在媒体元素上写 `transform: translateX(...)`。素材方向镜像也会在媒体元素上写 `style.transform = "scaleX(-1)"`。两者今天靠状态互斥避免冲突，不应把新的配饰定位继续叠进同一个 transform 字符串。

### 2.3 当前颜色滤镜边界

颜色 filter 已经只施加到宠物媒体元素，而不是 `#pet-container`。但当前查询仍是：

```js
container.querySelectorAll("object, img.clawd-img")
```

`object` 没有 class 限定。配饰实现必须：

1. 给宠物 `<object>` 增加专用 class；
2. 把媒体查询收窄为宠物媒体 class；
3. 配饰统一使用自己的 `<img>` class；
4. 确保 swap 清理、fade 清理和 tint 遍历都不会命中配饰。

### 2.4 三个内置主题的素材事实

按 `theme.json` 中真正作为值引用的唯一图像文件统计：

| 主题 | 素材格式 | 配饰结论 |
|---|---:|---|
| Clawd | 36 个 SVG | 目标支持；需覆盖 normal / mini / reaction / roam 文件 |
| Cloudling | 27 个 SVG + 1 个 PNG | 目标支持；scripted SVG 可做动态跟随，PNG 走显式静态锚点 |
| Calico | 26 个 APNG + 1 个 SVG | 本轮不支持；产品决定为不显示装扮入口 |

Cloudling SVG 内的可跟随 group id 并不统一：不同文件分别出现 `cloud-group`、`eye-group`、`body-js`、`eyes-js` 等。不能使用 `[id^="eye"]` 或按 DOM 顺序猜测节点。

当前有效 viewBox 口径也不同：

- Clawd 只有根 viewBox `-15 -25 45 45`，没有 `fileViewBoxes` 或独立 mini viewBox；
- Cloudling 的根 viewBox 是 `-32 -24 88 72`，mini viewBox 是 `-12 -12 48 48`，`cloudling-mini-crabwalk.svg` 另有一个等于根 viewBox 的 file override；
- Calico 只有根 viewBox `0 0 266 200`，但本轮不声明配饰能力。

### 2.5 PR #529 原实现中可保留与不可保留的内容

可评估复用：

- `assets/accessories/` 下 7 个静态像素 SVG；
- 配饰名称与五语翻译的语义；
- 原作者对产品方向的贡献。

必须重写：

- `findEyesEl()` 的宽泛 selector；
- `getBBox()` 猜头部位置；
- Clawd 坐标硬编码 fallback；
- 往宠物 SVG document 注入 `<image>`；
- 配饰开启时强制 object channel；
- 全局字符串 `accessory` 偏好；
- tray / 右键菜单入口；
- renderer 内的整点 seasonal timer。

原实现的确定性问题包括：

- Cloudling 会先命中 `linearGradient#eye-grad`，不是眼睛图形；
- 无锚点主题会退回 Clawd 的坐标与尺度；
- 配饰只覆盖 object SVG，reaction / `<img>` / APNG 会丢失；
- 清除配饰后可能滞留在 object channel；
- filter 落在整个宠物 `<object>` 时，注入其中的帽子也会被染色。

---

## 3. 产品契约

以下是本 PR 的合并级契约，不是可选建议。

### 3.1 入口与主题行为

1. Theme 卡片只要支持颜色或配饰任一能力，就显示“装扮”按钮。
2. 点击未激活主题的“装扮”，沿用 PR #728 的 controller 命令先切换主题，再直接打开详情。
3. 详情页只渲染该主题支持的行：
   - Clawd：颜色 + 配饰；
   - Cloudling：颜色 + 配饰；
   - Calico：两项都不支持，因此没有“装扮”按钮，也不能进入空详情页。
4. tray、桌宠右键菜单和 General 页不新增配饰项。

### 3.2 选择与持久化

新增偏好使用明确名称 `petAccessory`：

```js
{
  clawd: "cowboy-hat",
  cloudling: "halo"
}
```

规则：

- map key 是安全 theme id；
- value 只能是 catalog 中的具体配饰 id；
- 缺失键表示 `none`；
- 内存与落盘都不保存 `{ themeId: "none" }`；
- 默认值是新的空对象；
- 选择按主题独立保存；
- 不接受路径、URL、任意 SVG 文件名或 CSS；
- 不为未合并的 PR #529 全局 `accessory` 字段建立产品迁移承诺。

### 3.3 Catalog

`src/pet-customization-catalog.js` 继续作为唯一 catalog，新增：

```text
none
cowboy-hat
party-hat
wizard-hat
top-hat
santa-hat
pumpkin-hat
halo
```

每个具体条目包含：

- 稳定 id；
- i18n label key；
- 固定的内置 SVG basename；
- intrinsic viewBox / aspect ratio；
- 全局的宽度比例与垂直微调。

Settings IPC 只返回 UI 必需的 `{ id, labelKey }`，不把资源路径或 renderer placement 数据暴露给 settings renderer。

`seasonal` 不进入本 PR 的 catalog。后续应季 PR 用单独的“stored meta choice -> effective concrete id”解析层接入，不能让 renderer 自己读日历。

---

## 4. 主题配饰能力与 attachment 合约

### 4.1 能力声明

`theme.json` 的 `customization` 扩展为：

```json
{
  "customization": {
    "petTint": true,
    "accessories": {
      "default": {
        "staticFrame": { "cx": 7.5, "baseY": 6.5, "width": 16 }
      },
      "files": {
        "clawd-idle-follow.svg": {
          "staticFrame": { "cx": 7.5, "baseY": 6.5, "width": 16 },
          "followTarget": {
            "id": "body-js",
            "frame": { "cx": 7.5, "baseY": 6.5, "width": 16 }
          }
        }
      }
    }
  }
}
```

规范：

- `default.staticFrame` 只表示主题根 viewBox 坐标下的默认 frame；
- 主题有 `miniMode.viewBox` 时，可用独立的 `mini.staticFrame` 表示 mini viewBox 坐标；不能把 root default 直接当成 mini coverage；
- `fileViewBoxes` 中出现的每个文件都必须在 `files` 中显式给出 `staticFrame`，即使该 override 数值碰巧等于根 viewBox；
- 同一 basename 如果在不同状态下会解析到多个不同 viewBox，v1 attachment schema 不允许只用一个 file descriptor：主题必须用 `fileViewBoxes` 把它统一到一个有效 viewBox，否则 capability 为 false；
- `staticFrame` 使用该文件/usage 最终解析出的有效 viewBox 坐标；
- `followTarget.frame` 使用目标元素的局部坐标；
- `followTarget.id` 必须通过 `getElementById()` 精确查找；
- 禁止 CSS selector、前缀匹配、class 猜测和 `getBBox()` 猜锚点；
- file key 必须是安全 basename；
- file descriptor 必须是完整对象，不做隐式深层拼接；
- `default` / `mini` 只提供静态 frame；动态 target 必须按文件显式声明；
- 某文件没有动态 target 时仍可用该文件明确解析到的 static frame；
- 不能退回 renderer 内置的“Clawd 默认头部坐标”。

数值边界不是“有限即可”：

- 对 static frame：`0 < width <= 4 * viewBox.width`；
- `cx` 必须落在 `[viewBox.x - viewBox.width, viewBox.x + 2 * viewBox.width]`；
- `baseY` 必须落在 `[viewBox.y - viewBox.height, viewBox.y + 2 * viewBox.height]`；
- follow-target 局部坐标无法用根 viewBox 约束，因此还需绝对上限：`abs(cx/baseY) <= 1_000_000`、`0 < width <= 1_000_000`；
- renderer 投影后再次校验 finite，并拒绝宽/高超过 stage 四倍或完全落在 stage 外一整个宽/高以上的结果。

### 4.2 完整覆盖

能力 `capabilities.accessories` 不是简单读取一个 boolean，而是规范化后的结果：

1. `customization.accessories` 形状合法；
2. 主题所有可达 normal / mini / reaction / idle-pool / display-hint 视觉 usage 都能解析到 static frame；
3. 每个 descriptor 都通过数值和 basename 校验。

任何一项不满足，整个主题的 `capabilities.accessories` 为 false，Settings 不显示配饰行。不能在运行到某个状态时才突然发现没有锚点。

coverage 不能只使用 `collectRequiredAssetFiles()` 得到的去重 basename 集合，因为它会丢失 state family 与有效 viewBox。实现需要一个规范化 usage projection，至少保留：

```text
{ stateFamily, file, effectiveViewBox }
```

`collectRequiredAssetFiles()` 仍用于资源全集对账；attachment coverage 用 usage projection 判定 root default、mini default 或 file descriptor 是否真正适用。

`buildCapabilities()` 当前有两个调用口径：

- `theme-metadata.js` 对 raw theme 调用，供 Settings 列表使用；
- `theme-loader.js` 对 `mergeDefaults()` 后的 normalized theme 调用，供运行时使用。

accessory capability 必须由同一个纯 `deriveAccessoryCapability()` 对 canonical projection 计算；不得分别实现 raw/normalized 分支。测试对同一主题同时断言 metadata capability 与 runtime capability 完全一致，避免 Settings 显示配饰但 renderer 判不支持，或反过来。

Clawd 与 Cloudling 的内置配置必须由测试枚举全部可达 usage 并断言 coverage。Calico 显式保持 false / omitted。

### 4.3 外部主题

attachment 元数据本身只包含 basename、id 和有限数字，不授予脚本执行或文件访问能力，因此可以允许外部主题声明同一安全结构。

外部主题仍遵守：

- SVG 继续走现有 sanitizer；
- `trustedRuntime` 仍然只对 loader 判定的内置主题生效；
- 配饰文件只能来自应用内置 catalog，主题不能提供任意配饰 URL；
- 配置无效或 coverage 不完整时安静降级为不支持配饰。

同步更新：

- `themes/template/theme.json`；
- `docs/guides/guide-theme-creation.md`；
- theme schema / metadata / loader 测试。

---

## 5. Renderer 分层

### 5.1 目标 DOM

本 PR 建立以下层级：

```text
#pet-clip                         seam clip，永不翻转
  #pet-container                  cursor / 状态 class，不直接写 visual transform
    #pet-facing-stage             左侧 mini 的屏幕方向翻转
      #pet-motion-stage           synthetic roam bob
        #pet-asset-direction-stage 主题素材方向镜像（mini / roam heading）
          #pet-media-layer        current / pending / fading pet media
          #pet-accessory-layer    单个持久配饰 img
    #pet-effect-stage             为后续反应保留独立效果边界
      #pet-particle-layer
```

职责硬约束：

- `#pet-facing-stage`、`#pet-motion-stage`、`#pet-asset-direction-stage`、`#pet-media-layer`、`#pet-accessory-layer`、`#pet-effect-stage`、`#pet-particle-layer` 全部使用 `position: absolute; inset: 0; width: 100%; height: 100%`；
- `#pet-media-layer` 必须成为 `#clawd` 的最近 containing block，保证现有 `left: -45%`、`width: 190%` 等百分比始终相对于一个与 `#pet-container` 等尺寸的 box 计算；
- 所有 visual stage 的 `transform-origin` 固定为 `50% 50%`，inactive 时 individual transform 使用 `none`，不能用 `translate: 0` / `scale: 1` 冒充 none；
- `#pet-facing-stage` 只处理屏幕边缘方向；
- `#pet-motion-stage` 的 bob 使用 CSS individual `translate`；
- `#pet-asset-direction-stage` 的方向镜像使用 CSS individual `scale`；
- 禁止上述职责共同拼写 `style.transform` 字符串；
- 宠物媒体缩放仍由现有 objectScale 宽高/位置逻辑负责；
- 配饰与宠物共享 facing、bob、asset-direction，因此 mini / roam 镜像时方向一致；
- 配饰不进入媒体 filter；
- effect / particle 不依赖配饰 pref 或 catalog。

CSS individual `translate` / `scale` 的非 `none` 值同样会建立 containing block 和 stacking context，因此“所有 stage 满尺寸 + media layer 是最近 containing block”是正确性要求，不只是样式偏好。

现有：

```css
#pet-container.roam-walk #clawd { animation: roam-walk-bob ... }
@keyframes roam-walk-bob { 50% { transform: translateX(3px); } }
```

必须同步改为：

```css
#pet-container.roam-walk #pet-motion-stage { animation: roam-walk-bob ... }
@keyframes roam-walk-bob {
  0%, 100% { translate: none; }
  50% { translate: 3px 0; }
}
```

零点帧使用 `translate: none`，不能继续在 keyframe 中写 `transform`。

`#pet-effect-stage` / `#pet-particle-layer` 在本 PR 明确保留，作为后续独立 test-reaction PR 的依赖边界；本 PR 中它们必须为空、无 animation、无 timer/listener，且 transform/translate/scale 均为 none。结构测试需证明这两个空层不改变 mini、roam 或宠物媒体定位。

### 5.2 媒体 selector 收窄

统一使用明确 class：

```text
object.clawd-object
img.clawd-img
img.clawd-accessory
```

所有以下逻辑只能选择前两者：

- tint；
- swap 清理；
- fade-out 清理；
- 可见媒体检测；
- object/img release；
- pending/current 媒体遍历。

配饰层只由 accessory runtime 管理，不能被 state swap 当成旧媒体删除。

收窄必须同步覆盖以下现有点位：

1. `src/index.html` 的静态占位 `<object id="clawd">` 增加 `clawd-object`；
2. `swapToFile()` 动态创建 object 时，在 append/tint 前增加同一 class；
3. `getPetMediaElements()` 改为 `object.clawd-object, img.clawd-img`；
4. object-channel 与 img-channel swap commit 中的两处旧媒体内联查询使用同一 selector；
5. `applyPetTintToElement()` 再做一次 class allowlist 防御，不能仅凭 `tagName` 接受任意 sibling object/img。

### 5.3 Dodge、窗口边界与 hitbox

编辑气泡 dodge 位于窗口/原生空间，不是 DOM transform 功能。配饰 PR 不修改：

- 宠物窗口 bounds；
- hit window bounds；
- hitbox；
- macOS SkyLight de-delegation；
- permission / update bubble 的 overlap 算法。

帽子必须留在当前透明窗口内。高帽和光环的主要人工风险是顶边视觉裁剪；优先调整 attachment frame 和配饰 scale，不通过扩大窗口解决。

---

## 6. 配饰渲染与定位

### 6.1 独立持久层

renderer 只维护一个 `img.clawd-accessory`：

- `pointer-events: none`；
- 固定从 `assets/accessories/` 加载 catalog 资源；
- 选择 `none` 或主题不支持时移除/隐藏；
- 状态切换不重建 catalog 状态，只更新定位；
- theme reload 时先按新 capability 重新解析，不能沿用旧主题锚点；
- 不注入宠物 SVG document；
- 不改变 `needsObjectChannel()`。

### 6.2 Main 到 renderer 的 payload

main 从 store + active theme + catalog 解析一个最小 payload，例如：

```js
{
  id: "cowboy-hat",
  assetFile: "cowboy-hat.svg",
  aspect: 16 / 7,
  widthScale: 1,
  offsetY: 0
}
```

renderer 再做防御性校验：

- id / basename 只允许小写字母、数字和短横线；
- `assetFile` 必须是无路径分隔符的 `.svg` basename；
- aspect / scale / offset 必须是有限且有界的数字；
- 非法 payload 收敛为 `none`；
- 资源 URL 只能从固定的 `../assets/accessories/` 根构造。

以下两条路径都要携带已解析 payload：

1. `buildRendererThemeConfig()`，保证首个可见帧已经带帽子；
2. settings effect / `syncRendererStateAfterLoad()`，保证运行时切换和 renderer crash reload 收敛。

不能先显示无帽状态、再等 IPC 补帽子。

### 6.3 静态定位

所有支持配饰的文件都必须有 static frame。纯 helper 负责：

1. 取当前文件的实际 viewBox（含 `fileViewBoxes` / `miniMode.viewBox`）；
2. 取媒体元素在 `#pet-asset-direction-stage` 内的实际 CSS box；
3. 按 SVG `xMidYMid meet` 映射 viewBox frame 到 stage 坐标；
4. 根据 catalog aspect / widthScale / offsetY 生成帽子矩形与 matrix。

Phase 1 只支持已由 spike 验证的 `xMidYMid meet`。若外部主题素材使用其他 `preserveAspectRatio`，其配饰 capability 必须关闭或在未来单独扩展，不能猜。

### 6.4 动态跟随

本节在 Phase 0 回填前是设计意图，不是已验证算法。当前仓库没有任何 `getCTM()` / `getScreenCTM()` 实现可供复用；只有访问 `<object>.contentDocument` 和精确 `getElementById()` 的现有能力。

只有 spike 证明 CTM 方案成立后，当当前媒体是可访问 contentDocument 的 `<object>` 且该文件声明 `followTarget`，才按以下方向实现：

1. 用 `contentDocument.getElementById(targetId)` 精确获取目标；
2. 使用 spike 选定的 `getCTM()` 或 `getScreenCTM()` 路径；
3. 将 target-local frame 通过完整 affine matrix 投影到 accessory stage；
4. 帽子继承平移、缩放、旋转和斜切；
5. 仅在动态目标存在且媒体可见时使用一个 `requestAnimationFrame` 跟随循环；
6. matrix 未产生可见变化时不重复写 style；
7. media swap、theme reload、renderer hidden / destroyed 时立即取消循环。

若 target 或 CTM 暂时不可用：

- 使用该文件已经显式声明的 static frame；
- 同一文件只记录一次诊断；
- 不搜索其他“像眼睛”的节点；
- 不使用其他主题的坐标。

### 6.5 状态切换

- current media 正式 swap commit 前，配饰继续跟随旧 current；
- commit 后原子切换到新文件 descriptor；
- fade-out 媒体不能重新抢回配饰 anchor；
- click / drag reaction 即使 `state` 为空，也按 `currentDisplayedSvg` 的 basename 解析；
- `<img>` SVG、PNG、APNG 统一走 static frame；
- mini / roam 镜像由共同 stage 处理，不在坐标 helper 中手工反号；
- viewport offset、窗口 resize、mini edge 变化和 roam heading 变化后重新计算。

---

## 7. Phase 0：非合并技术 spike

正式实现前先做一个可丢弃 spike，验证 Chromium/Electron 中的坐标投影。spike 结果回填到本文档后才开始生产实现。

### 7.1 必测样本

Clawd：

- idle follow（object + eye tracking）；
- working；
- click reaction；
- drag reaction；
- mini-idle；
- mini 左/右边缘；
- roam 左/右方向；
- wizard hat 与 halo 的顶边裁剪。

Cloudling：

- idle scripted SVG；
- typing / working；
- reaction；
- mini-idle；
- mini crabwalk；
- low-power PNG override；
- vaporwave / matcha tint 下帽子保持原色。

### 7.2 Spike 必须回答

1. `target.getCTM()` / `getScreenCTM()` 在嵌套 `<object>` 中哪个能稳定映射到外层 stage？
2. CSS animation / SVG script transform 是否实时体现在所选 CTM 中？
3. objectScale、viewBox、mini viewBox 与 `xMidYMid meet` 的投影是否吻合？
4. 外层 facing / motion / asset-direction stage 变换后，帽子是否仍与目标一致？
5. rAF 跟随在 idle 静置时的 CPU 是否可接受，能否在无变化时避免 style churn？
6. static frame 在 `<img>` reaction 与 Cloudling PNG fallback 上是否达到可接受观感？
7. root default、mini default 与 file override 是否按 effective viewBox 正确分流；同 basename 多 viewBox usage 是否被拒绝而不是误判 coverage？
8. 所有 full-size stage 在 translate/scale 开关前后是否保持 `#clawd` containing block、百分比定位和 `50% 50%` 翻转中心完全不变？
9. 空的 effect/particle 层是否保持 identity，不产生 layout、stacking、命中或动画副作用？

### 7.3 Stop gate

- 禁止为了让 spike “看起来能用”而恢复 DOM selector heuristics。
- §6.4 的 CTM 投影在 Q1/Q2 通过前不得进入生产实现。
- Q7/Q8 任一失败时先修 attachment schema / stage CSS，不得靠逐状态像素补丁掩盖。
- Clawd 与 Cloudling 都通过上述矩阵，才进入完整实现。
- 若 Cloudling 无法稳定跟随，暂停并让产品重新决定；不能静默把它标为支持。
- Calico 不参与 spike，也不能因为 Clawd/Cloudling 成功而顺带开启。

---

## 8. Settings 与 IPC

### 8.1 Settings UI

在 Theme 详情的 `themeAppearanceTitle` section 中：

- 保留颜色 row；
- 新增配饰 row；
- 两行分别按 capability 渲染；
- 配饰使用与颜色一致的原生 `<select>` 交互；
- `none` 选项恢复不佩戴；
- pending 时禁用 select；
- 写入失败时回到 store snapshot 并显示 toast；
- 不在 UI 内直接 mutation snapshot。

`supportsThemeCustomization(theme)` 改为：

```text
capabilities.petTint || capabilities.accessories
```

五语补齐：

- en
- zh
- zh-TW
- ko
- ja

### 8.2 IPC

新增只读：

```text
settings:get-pet-accessory-options
```

新增 renderer 事件：

```text
pet-accessory-change
```

写入仍走现有唯一链路：

```text
Settings renderer
  -> settings:update
  -> settings controller
  -> immutable store
  -> settings effect router
  -> main 解析 active theme + catalog
  -> render window IPC
```

不能从 Settings 或 menu 绕开 controller，也不新增第二套 accessory 状态真相。

---

## 9. 资源与打包

### 9.1 资源导入

从 PR #529 逐个审计后导入：

```text
assets/accessories/cowboy-hat.svg
assets/accessories/party-hat.svg
assets/accessories/wizard-hat.svg
assets/accessories/top-hat.svg
assets/accessories/santa-hat.svg
assets/accessories/pumpkin-hat.svg
assets/accessories/halo.svg
```

资源审计测试至少拒绝：

- `<script>`；
- `<foreignObject>`；
- 事件 handler 属性；
- 外部 `href` / URL；
- 资源目录以外的路径。

### 9.2 electron-builder

`package.json` 同时加入：

```text
build.files:      assets/accessories/**/*
build.asarUnpack: assets/accessories/**/*
```

`test/package-build-config.test.js` 必须断言两处都存在。打包验证不能只检查 JSON；至少做一次 packaged directory / 安装包 smoke，确认 file URL 实际能加载 SVG。

---

## 10. 实施顺序

### Phase 0：Spike

1. 在隔离实验代码中建立最小 sibling accessory layer。
2. 验证 CTM、viewBox、outer transforms 和 rAF 成本。
3. 盘点 Clawd / Cloudling 每个可达文件的 static frame 与可选 follow target。
4. 把结论与不能动态跟随的文件清单回填本文档。
5. 删除实验代码或整理为可审查的第一批纯 helper。

### Phase 1：数据与 schema

6. 扩展 accessory catalog。
7. 新增 `petAccessory` prefs map、normalizer 与 settings validator。
8. 扩展 theme schema、metadata、loader normalization 与 capability。
9. 为 Clawd / Cloudling 填完整 attachment 数据；Calico 保持 false。
10. 更新 template 与主题作者指南。

### Phase 2：Renderer 分层

11. 引入 facing / motion / asset-direction / media / accessory / effect 层。
12. 将 mini-left、roam bob、asset mirror 迁到各自层。
13. 收窄 pet media selector，并保持 tint / fade / swap 行为不变。
14. 提取纯 `pet-accessory-layout` helper，实现 static 与 CTM 投影。
15. 实现 persistent accessory runtime 和生命周期清理。

### Phase 3：主进程与 Settings

16. 接通 main payload resolve、startup config、theme reload 与 settings effect。
17. 增加 preload IPC。
18. 在 Theme 详情增加 capability-gated 配饰 row。
19. 补五语文案。

### Phase 4：打包、测试与人工 QA

20. 导入 7 个 SVG，补 builder files / asarUnpack。
21. 跑定向测试、全量测试和 `verify:electron`。
22. Windows 实机按 §12 完整走查。
23. macOS/Linux 使用构建 + code-review-first，记录尚未真机覆盖的风险。

---

## 11. 自动化测试

至少新增或扩展：

| 测试 | 必测内容 |
|---|---|
| `pet-customization-catalog.test.js` | id 唯一、资源 basename 安全、UI 输出不泄露路径、未知 id -> none |
| `prefs.test.js` | 默认空 map、per-theme 保存、none 删除、非法 id/theme id 清理、引用隔离 |
| `settings-actions.test.js` | 只接受安全具体 id，不接受 none/path/URL/数组/字符串 |
| `theme-schema.test.js` | capability 主逻辑、usage/effective-viewBox coverage、具体数值边界、safe basename/target id、同 basename 多 viewBox 拒绝 |
| `theme-metadata.test.js` | raw metadata capability 与 canonical projection 一致，只测试透传/双口径一致性 |
| `theme-loader.test.js` | normalized runtime capability 与 metadata 一致；内置/外部主题规范化；外部主题不能提供任意资源 URL |
| `theme-context.test.js` | renderer config 只收到规范化 attachment 数据 |
| `settings-ipc.test.js` | options IPC 只返回 `{id,labelKey}` |
| `settings-effect-router.test.js` | pref 变化解析 active theme 后发送 payload；不支持主题发送 none |
| `settings-renderer-browser-env.test.js` | 按 capability 显示行、inactive theme 流程、pending/rollback、Calico 无入口 |
| `pet-accessory-layout.test.js` | viewBox meet 映射、matrix 投影、mini/file viewBox、有限数防线 |
| renderer accessory 测试 | 首帧、swap commit、reaction state 为空、fade ownership、timer/rAF cleanup、selector 隔离 |
| renderer DOM/CSS 结构测试 | 全 stage 满尺寸、固定 transform-origin、media containing block、roam keyframe 使用 individual translate、空 effect/particle 保持 identity |
| `package-build-config.test.js` | files + asarUnpack |
| accessory asset audit | 7 个文件存在且不含脚本/外链/事件属性 |
| i18n 测试 | 五语 key 齐全 |

回归必须覆盖：

- PR #728 pet tint 全部测试；
- object 与 img 两通道；
- low-power pause；
- theme fade sequencer；
- mini mode；
- roam；
- renderer crash reload；
- package build config。

合并前命令：

```bash
npm test
npm run verify:electron
```

并执行一次 Windows packaged smoke。

---

## 12. Windows 实机 QA

### 12.1 Settings

- Clawd / Cloudling 卡片始终有“装扮”；
- Calico 没有“装扮”；
- 点击未激活主题的“装扮”会先切换再打开详情；
- Clawd 与 Cloudling 各自记住不同帽子；
- `none` 恢复无帽；
- 重开 Settings 后选择仍正确；
- tray / 桌宠右键菜单没有配饰入口。

### 12.2 Clawd

逐件快速检查 7 个配饰，重点用 wizard hat / halo 测顶边：

- idle；
- thinking / working；
- click reaction；
- drag reaction；
- sleeping / DND；
- mini 左边缘；
- mini 右边缘；
- roam 向左；
- roam 向右；
- state fade；
- renderer reload；
- 应用彻底退出后重启，首帧不能先闪无帽。

### 12.3 Cloudling

同样检查：

- idle scripted motion；
- typing / working；
- reaction；
- mini idle / peek / crabwalk；
- low-power static PNG；
- theme reload；
- 应用重启首帧。

### 12.4 与颜色组合

Clawd、Cloudling 分别组合：

- 原色 + 帽子；
- 任一强 filter + 帽子；
- Cloudling vaporwave；
- Cloudling matcha。

验收点：

- 宠物颜色改变；
- 帽子保持 catalog 原色；
- fade 中旧/新宠物媒体都不把 filter 传给帽子；
- 左右翻转时帽子方向与角色一致；
- bob / scripted motion 中帽子不漂浮。

### 12.5 Calico

- 不能打开装扮详情；
- 切到 Calico 时不显示上一主题帽子；
- 切回 Clawd / Cloudling 时恢复该主题保存的帽子。

---

## 13. 合并标准

以下全部满足才可转 Ready：

1. Phase 0 spike 已回填，Clawd 与 Cloudling 均通过。
2. 无 selector heuristic、无 Clawd 全局 fallback。
3. 所有可达 usage 按 effective viewBox 通过 attachment coverage 测试。
4. raw metadata 与 normalized runtime 的 accessory capability 完全一致。
5. full-size stage、media containing block、翻转中心和 individual transform 约束均通过结构/实机验证。
6. accessory 不改变 object/img channel。
7. accessory 永远不被 pet tint 命中。
8. reaction、mini、roam、sleep、fade、reload 和首帧均通过。
9. Calico 没有入口且不会泄漏上一主题帽子。
10. 没有 tray / 右键入口。
11. 无 seasonal / test reaction / cost tracker 回流。
12. 全量测试、Electron 验证、Windows 实机和 packaged asset smoke 通过。

---

## 14. 依赖、回滚与后续

依赖图：

```text
PR #728 pet tint（已合并）
  -> 本 PR：accessory wardrobe core
       -> seasonal accessory（后续）
       -> test-result reactions（后续只复用 effect/particle 层）
```

回滚规则：

- pet tint 可独立保留；
- seasonal 与 test reaction 若已合并，应先回滚它们，再回滚本 PR；
- 回滚配饰不得破坏 PR #728 的颜色详情页与 per-theme `petTint`。

后续 seasonal PR 才负责：

- `seasonal` stored meta choice；
- 本地日期纯函数解析；
- 下一个本地午夜 + 缓冲的调度；
- resume、时区/时钟变化、theme reload 主动重算；
- effective concrete id 与 stored meta id 分离。

---

## 15. 原 PR 回流禁清单

实现时禁止整段复制 PR #529。重点禁止：

- renderer 内 `ACCESSORY_ASSETS` 与 Settings/menu/prefs 多份 enum；
- `findEyesEl()`；
- `[id^="eye"]` / `[class*="eye"]`；
- `getBBox()` 锚点猜测；
- `DEFAULT_HEAD_ANCHOR`；
- SVG document 内 `<image id="clawd-acc">` 注入；
- accessory 强制 object channel；
- renderer 内 `setInterval()` seasonal 轮询；
- menu `ACCESSORIES`；
- cost tracker、test-result reaction 及其 prefs/i18n/effect 代码。

如果从原 PR 复用 7 个素材或设计贡献，相关提交继续保留：

```text
Co-authored-by: anthonyonazure <anthonyonazure@users.noreply.github.com>
```

PR 正文链接并致谢 #529。

---

## 16. 预计文件边界

可能新增：

```text
assets/accessories/*.svg
src/pet-accessory-layout.js
test/pet-accessory-layout.test.js
test/renderer-accessory.test.js
test/accessory-assets.test.js
```

预计修改：

```text
package.json
src/index.html
src/styles.css
src/renderer.js
src/preload.js
src/main.js
src/pet-customization-catalog.js
src/prefs.js
src/settings-actions.js
src/settings-effect-router.js
src/settings-ipc.js
src/preload-settings.js
src/settings-ui-core.js
src/settings-tab-theme.js
src/settings-i18n.js
src/theme-schema.js
src/theme-metadata.js
src/theme-context.js
themes/clawd/theme.json
themes/cloudling/theme.json
themes/calico/theme.json
themes/template/theme.json
docs/guides/guide-theme-creation.md
对应 test/*.test.js
```

不应修改：

```text
src/menu.js
hooks/*
src/server*
成本统计相关文件
测试结果检测相关文件
```

---

*本文档只定义配饰衣柜核心的实现与验收边界。Phase 0 spike 结论回填并经独立复核前，不开始生产实现。*
