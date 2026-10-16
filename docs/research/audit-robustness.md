# Pelican Island Ride · 技术健壮性审计（只读）

## 0. 审计范围与方法

- 项目：`D:\projects\vibecoding_tool_box\pelican-island-ride`（three.js r186，esbuild → IIFE，程序化生成，根目录 `index.html` + `game.js` + `styles.css` 即发布产物）
- 基线：git HEAD `3301739417f8c2dda27b6620cfa136076dc5d670`（2026-10-15，`feat: Pelican Island Ride - a procedural three.js cycling showcase`）
- 工作树说明：审计期间工作树里存在由**另一次会话**新增的未跟踪文件（`.github/workflows/ci.yml`、`SECURITY.md`、`tools/dev/check-*.mjs`、`tools/dev/audit-*.mjs`、`docs/research/data/bundle.json` 等）。这些文件不是本次审计对象，仅在"工具链已存在什么"时被引用。
- 只读声明：本次审计**没有修改 `src/` 下任何文件**；唯一的写操作是本报告文件本身。
- 方法：全量通读指定文件 + 全仓 grep 交叉验证（事件订阅者、监听器、dispose、localStorage、rAF/定时器、能力探测），并用 `node_modules/three` r186 源码核对 three 侧行为（上下文恢复、RenderTarget.setSize、EffectComposer 像素比、WebGL2 强依赖）。
- 未做：没有在浏览器里实际运行游戏，没有实测显存占用 / 真机上下文丢失。凡属推算的结论均标注"（推算）"，凡无法静态确认的标注"待验证"。

---

## 1. 十一个维度逐条结论

| # | 维度 | 结论 | 证据 | 缺口 / 备注 |
|---|---|---|---|---|
| 1a | WebGL 上下文丢失 | 不完整 | `src/core/engine.js:156-160` 监听 lost：`preventDefault()` + `engine.stop()` + `bus.emit('context:lost')`；`src/core/engine.js:161-164` 监听 restored：`bus.emit('context:restored')` 并 `engine.start(updateFn)`；three 侧自适应恢复见 `node_modules/three/src/renderers/WebGLRenderer.js:1113-1142` | `context:lost` / `context:restored` 在全仓**没有任何订阅者**（grep：只 emit、无 `on(`/`listen(`）：无用户提示、无恢复失败兜底；丢失期间音频不停 |
| 1b | WebGL2 不可用时的降级/提示 | 不完整 | `src/core/engine.js:19-27` 直接 `new THREE.WebGLRenderer`；r186 WebGL2 强依赖并在失败时 throw（`node_modules/three/src/renderers/WebGLRenderer.js:407-424`）；`src/main.js:484-489` 捕获后写 `#boot-label` = `启动失败: <message>`，`window.__pelican` 置 `error` | 有"不白屏 + 一行可读文字"，但文案是英文技术串、无操作指引；**没有** `canvas.getContext('webgl2')` 之类前置探测（grep `webgl2` 在 src 内 0 命中），无低画质/无 3D 的降级路径 |
| 1c | GL 能力探测 | 不完整 | `src/core/textures.js:405` `Math.min(8, renderer.capabilities.getMaxAnisotropy())`（唯一的探测） | 未探测 `capabilities.maxTextureSize`（ultra 的 `shadowMapSize: 4096`，`src/core/settings.js:110`）；未探测 half-float 可渲染性（`EffectComposer` 默认 `HalfFloatType`，`node_modules/three/examples/jsm/postprocessing/EffectComposer.js:69`）；`QUALITY_PRESETS.anisotropy`（`src/core/settings.js:33,62,91,120`）**无任何读取方** → 死配置，且低画质也被强制 8x |
| 2 | 运行时错误防护 | 不完整 | `src/main.js:176-190` 每个模块工厂单独 try/catch；`src/main.js:435-439` 每个模块 update 单独 try/catch；`src/main.js:484-489` boot 级 catch（保留 boot overlay 并写错误） | 无 `window.onerror` / `unhandledrejection`（全仓 0 命中）；模块失败的 `bus.emit('ui:toast')`（`src/main.js:189`）发生在 toast 监听器注册（`src/main.js:368`）**之前** → 提示丢失，用户看不到任何信息；`src/main.js:421-455` 的 `input.update()` / `handleActions()` / `post.setPhoto()` / `input.endFrame()` 不在 try 内 |
| 3 | 生命周期与资源释放 | 不完整（当前无重建路径） | `?seed=`/`?quality=` 仅在 boot 读取一次（`src/main.js:45-49`），页面内没有"重建世界"入口；已实现的 dispose：`src/world/environment.js:144-147`、`src/core/textures.js:1317-1322`（`disposeAll`） | 上述两个 dispose **都没有调用方**（grep 0 命中）；`src/main.js` 从不调用 `hud.destroy()` / `menus.destroy()` / `input.dispose()`；因此今天不存在"每次重建都 new 不释放"的现网泄漏，但一旦加入热重载/换种子/重开一局，geometry/material/texture/renderTarget 会成片泄漏；监听器当前无重复注册（`src/main.js:356-357` 用 `{once:true}`，其余在构造期注册一次） |
| 4 | 页面可见性 / 焦点 | 无（可见性）+ 有（blur） | blur：`src/core/input.js:55-59` `onBlur(){ held.clear(); }`；rAF 隐藏时由浏览器暂停（`src/core/engine.js:112-121`） | 全仓无 `visibilitychange` / `document.hidden`（0 命中）：后台不 `suspend()` 音频（`src/core/audio.js:1342-1349` 只有 `resumeIfSuspended`），音乐/海浪/车轮声会继续合成；`input.enabled=false` 只清 `held`（`src/core/input.js:83`），不清 `touchHeld`（手柄按钮）与 `dragging` |
| 5 | 窗口尺寸 / DPR | 有（基本可用），缺绝对预算 | `src/core/engine.js:88-90` resize + orientationchange（延迟 120 ms）；`src/core/engine.js:59,75` `pixelRatio = min(dpr, preset.pixelRatioCap)`；`src/core/engine.js:84` resize 时 `post.setSize`；three 的 `RenderTarget.setSize` 内部 `dispose()`（`node_modules/three/src/core/RenderTarget.js:365-398`）→ 旧 RT 不泄漏 | 无像素总量上限：4K 分辨率 100% 缩放（CSS 宽 3840）下 high = 5760×3240 ≈ 1866 万像素/RT，ultra = 7680×4320 ≈ 3318 万像素/RT（推算，见 P1-2）；`composer._pixelRatio` 只在构造/`setPixelRatio`/`reset` 更新（`EffectComposer.js:61,322-348`），`applySize` 从不调用它 → 跨不同 DPI 显示器拖窗后中间缓冲与绘制缓冲错配（待验证观感，见 P2-5） |
| 6 | 输入 | 不完整 | 键盘 repeat 已处理：`src/core/input.js:46` 只有 `!held.has(action)` 才入 `pressedSet`；手柄轮询：`src/core/input.js:104-118`；触屏：`src/core/input.js:87-89` | 手柄：只取第一个 pad（`break`，`input.js:116`）、死区固定 0.12（`input.js:109`）、只读 `axes[0]`/LT/RT/A、不检查 `pad.mapping`；**断连时 `touchHeld('brakeHard')` 永久残留**（`input.js:114-115` 的 `else` 在没有 pad 时永不执行）；指针锁在每次 canvas pointerdown 就请求（`input.js:70`）且无 `pointerlockchange` 同步；菜单态屏蔽只看 `paused`（`src/main.js:257`），标题页/设置页的按键仍会驱动自行车；`input.js:48` 对方向键无条件 `preventDefault()` → 菜单里 range 滑杆方向键失效 |
| 7 | 音频 | 有（防御式实现，能力失败不致命） | 手势内创建/恢复：`src/main.js:275-276`、`src/main.js:355-357` → `src/core/audio.js:1351-1392`（`init` 幂等 + `resumeIfSuspended`）；无 `AudioContext` 时全部静默降级（`audio.js:1360-1372`）；一次性音源都 `stop()`（`audio.js` 内 32 处 `.stop(`，21 处 `createOscillator`）→ 无节点堆积 | 没有 `suspend()/resume()` 生命周期（静音只用 masterGain 拉 0：`audio.js:1437`），后台不停声；静音状态持久化存在但见 P1-6（N 键不落盘） |
| 8 | 持久化 | 有 try/catch，缺版本与清档 | `src/main.js:303-315` load/save 都 try/catch；`src/gameplay/events.js:52-55,80` bestLap 读/写也 try/catch；字段级校验部分存在（`src/main.js:319-331`、`340-350`：quality 走白名单、音量/静音做 typeof 判断） | 无 `version` 字段、无 schema 校验；`events.js:54` `parseFloat` 结果未做 `Number.isFinite`（脏数据当"无成绩"，不清理）；无"清除进度"入口（`src/ui/menus.js:582-588` 只写了一句"最佳成绩保存在本机"）；菜单设置 UI 与存档不同步（P1-6） |
| 9 | 时序 / 帧率 | 有（clamp）+ 不完整（无固定步长） | dt 三处 clamp：`src/core/engine.js:116`（0..0.1）、`src/core/audio.js:1396`、`src/fx/post.js:252`；物理单步 Euler：`src/gameplay/controls.js:133,147`；阻尼全部是指数形式（`src/core/utils.js:42-44`）→ 144 Hz+ 行为正常 | 无固定步长/子步累积器；无帧率上限选项；低帧率穿透属于边界风险（`controls.js:149-168` 只做"移动后点测 + 圆推离"，单步最大位移 16.6 m/s × 0.1 s = 1.66 m，最小碰撞体 r=0.4 → `rr=0.84` 直径 1.68 m，见 P2-8） |
| 10 | 打包 / 部署 | 有（file:// 真能用） | IIFE 单文件（`tools/build.mjs:39-52`）；无 `fetch`/`XHR`/动态 `import()`（全仓 0 命中，工作树里另有 `tools/dev/check-no-network.mjs` 守这条）；`index.html:9,45` 只引用相对 `styles.css`/`game.js`；CSS 无 `http(s)://`、无 `@import`（0 命中）；无 CSP meta、无 `crossorigin`/`integrity`；`game.js` 与 `dist/game.js` sha256 一致（当前发布状态自洽） | `game.js` 无内容哈希、`index.html:45` 无 `?v=`，`tools/build.mjs:57-62` 直接覆盖根目录文件 → GitHub Pages 默认 `max-age=600` 级别缓存会让老用户短暂跑旧包（待验证；issue 模板里已要求"硬刷新"，说明这是已知痛点）；`dist/` 与根目录产物重复一份 1.2 MB |
| 11 | 代码质量 | 需重整 | 行数实测：`src/world/props.js` 2753、`src/world/landmarks.js` 2114、`src/world/vegetation.js` 1717、`src/world/animals.js` 1709、`src/core/audio.js` 1547、`src/ui/hud.js` 1356、`src/core/textures.js` 1325、`src/ui/menus.js` 880 | 重复模式：三份"合并零件几何"辅助（`src/character/pelican.js:121`、`src/world/animals.js:82`、`src/world/landmarks.js:103`）；孤儿事件：`player:reset`（2 发出 / 0 订阅）、`weather:rain`（0 订阅）、`photo:enter`/`photo:exit`（0 发出）、`engine:ready`（0 订阅）；`src/main.js:367` 空监听器；`engine.onResize`（`src/core/engine.js:140`）无消费者；SPEC 里的 `engine.clock`、`addUpdate`（`docs/SPEC.md:94-101`）未实现；魔法数遍地（`src/fx/weather.js:18-22`、`src/gameplay/controls.js:12-25`、`src/fx/post.js:20-164` 着色器常量）；测试盲区见 P2-13 |

---

## 2. 按严重度分组的问题清单

### P0

#### P0-1 模块构建失败对玩家完全不可见（且没有全局错误兜底）

- **证据**：`src/main.js:187-190`（模块工厂失败 → `console.error` + `bus.emit('ui:toast', …)`），对照 `src/main.js:367-368`（`ui:toast` 监听器在**模块循环之后**才注册，且 `src/main.js:160` 时 `hud` 早已可用）；`src/main.js:421-455`（循环里 `handleActions()` / `input.update()` / `post.setPhoto()` / `input.endFrame()` 均不在 try 内；暂停分支 `src/main.js:441-443` 的 `modules.hud?.update?.()` 也没有 try）；全局 grep：`src/` 内无 `window.onerror`、无 `unhandledrejection`。
- **影响**：任何模块工厂抛错都会静默降级成一个"缺内容的世界"（没树 / 没建筑 / 没光照 / 没天气），玩家看到的是"正常开局"；CI 截图与 `npm test` 都不会失败，问题只能靠人工看控制台发现。若异常发生在 `handleActions()` 等未托管区域，还会跳过 `input.endFrame()`，导致 `pressedSet` 残留 → 同一动作逐帧重复触发（例如暂停键连发），并在控制台每帧刷错。
- **建议修法**：① 在 `boot()` 里把总线接线抽成 `function wireBus()`，在**模块循环之前**调用，或失败分支直接调用 `hud?.toast?.('模块加载失败', entry.id)`；② 失败清单收集到 `window.__pelican.moduleErrors = []` 并在 boot 末尾若非空则显示常驻提示（`hud.setRace`/角标或 `menus.show('help')` 变体）；③ `loop()` 改成 `try { … } finally { input.endFrame(); }`，并把 `state.player.brake = input.axes.brake;` 之后的 `post.setPhoto(...)` 也纳入 try；④ 在 `index.html` 的 `<script src="game.js">` **之前**内联 10 行兜底：`window.addEventListener('error'|'unhandledrejection')` → 写入 `#boot-label` 并移除 `.is-done`（覆盖 `game.js` 自身解析失败/首帧异常这两类 boot() 捕不到的错）。

#### P0-2 WebGL 上下文丢失：无提示、无恢复失败兜底

- **证据**：`src/core/engine.js:156-164`（lost → `engine.stop()` + emit；restored → `engine.start(updateFn)`）；全仓 grep `context:lost` / `context:restored` 只有 emit，**0 个订阅者**（`hud.js`、`menus.js`、`main.js` 都没有处理）；`engine.stop()`（`src/core/engine.js:149-152`）之后若不触发 restored，没有任何超时/看门狗。
- **影响**：GPU 驱动重置、多标签争抢、移动端后台切换后画面会静止在一帧上，且屏幕没有任何解释；正常情况下 three 会自行重建 GL 资源（`node_modules/three/src/renderers/WebGLRenderer.js:1123-1142` 重新 `initGLContext()`）并被本引擎重新 `start()`，所以"能自愈"——但对玩家而言这是"游戏卡死"，只能刷新；自愈期间 HUD 数字、音频、计时赛全部停摆而无提示。
- **建议修法**：① `bus.on('context:lost', …)` → `hud.toast('图形上下文丢失，正在恢复…')` + 启动 8 s 看门狗（`setTimeout`），`context:restored` 到达时清除并 `hud.toast('已恢复')`；② 看门狗超时 → 复用 `#boot-overlay` 显示"请刷新页面"（`bootOverlay.classList.remove('is-done')` + 写 `#boot-label`）；③ restored 回调里补 `post.setSize(...)`（或干脆重建 `createPost`），并重置 `post.render` 的计时器状态，避免 PNG 式"恢复但画面全黑"；④ 在 `engine.js` 的 lost 处理里给 `engine` 打 `contextLost` 标记，让 `main.js` 的计时赛在丢失期间不计时。

### P1

#### P1-1 手柄断连 → 永久刹车（`brakeHard` 卡在 `touchHeld`）

- **证据**：`src/core/input.js:105-118` —— `for (const pad of pads) { if (!pad) continue; … if (pad.buttons[0]?.pressed) touchHeld.add('brakeHard'); else touchHeld.delete('brakeHard'); break; }`：`else` 分支只有在"存在一个可用 pad 且 A 未按下"时才执行；`enabled` setter（`src/core/input.js:83`）只 `held.clear()`；`dispose()`（`src/core/input.js:134-141`）也不清 `touchHeld`。消费方：`src/gameplay/controls.js:125`、`src/gameplay/camera.js:285`。
- **影响**：按住手柄 A（或拔线/断连瞬间 A 恰好按下）后，`brakeHard` 永久为真 → 自行车被持续施加 9 m/s² 减速，玩家感觉"车坏了/推不动"，只能刷新页面；同时 photo 模式的下降键也永久按下。
- **建议修法**：`input.update()` 内用局部 `let sawPad = false;`，循环中命中 pad 时置真，循环结束后 `if (!sawPad) touchHeld.delete('brakeHard');`；顺手把 `pads.length` 判空与 `pad.connected === false` 也当作"无 pad"；`enabled` setter 与 `dispose()` 统一调用一个 `resetAll()`（清 `held`/`pressedSet`/`touchHeld`/`touchAxes`/`dragging`/`pointer.down`）。

#### P1-2 超大帧缓冲：4K / 高 DPR 没有像素总量上限

- **证据**：`src/core/engine.js:59,75-79`（`pixelRatio = min(dpr, preset.pixelRatioCap)`，`renderer.setSize(w*renderScale, h*renderScale)` → 绘制缓冲 = CSS × scale × dpr）；`src/core/settings.js:76-133`（high：cap 1.5 / scale 1.0；ultra：cap 2.0 / scale 1.0）；`src/fx/post.js:174-215`（composer 双缓冲 + bloom mip 链 + SMAA + 深度 RT 全尺寸跟随）。
- **影响**（推算）：4K 面板 100% 缩放（`window.innerWidth = 3840`）→ high：绘制缓冲 5760×3240 ≈ 1866 万像素，composer 两张同尺寸 half-float RT；ultra：7680×4320 ≈ 3318 万像素。再叠加 bloom 的多级 mip 与 SMAA 的 3 张 RT，显存与填充率会直接压爆中低端 GPU，表现为掉帧 / 驱动 TDR / 标签页崩溃（`SECURITY.md` 把这一类"崩溃、标签页内存暴涨"明确列为在范围内的风险）。
- **建议修法**：在 `engine.applySize()` 里加绝对预算，例如 `const PIXEL_BUDGET = 6e6; const budgetScale = Math.min(1, Math.sqrt(PIXEL_BUDGET / (w * h * pr * pr))); const rw = Math.round(w * Math.min(sizes.scale, budgetScale));`，`setQuality()` 复用同一函数；把 ultra 的 `pixelRatioCap` 从 2.0 降到 1.5，并给 `detectQuality()`（`src/core/settings.js:137-149`）增加"窗口像素数 > 8e6 时降一档"的判定。

#### P1-3 没有 visibility 处理：后台继续出声、无暂停/恢复策略

- **证据**：全仓 grep `visibilitychange` / `document.hidden` = 0 命中；`src/core/audio.js:1342-1349` 只有 `resumeIfSuspended()`，全文件无 `.suspend(` 调用；`src/core/engine.js:112-121` 的 `frame()` 不看可见性；`src/main.js:427-429` 的时间推进只看 `paused/photoMode`。
- **影响**：切到后台后（rAF 被浏览器暂停）WebAudio 图仍在跑 → 音乐/海浪/车轮声继续播放，用户以为已经"关掉"，并持续耗电；回到前台时 `dt` 被 clamp 到 0.1（`src/core/engine.js:116`，物理安全），但游戏内时间被少算（昼夜/计时赛与真实停留时间不一致，待验证具体浏览器节流行为）。
- **建议修法**：① `src/main.js` 增加 `document.addEventListener('visibilitychange', onVisibility)`：隐藏时 `engine.stop()`、`modules.audio?.suspend?.()`（`audio.js` 内新增 `suspend()/resume()` 包装 `ac.suspend()`/`ac.resume()` 并记住 `muted`，同时把 `masterGain` 拉到 0 再恢复）、并对计时赛做冻结标记；显示时 `engine.start(loop)` + `audio.resume()`；② `audio.js` 的 `update()` 在 `ac.state === 'suspended'` 时直接返回，避免时间轴漂移；③ 给 `hud.setPaused` 之外加一个"后台中"角标可选。

#### P1-4 画质升级不生效：bloom / SMAA 在启动时被固化为 `null`

- **证据**：`src/fx/post.js:184-188`（只有 `preset.bloom` 为真才 `new UnrealBloomPass`）、`src/fx/post.js:201-205`（SMAA 同理）、`src/fx/post.js:317-326`（`setQuality()` 只做 `if (bloomPass) bloomPass.enabled = …`、`if (smaaPass) smaaPass.enabled = …`）；`src/world/terrain.js:398`、`src/world/ocean.js:340` 明确注释"运行时不重建"。
- **影响**：以 low/medium 启动（移动端 `detectQuality()` 默认 medium，`src/core/settings.js:141`）后，玩家在设置里切到"高 / 极高"，泛光与 SMAA **永远不会出现**，帧率却按新预设变化（雾密度、视距、采样数会变），"设置没生效"的观感很具体；反方向（高 → 低）能生效 → 语义不一致。
- **建议修法**：`post.setQuality(level)` 里做惰性增量：当 `p.bloom && !bloomPass` 时 `new UnrealBloomPass(new THREE.Vector2(w,h), p.bloomStrength, 0.55, 0.86)` 并 `composer.insertPass(bloomPass, gradeIndex)`（SMAA 同理，插在 `outputPass` 之后），同时在 `setSize()` 里给新建的 pass 调 `setSize`；若不想改结构，则在 `src/main.js` 的 `onSettingsChange` 里判断"需要重建的项（bloom/smaa/shadows/terrainSegments）"并要求刷新页面（`hud.toast('部分画质选项需刷新页面生效')`）。

#### P1-5 标题页/设置页期间世界仍在跑（按键驱动 + 昼夜计时）

- **证据**：`src/main.js:427-440` —— `frozen = state.paused`、`worldFrozen = state.photoMode || frozen`，只有这两者会跳过 `controls/rider/events/collectibles`，**不看 `menus.current` 也不看 `state.started`**；`src/gameplay/controls.js:81-199` 无条件把 `input.axes` 写进 `state.player`；`src/core/input.js:40` 初始 `enabled = true`；`src/ui/menus.js:821-840` 处理方向键时只 `preventDefault()`，没有 `stopPropagation()`，`src/core/input.js:43-50` 仍会记录 `throttle/left/right`。
- **影响**：标题页用方向键在菜单里导航时，自行车会同时加速/转向（开场巡游镜头里"车自己骑走了"）；设置页同理；`state.hour` 在菜单里继续推进（`src/main.js:429` + `src/gameplay/events.js:115-116`），玩家还没开始骑行昼夜已经走了一段。
- **建议修法**：① `loop()` 里把菜单纳入门控：`const menuOpen = menus.current !== 'none' && menus.current !== undefined;` 并在 `menuOpen || !state.started` 时把 `controls/rider/events/collectibles` 与 `state.timeScale` 一起冻结（`state.timeScale = 0` 已经由 `worldFrozen` 控制，扩到 `menuOpen` 即可）；② 更省事的做法：`controls.update()` 顶部加 `if (!state.started) { /* 只做地面吸附，忽略输入 */ }`；③ `menus.onKeyDown` 的 Escape/方向键分支加 `ev.stopPropagation()`，且 `input.onKeyDown` 首行加 `if (e.defaultPrevented) return;`。

#### P1-6 设置面板与存档不同步 + N 键静音不落盘

- **证据**：`src/main.js:152-158`（`createMenus(ctx, {...})` 没有传 settings，`ctx`（`src/main.js:122-127`）里也没有 `settings` 字段）、`src/ui/menus.js:135-148`（内部默认值 `quality:'high'`, `timeMode:'sunset'`, 音量 0.8/0.55/0.85，并在 `env.settings` 缺失时使用这些默认值）、`src/main.js:337-352`（启动时把存档恢复到引擎/音频，但从不调用 `menus.setSettings`，而该 API 存在于 `src/ui/menus.js:866`）、`src/main.js:402-406`（N 键只改 `state.muted` + `audio.setMuted`，不 `saveSettings`）。
- **影响**：老玩家二次进入时设置面板显示默认值（画质显示"高"但实际可能是 ultra；静音按钮未选中但游戏是静音的；音量滑杆与真实音量不一致）→ 一旦改动任意一项，`saveSettings(patch)` 只写 patch 本身，但 UI 与实际继续背离，用户难以判断哪个是真的；N 键静音在刷新后丢失。
- **建议修法**：① `boot()` 里 `const saved = loadSettings()` 之后调用 `menus.setSettings(saved || { quality, timeMode, … })`，并把 `saved` 放进 `ctx.settings`（`menus.js:144-148` 已支持）；② N 键分支补 `saveSettings({ muted: state.muted })` + `menus.setSettings({ muted: state.muted })`；③ `onSettingsChange` 里统一在末尾调用 `menus.setSettings(patch)`（`syncSettingsUI()` 会跟着刷新）。

#### P1-7 帧循环里存在非托管区（一次异常会污染输入状态）

- **证据**：`src/main.js:421-455`：`input.update()`、`handleActions()`、`state.player.brake = input.axes.brake;`、`post.setPhoto(...)`、`input.endFrame()` 都不在 try 内（只有 `modules[id].update()` 有 try）；`src/core/engine.js:112-121` 的 `frame()` 先 `requestAnimationFrame(frame)` 再 `updateFn(dt)`，所以异常不会终止循环，而是每帧刷错误。
- **影响**：`handleActions()`（内部会调用 `modules.camera?.setMode`、`hud.toggleMinimap`、`modules.events?.startRace`、`bus.emit`）一旦抛错，`input.endFrame()` 被跳过 → `pressedSet` 残留 → 同一按键在每个后续帧都被判定为"刚按下"，可能出现暂停/铃铛/时间切换等动作的连续触发；错误本身也没有用户可见反馈。
- **建议修法**：`function loop(dt) { try { … } catch (err) { console.error('[pelican] frame failed', err); } finally { input.endFrame(); } }`；并给 `state.player.brake = input.axes.brake` 这类兜底语句加上 `?? 0`，避免 `input.axes` 被上游破坏后出现 NaN 传播。

### P2

#### P2-1 「重置视角」按钮是空操作

- **证据**：`src/ui/menus.js:282-296`（`resetView()` 优先 `bus.emit('player:reset', {})` 然后 `flashNote('视角已重置')` 并 `return`）、`src/gameplay/controls.js:78`（另一处 emit），全仓 grep：`player:reset` 有 **2 个发出方、0 个订阅方**；对照可用的 R 键路径 `src/main.js:399`（直接 `modules.controls?.reset?.(state)`）。
- **影响**：设置页里点「重置视角」只弹一句"视角已重置"，实际什么也没发生（相机与单车位置都不变），属于对玩家说谎的交互。
- **建议修法**：在 `main.js` 的总线接线里补 `bus.on('player:reset', () => modules.controls?.reset?.(state))`；或在 `menus` 的 `resetView()` 里改为回调 `options.onResetView`（由 main.js 传给菜单），并让文案与实际行为绑定。

#### P2-2 罗盘永远停在 000°

- **证据**：`src/main.js:81` 初始化 `state.compassHeading = 0` 后无人写入；`src/gameplay/camera.js:158` 写的是 `state.camera.compassHeading`；`src/ui/hud.js:947-950` 读 `state.compassHeading`；`hud.setCompassHeading`（`src/ui/hud.js:1025`）在 `main.js` 里也没有调用点。
- **影响**：HUD 罗盘刻度盘与读数在下线不提速，骑行中永远指向 0°，与玩家实际朝向无关；小地图的朝向是好的（`src/ui/hud.js:856` 用 `player.heading`），两处不一致更显眼。
- **建议修法**：`camera.update()` 末尾补 `state.compassHeading = state.camera.compassHeading;`（或让 `hud.update()` 回退读取 `state.camera.compassHeading`）；两者取其一，避免双写。

#### P2-3 方向键无法调节音量滑杆（无障碍问题）

- **证据**：`src/core/input.js:48` `if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();`（在动作映射命中的分支里无条件执行，且不检查 `enabled`、不检查 `event.target`）；`src/ui/menus.js:824-827` 明确写了"let the slider keep its arrow keys"的意图。
- **影响**：键盘用户聚焦到「总音量/音乐/音效」滑杆后，方向键被 window 级监听吞掉 → 滑杆不动（菜单自己的注释承诺与之冲突）；同理，暂停菜单打开时（`input.enabled=false`）依然会被 `preventDefault`，因为该处理不看 `enabled`。
- **建议修法**：`input.onKeyDown` 首行加 `const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;`，并把 `preventDefault` 包在 `if (enabled) { … }` 内（`enabled` 目前只在 getter 层生效，监听器层没有）。

#### P2-4 设置/帮助页按 Esc 会直接继续游戏

- **证据**：`src/ui/menus.js:814-819`（Esc → `show(returnTo)`，只 `preventDefault()`）、`src/main.js:385-389`（`input.pressed('pause')` → `togglePause(!state.paused)`）——同一次 keydown 冒泡会依次触发两者（root 先于 window），且 `input.onKeyDown` 不检查 `event.defaultPrevented`。
- **影响**：从暂停菜单进入设置后按 Esc，本意是"退回暂停菜单"（代码也是这么写的），实际立刻恢复骑行并关掉菜单（`src/main.js:259` 的 `menus.show('none')`），玩家会突然发现自己已经在骑车。
- **建议修法**：`menus.onKeyDown` 的 Escape 分支加 `ev.stopPropagation()`；或全局统一在 `input.onKeyDown` 里 `if (e.defaultPrevented) return;`（同时解决 P2-3 的一半问题）。

#### P2-5 DPR 变化后 composer 与绘制缓冲错配

- **证据**：`node_modules/three/examples/jsm/postprocessing/EffectComposer.js:61`（构造时快照 `_pixelRatio = renderer.getPixelRatio()`）、`:322-348`（`setSize` 使用 `_pixelRatio`，只有 `setPixelRatio()`/`reset()` 会更新它）；`src/core/engine.js:70-86` 的 `applySize()` 只调用 `renderer.setPixelRatio()` 与 `post.setSize(rw, rh, w, h)`；全仓无 `composer.setPixelRatio` 调用。
- **影响**：把窗口从 100% 缩放的显示器拖到 200% 缩放的显示器（`devicePixelRatio` 变化但窗口尺寸不变或 resize 事件先到）后，中间缓冲尺寸使用旧的像素比 → 输出被轻微拉伸/模糊，或产生无谓的超采样开销（待验证具体观感与是否所有浏览器都会触发 resize）。
- **建议修法**：`post.js` 暴露 `setPixelRatio(r) { composer.setPixelRatio(r); }`，`engine.applySize()` 在 `renderer.setPixelRatio(...)` 之后调用 `post.setPixelRatio?.(sizes.pixelRatio)`。

#### P2-6 各向异性过滤：预设字段是死配置，且低画质也被强制 8x

- **证据**：`src/core/settings.js:33,62,91,120` 定义了 `anisotropy: 1/4/8/16`；grep 全仓，读取方只有 `src/core/textures.js:405`：`const aniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;`（`:416` 应用）。
- **影响**：ultra 想要的 16x 永远拿不到（被硬编码 8 截断）；low 想要的 1x（省性能）也永远拿不到（永远 8x）。移动端/low 档在斜坡与远景上白白多付各向异性采样成本。
- **建议修法**：`createTextureLibrary(quality, renderer)` 内改成 `const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high; const aniso = renderer ? Math.min(preset.anisotropy ?? 8, renderer.capabilities.getMaxAnisotropy()) : 1;`；若不打算用这个字段，就从 `QUALITY_PRESETS` 里删掉以免误导后人。

#### P2-7 能力探测缺失：`maxTextureSize` 与 half-float 渲染目标

- **证据**：`src/core/settings.js:110`（ultra `shadowMapSize: 4096`），`src/world/environment.js:20` 直接把它写进 `sun.shadow.mapSize`；three 已提供 `capabilities.maxTextureSize`（`node_modules/three/src/renderers/webgl/WebGLCapabilities.js:106,133`）但项目从未读取（grep `maxTextureSize` 在 `src/` 0 命中）；`EffectComposer` 默认 half-float RT（`EffectComposer.js:69`），three 对 half-float 可渲染性有扩展检查（`node_modules/three/src/renderers/WebGLRenderer.js:2014`）但本项目的 composer 是直接 `new EffectComposer(renderer)`（`src/fx/post.js:174`）。
- **影响**：在 `MAX_TEXTURE_SIZE = 2048/4096` 的老 GPU 或受限的移动端上，4096 阴影贴图会失败/退化为噪声阴影，玩家看到"阴影破碎"却没有任何提示；half-float RT 不可用时会出现整屏黑或报警（WebGL2 下多数设备支持，属小概率）。
- **建议修法**：`createEngine()` 里把 `renderer.capabilities.maxTextureSize`、`getMaxAnisotropy()`、`extensions.has('EXT_color_buffer_half_float') || extensions.has('EXT_color_buffer_float')` 汇成 `engine.caps`；`environment.js` 里 `sun.shadow.mapSize.set(Math.min(preset.shadowMapSize, engine.caps.maxTextureSize), …)`；`createPost()` 里 half-float 不支持时传 `new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType })` 给 `EffectComposer` 的第二参数。

#### P2-8 低帧率下的碰撞穿透（理论风险）

- **证据**：`src/gameplay/controls.js:133`（`p.speed` 上限 16.6 m/s）、`:147`（`_pos = position + fwd * speed * dt`）、`:149-168`（只对**终点**做圆内检测并推离）；`src/core/engine.js:116` 把 dt 上限设成 0.1 s；最小碰撞体 `r = 0.4`（`src/world/props.js:2512` 邮箱），判定半径 `rr = c.r + 0.44 = 0.84`（`src/gameplay/controls.js:153`）。
- **影响**（推算）：10 fps（dt=0.1）且处于 boost 极速时单步位移 1.66 m，与最细碰撞体直径 1.68 m 同量级 → 理论上存在"穿过灯柱/邮箱/栅栏而不触发碰撞"的窗口；刷新率正常（≥30 fps）时单步位移 ≤0.55 m，风险可忽略。（标注：未实测复现。）
- **建议修法**：`controls.update()` 的积分段做子步：`const steps = clamp(Math.ceil(Math.abs(p.speed) * dt / 0.3), 1, 4);` 循环内按 `dt/steps` 推进并与碰撞体求解；或把碰撞改成"线段（上一帧位置 → 新位置）与圆的最近距离"判定，一次求交即可。

#### P2-9 持久化：无版本号、无损坏校验、无清档入口

- **证据**：`src/main.js:302-315`（`SETTINGS_KEY = 'pelicanIsland.settings'`，裸 JSON；load 里只有 try/catch，无版本/白名单结构校验）；`src/gameplay/events.js:52-55`（`parseFloat(stored)` 未验 `Number.isFinite`）、`:80`（写入无 try 之外的保护也无版本）；`src/ui/menus.js:582-588`（设置页只有"本地 / 最佳成绩保存在本机"的说明，无清除按钮）。
- **影响**：老版本留下的畸形 payload（例如 `timeMode: {}`、`masterVolume: "abc"`、`quality: "ultra2"`）会被静默接受或静默忽略（各分支的 typeof 判断决定了行为），没有一次性迁移策略；玩家想"从头开始"（清掉最好成绩、静音、画质）没有任何入口，只能自己开 DevTools。
- **建议修法**：`loadSettings()`/`saveSettings()` 改为 `{ v: 1, data: {...} }` 包装，读取时校验 `v` 并对每个字段做白名单收敛（未知字段丢弃）；`events.js:54` 改 `const n = Number.parseFloat(stored); if (Number.isFinite(n)) race.best = n;`；在 `menus` 的「其他」区加一个"清除本地进度"按钮（`localStorage.removeItem('pelicanIsland.settings'/'pelicanIsland.bestLap')` + `flashNote` 确认）。

#### P2-10 发布缓存：`game.js` 无哈希、无 `?v=`

- **证据**：`index.html:45` `<script src="game.js"></script>`；`tools/build.mjs:57-62`（`--publish` 直接覆盖根目录 `game.js` / `styles.css`）；工作树里的 issue 模板把"硬刷新排除缓存旧包"列为必勾项（`.github/ISSUE_TEMPLATE/bug_report.yml`）。
- **影响**：GitHub Pages 对静态资源给出的默认缓存（`Cache-Control: max-age=600` 量级，待验证）会让刚发布的版本在部分玩家浏览器里最多十分钟不生效，表现为"修好了但我这里还是旧的"，直接污染 bug 报告。
- **建议修法**：`tools/build.mjs` 里把版本注入：`define: { __BUILD_ID__: JSON.stringify(sha.slice(0,8)) }`，并在 publish 时把 `index.html` 的 `src="game.js"` 重写成 `src="game.js?v=<sha>"`（同时对 `styles.css` 做同样处理）；或在 `game.js` 顶部写 `console.info('build', __BUILD_ID__)`，方便 issue 里对照。

#### P2-11 dev server 的路径前缀校验（本地低危）

- **证据**：`tools/serve.mjs:32-36`：`const file = path.join(root, path.normalize(rel).replace(/^([/\\])+/, '')); if (!file.startsWith(root)) { 403 }` —— 字符串前缀判断，`../pelican-island-ride-backup/x` 这类"根目录同前缀的兄弟目录"能通过校验。
- **影响**：仅本机开发服务器（`node tools/serve.mjs`，监听 5577）的信息泄露面；不影响 GitHub Pages 与 `file://` 发布形态。
- **建议修法**：改为 `const relPath = path.relative(root, file); if (relPath.startsWith('..') || path.isAbsolute(relPath)) { res.writeHead(403).end('forbidden'); return; }`。

#### P2-12 巨型文件、重复代码、孤儿事件（可维护性）

- **证据**：实测行数 `src/world/props.js` 2753 / `src/world/landmarks.js` 2114 / `src/world/vegetation.js` 1717 / `src/world/animals.js` 1709 / `src/core/audio.js` 1547 / `src/ui/hud.js` 1356 / `src/core/textures.js` 1325；三份同构的"零件几何合并"辅助：`src/character/pelican.js:121`、`src/world/animals.js:82`、`src/world/landmarks.js:103`；孤儿事件（grep 计数）：`player:reset` 2/0、`weather:rain` 1/0（`src/fx/weather.js:130` 的 `setRain` 是无人调用的空转 API）、`photo:enter`/`photo:exit` 0/1、`engine:ready` 1/0、`src/main.js:367` 空监听；未实现的 SPEC 契约：`docs/SPEC.md:94-101` 的 `clock`、`addUpdate(fn)` 与 `src/core/engine.js` 实际导出不符。
- **影响**：props/landmarks 这种体量的单文件让 review、定位与"哪个物件占了多少 draw call / 哪个函数出 NaN"的排查成本陡增（现有测试用"总量 + 抽样"来兜底，只能证明没有 NaN，无法证明某个 POI 没被改坏）；孤儿事件会让后来者以为功能存在。
- **建议修法**：① 把 props.js 按"村庄 / 港口 / 农场 / 营地 / 道路家具"拆成 `src/world/props/*.js`，由 `props/index.js` 汇总（保留现有 `{group, update, colliders, chimneys, lamps, stats, samples}` 返回契约）；landmarks.js 同理按地标族拆分；② 抽出 `src/core/build-utils.js`（`mergeParts(parts, {normalize})`）替换三处重复实现；③ 删除孤儿事件或在 `main.js` 接线（`context:lost/restored`、`player:reset` 优先）；④ 把 `QUALITY_PRESETS.anisotropy` 之类死配置删除或接上。

#### P2-13 测试覆盖盲区

- **证据**：`tools/dev/test-all.mjs:13-22` 的 8 个套件只 import 了 `world/layout`、`character/*`、`world/vegetation`、`world/props`、`world/landmarks`、`world/animals`、`world/particles`、`core/audio`、`ui/hud`、`ui/menus`、`core/utils`、`core/settings`（见各文件 import 段）；**没有任何测试**导入 `core/engine.js`、`core/input.js`、`core/textures.js`（测试里用 `Proxy` 假实现，例如 `tools/dev/test-props.mjs:25-33`）、`fx/post.js`、`fx/weather.js`、`gameplay/controls.js`、`gameplay/camera.js`、`gameplay/collectibles.js`、`gameplay/events.js`、`world/terrain.js`、`world/ocean.js`、`world/sky.js`、`world/environment.js`、`main.js`；`npm test` 也不包含 `smoke-live.mjs` / `diag-render.mjs` / `scene-stats.mjs` / `capture-frame.mjs`（它们需要真实浏览器 + WebGL，只能手工跑）。
- **影响**：本次审计里最"容易破"的部分（上下文丢失处理、DPR/尺寸、输入状态机、质量切换、物理碰撞、持久化往返）恰好全在测试盲区里：P0/P1 问题在 CI 里不可能被拦住；`.github/workflows/ci.yml` 目前只有 `npm test` + 构建 + 体积预算 + 静态检查。
- **建议修法**：① 加 `tools/dev/test-engine.mjs` / `test-input.mjs`：用 jsdom 伪造 `canvas.getContext`（返回带 `capabilities.getMaxAnisotropy` 等的最小对象）+ 假的 `THREE.WebGLRenderer`，断言 `webglcontextlost/restored` 会触发对应事件并停/启循环、断言手柄断连后 `brakeHard` 被清除、断言 `enabled=false` 清空所有输入状态；② 加 `test-post.mjs` 断言 `setQuality('high')` 后 `passes.bloomPass` 非空（当前会失败 → 正好锁住 P1-4）；③ 把 `check-no-network.mjs`、`check-bundle-budget.mjs`、`serve.mjs` 的路径校验、`build.mjs` 产物存在性加入 `npm test`；④ CI 增加一个 `playwright-core` + `--enable-unsafe-swiftshader` 的 headless 冒烟（把 `smoke-live.mjs` 改成可指向 `dist/index.html`），至少验证"能 boot 到 `window.__pelican.ready === true` 且无 console error"。

---

## 3. 最高性价比的 8 项修复（排序）

1. **`loop()` 加 `try/finally` + 菜单/未开始态门控**（`src/main.js:421-455`）：一次性解决 P0-1 的输入污染、P1-5 的"标题页自走"和 P1-7 的未托管区，改动约 20 行，风险极低。
2. **错误兜底可见化**（`index.html` 内联 `error`/`unhandledrejection` → `#boot-label`；`src/main.js:187-190` 改为直接 `hud.toast` + `window.__pelican.moduleErrors`）：把"静默残缺"变成"玩家/CI 都知道"，是后续所有修复的前提。
3. **上下文丢失/恢复接线**（`main.js` 订阅 `context:lost`/`context:restored`，加 8 s 看门狗 + restore 后 `post.setSize`/重建）：把"卡死只能刷新"变成"有提示、能自愈、失败有指引"（`src/core/engine.js:156-164`）。
4. **手柄状态复位**（`src/core/input.js:105-118` + `enabled`/`dispose` 统一 `resetAll()`）：修掉"永久刹车"这个必须刷新的硬故障，改动 10 行以内。
5. **`visibilitychange` → 停渲染 + 音频 suspend/resume**（`src/main.js` 新增监听、`src/core/audio.js:1342-1392` 增加 `suspend()/resume()`）：省电 + 后台不再出声，同时给计时赛/昼夜一个明确语义。
6. **像素预算 + DPR 上限收紧**（`src/core/engine.js:70-86` 引入 6 MP 预算、`src/core/settings.js:105-133` ultra cap 降到 1.5、`engine.applySize()` 里同步 `composer.setPixelRatio`）：直接消灭 4K 崩页面的风险，并顺手修 P2-5。
7. **设置面板与存档一致化 + 清档入口**（`src/main.js:337-352` 调 `menus.setSettings(saved)`、N 键 `saveSettings({muted})`、`src/ui/menus.js:582-588` 加"清除本地进度"）：让"设置"可信，玩家有自救手段。
8. **`post.setQuality()` 惰性建 bloom/SMAA（或提示需刷新）**（`src/fx/post.js:317-326`）：消除"切到高画质没变化"的迷惑，同时给 P2-13 的 `test-post.mjs` 提供断言点。

---

## 4. 待验证清单（静态分析无法定论）

- 上下文丢失后 `PMREM` 环境贴图、`EffectComposer` 中间缓冲是否在真机上无缝恢复（three 会在 `initGLContext()` 里重建 GL 侧对象，`src/world/environment.js:58-71` 的 `envRT` 只在小时变化时重建）——需要在 DevTools 里用 `WEBGL_lose_context` 扩展实测。
- `input.js:70` 的 `requestPointerLock()` 与 Esc 的交互（Chrome 下 Esc 退出指针锁时 keydown 是否仍派发到页面 → 是否需要按两次 Esc 才能暂停）。
- 4K/8K 分辨率的实际显存占用与是否 OOM（本报告只给出 `w*h*dpr²*scale²` 的算术推算）。
- 低帧率碰撞穿透是否可复现（需要构造 10 fps 场景 + boost 撞灯柱/邮箱）。
- GitHub Pages 当前返回的 `Cache-Control`（决定 P2-10 的严重度）。
- `file://` 下 `localStorage` 的可用性（各浏览器策略不同；代码有 try/catch 兜底，故不影响启动）。
- 跨显示器拖动（DPR 变化）是否一定会触发 `resize`（决定 P2-5 的实际触发频率）。

## 5. 明确"有"的部分（避免只看到问题）

- `dt` 三重 clamp（`src/core/engine.js:116`、`src/core/audio.js:1396`、`src/fx/post.js:252`）：标签页恢复不会炸物理。
- 音频模块的防御式设计（无 `AudioContext` 时全静默、每个出口 try/catch、一次性音源都 `stop()`）：音频失败不致命。
- `localStorage` 读写全部包了 try/catch（`src/main.js:303-315`、`src/gameplay/events.js:52-55,80`）：隐私模式不致命。
- `blur` 清 `held`（`src/core/input.js:55`）、键盘 repeat 去重（`src/core/input.js:46`）：常规"卡键"已被处理（手柄分支除外）。
- resize/orientationchange 处理 + three `RenderTarget.setSize` 内部 dispose：窗口缩放不泄漏 RT（`src/core/engine.js:88-90`、`node_modules/three/src/core/RenderTarget.js:365-398`）。
- `file://` 可直开：无 fetch/XHR/动态 import、无外部字体与图片、IIFE 单包（`tools/build.mjs:39-52`、`index.html:9,45`）。
- HUD/菜单在无 DOM 环境下退化为 no-op（`src/ui/hud.js:212-234`、`src/ui/menus.js:93-105`），且 8 个测试套件覆盖了世界生成与 UI 的主要契约。
