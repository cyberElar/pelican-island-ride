# Pelican Island Ride · 移动端适配与可访问性修复报告

> 前置审计（只读）结论见本轮审计：移动端无法驾驶、8px 页边距、暂停后输入死锁、小屏重叠、
> reduced-motion 不生效、读屏信息缺失等。本文件记录**实际改动**：问题 → 改法 → 文件:行 → 验证证据，
> 以及仍需主会话在 `src/main.js` 里加的接线代码。

## 0. 交付与验证方式

**改动范围（严格遵守约定）**

| 文件 | 状态 | 行数 |
| --- | --- | --- |
| `src/ui/touch.js` | 新建：虚拟摇杆 + 油门/刹车 + 动作按钮 | 493 |
| `src/ui/styles.css` | 页面基线重置 / 安全区 / 小屏+横屏布局 / 触控样式 / 对比度与字号 / UI 缩放 | 2958 |
| `src/ui/hud.js` | live region、progressbar、字幕、HUD 帮助按钮、小地图形状、碰撞文字 | 1550 |
| `src/ui/menus.js` | 体验设置分组（屏震/舒适视角/减少运动/自动镜头/字幕/UI 缩放）、焦点循环、设置总线 | 1055 |
| `src/gameplay/camera.js` | 运动舒适度读取设置（shake / 速度 FOV / 第一人称颠簸 / 自动镜头） | 434 |
| `index.html` | viewport（可缩放 + `viewport-fit=cover`）、theme-color、启动进度 aria | 129 |
| `tools/dev/test-mobile.mjs` | 新建（jsdom，107 项断言） | 518 |
| `tools/dev/test-all.mjs` | 只加一行测试项 | 43 |

未改动：`src/main.js`、`src/world/**`、`src/core/**`（`src/core/input.js` 仅只读参考）。
构建产物 `dist/game.js`、`dist/index.html`、`dist/styles.css` 由 `node tools/build.mjs` 重新生成（截图验证需要）。

**验证手段（全部实测）**

1. `npm test`：11 套测试全绿（含新增 mobile 套件）。
2. 无头 Edge（SwiftShader）+ iPhone UA：375×667 / 667×375 / 1440×810 三种视口，注入真实
   `src/ui/touch.js`，用 CDP 触摸事件驱动，读取 `input.axes`、`state.player.speed/heading`、DOM 矩形与重叠。
3. 截图：`.scratch/fix-mobile-portrait.png`、`.scratch/fix-mobile-landscape.png`、
   `.scratch/fix-photo-mode.png`、`.scratch/fix-mobile-pause.png`、
   `.scratch/mobile-portrait.png`、`.scratch/mobile-landscape.png`、`.scratch/desktop.png`。
4. 原始测量数据：`.scratch/fix-mobile-measurements.json`。

---

## 1. 逐条修复

### P0-1 手机完全不能驾驶 → 新增 `src/ui/touch.js`

- **改法**：新模块 `createTouchControls(input, ctx)` → `{ root, update(dt,state), setVisible(v), destroy() }`。
  - 左半屏浮动摇杆：`pointerdown` 落点即原点（`setPointerCapture`，`touch-action: none`），
    拖拽偏移经死区（0.14 半径）+ smoothstep 写入 `input.setTouchAxes({ steer })`；幽灵环显示落点，
    摇杆头显示偏转，松手回中（释放阻尼 ×1.8，避免残留转向）。
    实现：`src/ui/touch.js:212`（`setStick`）、`:257`/`:264`（zone 指针事件）、`:279`（全局 pointerup 兜底）、`:416`（`update` 阻尼）。
  - 右下踏板/刹车：原生 `<button>`（96px / 82px，远大于 WCAG 2.2 的 24px 目标尺寸），
    每指针独立 id → 多点触控可同时转向 + 加速；短按保留 0.65s 短推（`src/ui/touch.js:192 pressGo`）。
  - 动作按钮 7 个（视角/地图/拍照/暂停/操作/车铃/计时赛）复用 `input.touchButton(action, down)`，
    与键盘共用 `pressed()` 路径（`src/ui/touch.js:323 fireAction`）。
  - 桌面不显示：判定只看 `(pointer: coarse)` 与 `navigator.maxTouchPoints`（`src/ui/touch.js:94`），
    并保留「首次真实 touch 指针即显形」的兜底（`:369 onFirstTouch`）。
  - 暂停 / 拍照 / 标题界面自动停用：`.is-idle` / `.is-off` / `.is-photo`（`src/ui/touch.js:416-426`）。
- **验证（无头 Edge，CDP 触摸）**：
  - 按住踏板 1.5s：`axes.throttle 0 → 1`，`state.player.speed 0 → 1.445 → 4.898 m/s`；松手后归零。
  - 摇杆右拖：`stick 0.959 → axes.steer 0.798`，`heading 1.342 → 1.2396`；松手并等 3 帧后
    `axes.steer = 0`、`stick = 0`（事件序列 `pointerdown:3@90 → pointermove:3@150 → pointerup:3@150`）。
  - 触控板「暂停」：`state.paused = true`、暂停面板出现、触控板转 `.is-idle`。
  - 桌面 1440×810：`padExists=true` 但 `body.pi-has-touch=false`，摇杆/踏板矩形全为 0（不显示）。

### P0-2 8px body 边距 → 全视口横竖滚动条、HUD 与画布错位

- **改法**：`src/ui/styles.css:54-95` 新增页面基线：
  `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#070a12;overscroll-behavior:none}`、
  `#ui-root{position:fixed;inset:0;overflow:hidden;pointer-events:none}`、
  `#game-canvas{display:block;position:absolute;inset:0;touch-action:none}`。
- **验证**（`.scratch/fix-mobile-measurements.json`）：

| 视口 | scrollWidth × scrollHeight | 滚动条 | body margin | #ui-root |
| --- | --- | --- | --- | --- |
| 375×667 | 375 × 667 | 无 / 无 | 0px | fixed |
| 667×375 | 667 × 375 | 无 / 无 | 0px | fixed |
| 1440×810 | 1440 × 810 | 无 / 无 | 0px | fixed |

  修复前同一测量：1448×830、383×687、675×395（均同时出现横竖滚动条）。

### P0-3 暂停 →「回到标题」→ 再开始后输入死锁

- **menus 侧已完成**：`show()` 支持回到 `'none'`（`src/ui/menus.js:934`），
  Esc 关闭面板、Tab 在面板内循环（`src/ui/menus.js:951`），暂停卡文案改为「按 Esc 或点按「继续」」（`src/ui/menus.js:574`），
  帮助面板可从 HUD/触控板打开并在关闭后回到骑行（`src/ui/menus.js:1008` 订阅 `ui:help`）。
- **仍需 main.js（不在写入范围）**：第 2 节第 5 条，两处各加 `input.enabled = true;`。
- **验证**：jsdom 覆盖 `show('pause') → ui:help → show('none')` 往返与焦点循环；输入复位本身只能等 main.js 落地后复测。

### P0-4 小屏/横屏 HUD 重叠与溢出

- **改法**（`src/ui/styles.css`）：
  - ≤820px：toast 从压住速度表改为顶部第 2 行（`top:236px`，`width:min(206px,55vw)`）；
    拍照提示胶囊不再 `nowrap` 居中，改为 `left:6vw; right:calc(6vw + 84px)` 给网格按钮让位。
  - ≤480px 竖屏（`src/ui/styles.css:2124`）：标题页内边距压缩、toast `min(184px,50vw)`、字幕条上移。
  - `@media (orientation: landscape) and (max-height: 560px)`（`src/ui/styles.css:2171`）：
    计时赛改成横向三格条（检查点/用时/最佳），小地图 88px，速度表 132×96，动作按钮排到顶部一行。
    修复前该列底部 404 > 视口 375，并与速度表重叠 140×122px。
  - 安全区：`--pi-safe-t/r/b/l: env(safe-area-inset-*)`（`src/ui/styles.css:47`），
    HUD 四角、罗盘、toast、触控板全部叠加 `var(--pi-safe-*)`。
- **验证**（触控板 + 小地图 + 计时赛同屏）：

| 视口 | 真实重叠 | 溢出视口 | 关键矩形（x,y,w,h） |
| --- | --- | --- | --- |
| 375×667 | 无（仅父子包含 pad ⊃ go/brake） | 无 | 摇杆 20,513,134,134；踏板区 171,421,188,96；动作列 10,329,40,178；速度表 187,533,168,122 |
| 667×375 | 无（仅父子包含） | 无 | 计时赛条 485,199,168,46；速度表 521,273,132,96；动作行 186,90,294,36 |
| 竖屏拍照 | 无 | 无 | 摇杆/踏板隐藏；动作列 323,8,42,186；拍照提示 22,583,246,34 与网格按钮 283,584,70,33 不再相交 |

### P1-1 viewport / 缩放 / 安全区 / 双击缩放

- **改法**：`index.html:5-8` 去掉 `maximum-scale=1, user-scalable=no`，改为
  `width=device-width, initial-scale=1, viewport-fit=cover`，并加 `theme-color`/`color-scheme`；
  `src/ui/styles.css:75` 使用 `touch-action: manipulation`（禁双击缩放、保留捏合缩放，符合 WCAG 1.4.4）。
- **验证**：测试断言 `touch-action: manipulation` 与 `env(safe-area-inset-top` 存在；
  截图显示内容不再留 8px 白边、刘海区不再贴边。

### P1-2 `prefers-reduced-motion` 真正进入 3D

- **改法**（`src/gameplay/camera.js`）：
  - `:19` `SHAKE_SCALE {off:0, low:0.35, medium:0.7, high:1}`；`:31 applyMotionSettings`；
    `:73` 订阅 `settings:changed`；`:41-66` 启动先读存档，无存档则跟随系统
    `matchMedia('(prefers-reduced-motion: reduce)')`。
  - 生效点：`:80 shakeFactor`（reduceMotion → 0，comfortFov ×0.6）→ `addShake`；
    `:87 speedFovGain` → 追逐 `:302` / 第一人称 `:324` 的速度 FOV；
    `:310` 第一人称颠簸（0 / 0.008 / 0.028）；`:196` 自动镜头（`flyby()` 直接返回，不再劫持镜头）。
  - 设置项：`src/ui/menus.js:659` 起「体验 COMFORT & ACCESS」，默认值跟随系统（`src/ui/menus.js:169-179`）。
- **验证**：jsdom 断言 reduceMotion 下 `shakeFactor === 0`、`flyby()` 后 `mode` 仍为 `chase`、
  速度 FOV 变化 < 4.5°；`shakeIntensity: high` 时 shake 位移 spread = 23.5（确实在抖）。

### P1-3 屏幕阅读器与语义

- **改法**（`src/ui/hud.js`）：
  - 动态数值：羽毛数 `:328`、已探索 `:320`、检查点 `:357` 加 `aria-live="polite" aria-atomic="true"`；
    计时表 `:361` 用 `role="timer"`（12Hz 跳动的时钟挂 live 会淹没读屏，改为检查点/完赛播报）。
  - 加载进度：`:438` `role="progressbar"` + `aria-valuenow/valuetext`（`setLoading` 内同步）；
    启动遮罩同样处理（`index.html:24` + `index.html:105` 的 MutationObserver 镜像 `aria-valuenow`）。
  - 事件播报：隐藏 live 区 `:434 pi-sr-status` + `announce()` `:1031`；toast 容器 `role="log" aria-live="polite"` `:429`；
    发现卡 `role="status"` `:399`、完赛横幅 `:394`。
  - 语义：罗盘刻度条 `aria-hidden`、小地图 canvas `role="img"` + 标签、速度表/计时赛/拍照覆盖 `role="group"`；
    暂停时 `#pi-hud` 置 `aria-hidden="true"`（`:1236`）。
- **验证**：jsdom 断言全部属性到位，`aria-valuenow` 0 → 42 随进度更新。

### P1-4 设置回读与持久化

- **改法**：`menus.setSettings()` 改为带通知（`src/ui/menus.js:1041`），启动时
  `main.js` 已有的 `menus.setSettings(saved)` 会把整份存档经 `settings:changed` 广播给
  HUD（语言/字幕/UI 缩放，`src/ui/hud.js:1465` 起）与相机（`src/gameplay/camera.js:73`）；
  `uiScale` 落到 CSS 变量 `--pi-ui-scale`（`src/ui/styles.css:1647`）。
- **验证**：jsdom 断言 `menus.setSettings({captions:false,language:'en'})` 发出 `settings:changed`；
  HUD 收到后隐藏字幕并切语言；相机收到后 `shakeFactor` 立刻为 0。
- **新字段与 main.js 白名单**：见第 3 节。

### P1-5 小字对比度与字号

- **改法**：新增 `--pi-ink-mute: rgba(34,32,28,0.68)`（`src/ui/styles.css:25`）与
  `--pi-poppy-deep:#a93a2b`（`:35`），把 8.5–9.5px 小标签统一替换
  （`:156, 253, 417, 488, 553, 611, 631, 674, 1106, 1459, 1554, 1761, 1797`），
  字号上调为 10–11px；拍照提示/读数胶囊底色 0.42 → 0.66 / 0.72；焦点圈 1px → 2px。
- **估算对比度**：见第 4 节（HUD 小标签 2.71 → 5.28，poppy 小字 3.36 → 5.51，拍照胶囊 2.52 → 5.00）。

### P1-6 音频 → 文字（字幕/提示）

- **改法**：`src/ui/hud.js:150 SFX_CAPTIONS`（bell/splash/crash/pickup/discovery/firework/thunder/balloon/checkpoint）
  在总线 `sfx` 上显示底部字幕胶囊（`:1042 showCaption`）并播报（`:1031 announce`）；
  设置项「字幕/提示」可关闭（`setCaptions :1538`）。碰撞除红色闪屏外直接出「碰撞 · CRASH」（`:432`、`flashDamage :1297`）。
- **验证**：jsdom 断言 `bus.emit('sfx',{name:'bell'})` 后字幕含 `BELL` 且 `is-on`；关闭后保持隐藏。

### P1-7 不靠颜色区分

- **小地图**：`src/ui/hud.js:163 POI_SHAPES` + `:823 tracePoiShape` —— 灯塔/礼拜堂 ▲、村庄/港口 ■、
  风车/磨坊 ◆、岩峰/遗迹 ○（已发现=实心 + 内圈，未发现=空心同形状）；图例改成 `▲ 地标 / ● 你`。
- **碰撞**：红色闪屏 + 文字标（`:432`）。
- **游戏内帮助**：HUD 左上「？ 操作」按钮（`:335`，点击 emit `ui:help`）→ menus 打开操作面板（`src/ui/menus.js:1008`），
  修掉了「`KeyH` 映射后无人消费、游戏里看不到按键表」的问题。

### P1-8 测试

- **改法**：新增 `tools/dev/test-mobile.mjs`（518 行 / 107 项断言 / 8 个分组），在 `tools/dev/test-all.mjs:24` 注册。
- **覆盖**：触控挂载与桌面隐藏、首次触摸显形、死区与回中、多指不抢夺、油门锁存、刹车、
  动作按钮与 `ui:help`、暂停/拍照/标题自动失活、`destroy()` 清理（含 window 监听）、
  `styles.css` 基线/安全区/横竖屏/触控样式断言、menus 舒适默认值与 `settings:changed`、
  HUD live region/progressbar/字幕、camera 的 reduceMotion / shakeIntensity / comfortFov。

---

## 2. 需要你在 `src/main.js` 里加的接线（原样可抄）

```js
// 1) 顶部导入（和 createHUD / createMenus 放一起）
import { createTouchControls } from './ui/touch.js';

// 2) 创建：紧跟 hud = createHUD(...) 之后（模块会自己 append 到 uiRoot）
const touch = createTouchControls(input, { container: uiRoot, bus, window, document });

// 3) 每帧更新：放在 loop() 里 hud.update(...) 之后。
//    与 hud 一样「暂停也要跑」——模块内部会按 state.paused / photoMode / started / input.enabled
//    自行决定是否吃掉输入并把轴向清零。
try {
  touch.update(dt, state);
} catch (err) {
  console.error('[pelican] touch update failed', err);
}

// 4) （可选）截图/演示时强制隐藏虚拟手柄
// touch.setVisible(false);

// 5) P0-3 的输入死锁修复：onStart() 与 onQuitToTitle() 里各加一行
input.enabled = true;

// 6) （可选）想让相机立刻用上存档里的舒适设置（正常情况下 menus.setSettings 已会自动广播）
// modules.camera?.applyMotionSettings?.(saved);
```

说明：`createTouchControls` 只依赖 `input.setTouchAxes / touchButton / enabled`；
不传 `container` 时不会自动挂载（`root` 仍返回，可自行 append）；模块不会修改 `state` 或 `input.enabled`，
唯一的全局副作用是在 `body` 上切换 `pi-has-touch`（供 CSS 把底部左侧相机 chip 让给摇杆）。

---

## 3. 需要加进 `sanitizeSettings`（`src/main.js:350`）白名单的字段

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `shakeIntensity` | `'off' \| 'low' \| 'medium' \| 'high'` | 系统 reduce-motion ? `off` : `medium` | 屏震强度（0/低/中/高） |
| `comfortFov` | boolean | 跟随 reduce-motion | 舒适视角：收窄速度 FOV 与第一人称颠簸 |
| `reduceMotion` | boolean | 跟随 `prefers-reduced-motion` | 关闭抖动 / FOV 推进 / 自动镜头 |
| `autoCinematic` | boolean | `!reduceMotion` | 关闭后地标发现与静止时的自动运镜不再抢占镜头 |
| `captions` | boolean | `true` | 音效字幕 + 读屏播报 |
| `uiScale` | number `0.85 – 1.35` | `1` | 界面缩放（写入 `--pi-ui-scale`） |

建议插入到 `sanitizeSettings` 中：

```js
    const SHAKE_LEVELS = ['off', 'low', 'medium', 'high'];
    if (typeof raw.shakeIntensity === 'string' && SHAKE_LEVELS.includes(raw.shakeIntensity)) out.shakeIntensity = raw.shakeIntensity;
    if (typeof raw.comfortFov === 'boolean') out.comfortFov = raw.comfortFov;
    if (typeof raw.reduceMotion === 'boolean') out.reduceMotion = raw.reduceMotion;
    if (typeof raw.autoCinematic === 'boolean') out.autoCinematic = raw.autoCinematic;
    if (typeof raw.captions === 'boolean') out.captions = raw.captions;
    if (typeof raw.uiScale === 'number' && isFinite(raw.uiScale)) out.uiScale = Math.max(0.85, Math.min(1.35, raw.uiScale));
```

`saveSettings` 复用同一个 `sanitizeSettings`，不加入白名单这些开关会「改完即丢」。

---

## 4. 对比度估算（改前 → 改后；均为估算）

估算方法：纯色按 WCAG 2.x 相对亮度公式；半透明色先按 alpha 与假设背景合成再计算
（面板取 0.90 alpha 米色玻璃，背景取明亮海天 `#cfe0ea` 与中性场景 `#5d6f7a`；
拍照胶囊背景取浪花 `#eaf3f7`）。游戏内背景随时间变化，因此这是**估算值**。

| 元素 | 改前 | 改后 | 结论 |
| --- | --- | --- | --- |
| HUD 小标签（羽毛/相机/单位/计时赛键名，10–11px） | 2.65 – 2.71:1 | 5.04 – 5.28:1 | ≥4.5 ✅ |
| 罗盘小刻度标签 | 2.69:1 | 5.0:1 以上 | ≥4.5 ✅ |
| 「新纪录」等 poppy 小字 | 3.36:1 | 5.51:1 | ≥4.5 ✅ |
| 危险按钮中文（回到标题） | 3.36:1 | 5.40:1 | ≥4.5 ✅ |
| 拍照提示胶囊（亮水面/浪花上） | 2.52:1 | 5.00:1 | ≥4.5 ✅ |
| 拍照读数（含 11px 模式行） | ≈3.8:1 | 5.6:1（底色 0.72） | ≥4.5 ✅ |
| 加载遮罩品牌行 / 进度元数据 | 4.52 / — | 8.12 / 9.24:1 | ✅ |
| 主按钮（米色 on 墨色） | 14.45:1 | 14.45:1 | 未改动，本来就达标 |

---

## 5. 实测数据摘要

**`npm test`（本次运行）**

```
PASS  engine       0.9s  ALL ENGINE TESTS PASSED
PASS  layout       0.2s  ALL LAYOUT TESTS PASSED
PASS  character    0.2s  ALL CHARACTER TESTS PASSED
PASS  vegetation   5.6s  ALL VEGETATION TESTS PASSED
PASS  props        0.2s  ALL PROPS TESTS PASSED
PASS  landmarks    0.2s  ALL LANDMARKS TESTS PASSED
PASS  life         0.2s  ALL LIFE TESTS PASSED
PASS  audio        0.1s  ALL AUDIO TESTS PASSED
PASS  ui           4.6s  ALL UI TESTS PASSED
PASS  gameplay     5.2s  gameplay PASSED
PASS  mobile       1.9s  ALL MOBILE TESTS PASSED

npm test: all 11 suites passed
```

**触控交互（无头 Edge + CDP 触摸事件，iPhone UA，375×667）**

| 动作 | 结果 |
| --- | --- |
| 按住「加速」1.5s | `axes.throttle = 1`；`speed 0 → 1.445 → 4.898 m/s` |
| 松手（短按锁存） | 锁存期内 `throttle > 0`，随后归 0 |
| 左半屏按下右拖 | `stick 0.959 → axes.steer 0.798`；`heading 1.342 → 1.2396` |
| 松手后（等 3 帧） | `axes.steer = 0`、`stick = 0`（pointerdown→move→up 全在 zone） |
| 触控板「暂停」 | `paused = true`、暂停面板出现、触控板 `.is-idle` |
| 控制台错误 | 0 |

**布局**：三视口均无滚动条、无溢出、无真实重叠（仅容器与子按钮的包含关系）；
完整矩形与重叠清单见 `.scratch/fix-mobile-measurements.json`。

**复现命令**

```powershell
node tools/build.mjs                                    # 生成 dist/（截图用）
npm test                                               # 11 套（含 mobile）
node tools/dev/shot.mjs --size 375x667 --out .scratch/mobile-portrait.png
node tools/dev/shot.mjs --size 667x375 --out .scratch/mobile-landscape.png
```

（`shot.mjs` 启动浏览器需要 `sandbox_permissions: "require_escalated"`；截图里会出现一条既有的
three.js 着色器编译 warning，与本次改动无关。）

---

## 6. 遗留问题与建议

1. **`input.touchHeld('boost' / 'brakeHard')` 没有消费者**：`src/gameplay/controls.js` 的
   `wantBoost` 与硬刹只读 `input.held(...)`（键盘集合），所以触控板没有提供「冲刺 / 硬刹」按钮。
   若要补齐（`src/gameplay/controls.js`，不在本轮写入范围）：
   ```js
   const wantBoost = !crashed && (input.held('boost') || input.touchHeld('boost')) && p.boostStamina > 0.02 && throttle > 0.05;
   if (input.held('brakeHard') || input.touchHeld('brakeHard')) a -= sgn * 9.0;
   ```
   随后在 `src/ui/touch.js` 里对两个新按钮调用 `bindHoldButton(btn, () => input.touchButton('boost', true), () => input.touchButton('boost', false))` 即可。
2. **iOS Safari 未真机验证**：拍照模式拖动看视角依赖 `PointerEvent.movementX/movementY`
   （Chromium 触屏实测可用：`mx=12, my=-4`）。若 iOS 上为 0，可在 `src/core/input.js:91 onPointerMove`
   加「上一帧 clientX/Y 差值」的兜底。
3. **首次引导每次刷新都显示**：触控板提示条约 7 秒（`.pi-touch__hint`）；要「只显示一次」，
   在 `src/ui/touch.js:389 syncVisibility` 里接 `sessionStorage` 即可。
4. **UI 缩放只覆盖文本与主要控件**：HUD 面板的固定像素尺寸（速度表 218×158、小地图 180）不随缩放变化，
   130% 时面板会偏紧；若要整体缩放，需要给面板宽高也乘 `var(--pi-ui-scale)`。
5. **`--pi-ink-45` 仍保留**给指针、虚线、hairline 等非文本用途；不要再用它写小于 14px 的正文。
6. **4K/超宽**：`engine.js` 的像素预算（另一路已加）限制了渲染分辨率，但 HUD 面板仍是固定像素，
   在 3840 宽屏上偏小；后续可给 `--pi-r-hud` 与面板尺寸加超宽断点。
7. **`menus.setSettings()` 现在会广播**：启动同步会多走一遍 `onSettingsChange`（重复 setQuality、再存一次档；
   幂等、无副作用，已被测试覆盖）。若要避免，可改成显式参数 `menus.setSettings(saved, { notify: true })`。


