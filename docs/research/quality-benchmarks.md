# 质量与完成度基准调研（浏览器 3D 展示项目）

> 调研日期：2026-10-16 ｜ 针对项目：`pelican-island-ride`（three.js 程序化环岛骑行展示）
> 性质：**调研报告，不含任何代码改动**。文中每一条验收项都给出可判定阈值与来源。
> 方法：检索 GDC / 游戏设计权威文章、web.dev / MDN / W3C、three.js 官方文档、Unity / Godot / Arm 优化文档、开源仓库规范（GitHub Docs / OpenSSF），并对照同类标杆案例；所有"现状"判断来自 2026-10-16 对本仓库的静态审计（未运行游戏），标记为「初评」。

---

## 0. TL;DR（先看这个）

1. **本项目"仓库结构完成度"已经很高**：CI（Node 22/24 双矩阵 + 产物同步检查 + 不变量检查）、社区健康文件、bundle 预算脚本、8 套模块测试、双语 README、6 张截图都已写好——但**整批新增文件尚未提交**，CI 从未在 GitHub 上真正跑过一次。这是当前最贵、也最容易修的缺口（零成本）。
2. **`CHANGELOG` 引用了 `v1.0.0` release 链接，但仓库没有任何 git tag**（`git tag -l` 为空），发布页链接存在 404 风险。打 tag + 建 Release 是 15 分钟的事，直接补齐"发布完成度"。
3. **分享链路缺失**：`index.html` 没有 `og:*` / `twitter:card` / `theme-color`，外部分享无卡片预览。对展示型项目这是性价比最高的补齐项之一（用现成截图做 1200×630 图即可）。
4. **打磨层已有的比缺的多**：相机抖动、粒子、完成横幅、best lap、照片模式、手柄/触屏输入、暂停菜单都已存在；缺的是"可关闭性"（无障碍联动）、结算演出、失焦自动暂停。
5. **技术层最值得做的四件事**：① 确认/补齐 `dt` clamp（切页回来不跳变）；② `visibilitychange` 暂停（WebAudio 仍在后台播放）；③ 消除 `THREE` 命名空间逃逸（`src/main.js:126`，审计显示可减约 **62 KiB** 死代码）；④ 首可玩时间优化（当前整岛构建 4–11 s，目标 <5 s，参考 Slow Roads 的"近处优先"策略）。
6. **验收缺口 = 证据缺口**：移动端 30fps、Lighthouse 分数、跨浏览器矩阵目前都没有留档。展示型项目的"完成度"最终由可复现的证据构成，建议把一次性验证变成仓库里的 `docs/research/` 证据。

---

## 1. 衡量框架与评分卡

行业里没有一个官方的"完成度总分"，但五个维度的衡量方式都已相当成熟。本报告按下列框架整理，共 **67 条可验收项**。

| 维度 | 代表问题 | 建议权重 | 本项目初评（静态审计，10 分制） |
| --- | --- | --- | --- |
| A 游戏打磨（Game Feel / Juice / 垂直切片） | 玩起来"活"吗？有无新手引导、反馈层级、结束时刻？ | 30% | 7.0（基础齐，缺演出/暂停联动/无障碍开关） |
| B Web 工程质量（Web Vitals / WCAG / 移动端） | 加载快吗？可访问吗？分享出去有卡片吗？ | 20% | 6.5（预算与不变量已有，缺实测基线、OG、缩放允许） |
| C 开源仓库完成度 | 陌生人 5 分钟内能跑起来、信任并参与吗？ | 15% | 7.0（结构齐但未提交、无 tag/Release） |
| D 3D 与性能技术质量 | 帧预算、draw call、泄漏、兼容性与降级 | 25% | 7.5（实例化/dispose/上下文恢复已有，缺移动实测与构建耗时治理） |
| E 代码内部质量 | 契约清晰、热路径干净、错误有出口 | 10% | 8.0（SPEC + 测试已有，缺浏览器级 CI smoke） |

**优先级标签定义（全文通用）**

- `★★★ P0`：高性价比，展示项目应当做；多数在半天以内，收益立刻可见。
- `★★ P1`：值得做；1–3 天量级，明显提升完成度。
- `★ P2`：低 ROI / 可选；做了不加分太多，不做不算缺陷（会单独在地下章节列出）。

---

## 2. 维度 A：游戏打磨与完成度（Game Feel / Juice / Vertical Slice）

方法论速记：**Juice**（最大输出/最小输入：粒子、屏震、音效、动画过冲，"Juice it or lose it"）；**Game Feel**（Steve Swink：真实时控制 + 模拟空间 + 打磨层）；**Vertical Slice**（每一维度都达到发布质量的一小段，10–30 分钟即可，用来证明"最终形态"）；**Finishing**（Derek Yu：完成度是练出来的能力，不要在不好玩的核上抛光）。

| ID | 验收项（判定标准） | 来源 | 适用性 / 优先级（含现状） |
| --- | --- | --- | --- |
| A1 | 输入响应 ≤100ms：键盘/手柄/触屏动作到屏幕可见变化 <100ms（RAIL 的"Response <100ms"预算），用 DevTools Performance 录制单次输入测量 | web.dev RAIL | ★★★ P0 高性价比｜现状：输入链路即时（input.js 已含键盘/手柄/触屏），预计达标但无实测记录 |
| A2 | 每个玩家动作 ≥2 层叠加反馈：加速/刹车/转弯/碰撞各自同时有动画变化 + 粒子或音效；开局 60 秒内可数出 ≥6 个 juice 点 | Juice it or lose it | ★★★ P0｜现状：轮胎粒子、相机抖动、合成音效已有，属"验收 + 补 1–2 个缺口" |
| A3 | 相机冲击可控：抖动幅度有上限与节流；设置里可"关闭屏震"；`prefers-reduced-motion` 时默认减弱 | The Art of Screenshake；Xbox Accessibility Guidelines | ★★ P1｜现状：crash→shake 已实现且指数衰减，但无开关、JS 层未联动 reduced-motion |
| A4 | 60 秒盲测上手：未读 README 的测试者 60 秒内完成"起步 → 转弯 → 拾取 1 枚羽毛"；无文字教程可达（至多一次可跳过的提示） | The Door Problem（需求=无数个小问题） | ★★★ P0｜现状：操作极简，建议做 5 人盲测并把结果留档 |
| A5 | 核心循环闭合：开始 → 探索/收集/计时 → **完成结算**（用时、收集数、是否破纪录、重玩入口） | Vertical slice 定义 | ★★★ P0｜现状：`race:finish` 事件、FINISHED 横幅、best lap 持久化已存在；缺"结算面板 + 庆祝演出 + 一键重玩" |
| A6 | 开局 15 秒钩子：进入游戏后第一个镜头里至少 1 个大型地标 + 1 个可互动物；标题→玩法过渡无黑屏等待 | Steam 页面检查清单（首屏印象） | ★★ P1｜现状：海上孤岛 + 灯塔配置天然具备，需确认开场机位与节奏 |
| A7 | 卡死自恢复：卡入几何体/跌出边界后 3 秒内自动回到最近道路；用脚本放置 ≥20 个边界点位全部可恢复（R 键手动脱困已有） | 通用 QA 实践 | ★★ P1｜现状：`R = return to nearest road`（README）；缺自动检测与 20 点测试证据 |
| A8 | 失焦/切页暂停：`visibilitychange` + `blur` 时暂停音频、计时与渲染；返回时淡入或 3-2-1；后台标签页不得出声 | MDN Page Visibility API；MDN Autoplay guide | ★★ P1｜现状：**未发现任何 visibilitychange/blur 处理**（rg 零命中）→ 明确的缺口 |
| A9 | 进度持久化：best lap、画质/音量/相机设置、收集进度刷新后保留；提供"清除进度"按钮 | MDN Web Storage | ★★★ P0｜现状：`pelicanIsland.bestLap` 与设置已入库；待确认收集进度是否持久化、是否有清档入口 |
| A10 | 音频完成度：master/music/sfx 至少三档音量；首次用户交互前不自动出声（Autoplay 合规）；速度/雨天/夜晚影响混音（已有 fPaused/qualityFactor 混音参数） | MDN Autoplay guide | ★★ P1｜现状：全合成 WebAudio + 按时间/速度的动态音乐已实现；待验收音量分档与静音恢复 |
| A11 | 里程碑庆祝：完成计时赛或收集里程碑时 3–8 秒的演出（镜头、粒子、音效、统计卡），可跳过 | Juice it or lose it | ★★ P1｜现状：有横幅类提示；演出与统计卡是提升"完成感"的最大单点收益 |
| A12 | 世界活性：玩家静止 10 秒仍有 ≥3 类环境动效（云影、海浪、鸟群、炊烟、旗帜） | A Short Hike postmortem（"活"的小世界） | ★★★ P0｜现状：六类粒子系统 + 234 个生物已在；只需验收并固化 |
| A13 | 速度感映射连续：速度 → FOV/相机距离/风声音量/植被摆动为无阶跃曲线；30/60/120Hz 下手感一致 | Fix Your Timestep | ★★ P1｜现状：相机分段模式已有；需检查映射平滑与时间步解耦 |
| A14 | 触屏可完成基本玩法：手机横屏下用虚拟控制完成转向+加速+刹车，目标 ≥44×44 CSS px；README 记录触屏操作 | WCAG 2.2 Target Size；Apple HIG | ★★ P1｜现状：input.js 有 touch 轴（12 处），README 未记录触屏操作 → 真机验收 + 文档补齐 |
| A15 | 手柄即插即用：Gamepad API 连接/断开无刷新；按键提示随设备切换 | MDN Gamepad API | ★★ P1｜现状：gamepad 已在 input.js/menus.js 实现，固定为"验收项" |
| A16 | 无障碍基线：收集物不靠颜色单一区分（形状/图标）；可关闭屏震与闪烁；UI 文本对比度 ≥4.5:1；提供 UI 缩放或允许页面缩放 | Xbox Accessibility Guidelines；Game Accessibility Guidelines | ★★ P1｜现状：CSS 层有 reduced-motion；缺 JS 联动与游戏内无障碍设置（另见 B10 的 `user-scalable=no` 问题） |

---

## 3. 维度 B：Web 工程质量（Web Vitals / WCAG / 移动端）

判定基准：Core Web Vitals 的"good"阈值为 75 分位下 LCP ≤2.5s、INP ≤200ms、CLS ≤0.1；Lighthouse 移动预设对 WebGL 重应用不追求满分，但 A11y/Best Practices 应接近满分。

| ID | 验收项（判定标准） | 来源 | 适用性 / 优先级（含现状） |
| --- | --- | --- | --- |
| B1 | Core Web Vitals 三项达标：LCP ≤2.5s、INP ≤200ms、CLS ≤0.1（75 分位，移动/桌面分开）；无真实流量时以 Lighthouse + PSI 实验室数据替代并留档 | web.dev：Web Vitals 与阈值定义 | ★★ P1｜现状：单页 + 内联样式，CLS 风险低；INP 取决于加载期长任务（见 B3） |
| B2 | Lighthouse 移动预设：Performance ≥80、Accessibility ≥95、Best Practices ≥95；分数截图存入 `docs/research/` | Lighthouse 性能评分 | ★★ P1｜现状：无分数留档 → 跑一次即得基线 |
| B3 | 长任务治理：主线程连续任务 <50ms；世界构建（现 4–11 s）分片 yield 且进度真实；交互开始后无 >200ms 单次卡顿 | web.dev：Optimize long tasks | ★★★ P0｜现状：加载有进度条；4–11 s 的构建窗口是最值得治理的性能点（见 D 章节"[首可玩时间]"） |
| B4 | 首包预算：入口 JS ≤1.4MB raw / ≤400KB gzip；CSS ≤80KB raw；资源数可控（当前 game.js 1.21MB / 372KB gzip，脚本已强制预算） | web.dev：Performance budgets 101 | ★★★ P0 已达成｜保持：`check-bundle-budget.mjs` 已入 CI；后续任何新增都要过这道门 |
| B5 | 首屏可交互：桌面 <3s 出现第一个可交互画面、移动中端 <5s；"完全可玩"由进度条承诺且兑现 | web.dev RAIL（Load 预算） | ★★ P1｜现状：进度条真实；首帧与"可玩"两个时间点未记录 |
| B6 | 控制台零错误、零警告：生产构建 + 移动模拟 + 各画质档各跑一次，`console` 无 error/warn（含 WebGL 警告） | MDN WebGL best practices（"规范页面只应产生 OUT_OF_MEMORY / CONTEXT_LOST"） | ★★★ P0｜现状：无留档；这是最便宜的"专业性"证据 |
| B7 | WebGL 降级与丢失恢复：不支持 WebGL2 → 友好静态页（截图+说明），而非白屏；`webglcontextlost` → 暂停并自动重建或给提示 | Khronos：Handling Context Lost；WEBGL_lose_context 扩展 | ★★★ P0｜现状：**恢复逻辑已实现**（engine.js 监听 lost/restored 并重启循环）；缺"不支持 WebGL2"的降级页与一次模拟演练记录 |
| B8 | `prefers-reduced-motion` 全链路：CSS（已做）之外，JS 动画/相机也应减弱，并提供游戏内开关 | MDN prefers-reduced-motion | ★★ P1｜现状：styles.css 已有媒体查询；JS 层未联动 |
| B9 | 键盘可达：标题→开始→暂停→设置→返回全流程可纯键盘完成；焦点样式可见；Tab 顺序符合视觉顺序 | WCAG 2.2（2.1 键盘可达） | ★★ P1｜现状：快捷键体系完善；菜单焦点管理未验证 |
| B10 | 对比度与缩放：UI 文本 ≥4.5:1（大字号 ≥3:1），HUD 在亮天空/海面上仍可读；**允许页面缩放**——移除 `maximum-scale=1, user-scalable=no`（WCAG 1.4.4），改游戏内 UI 缩放选项 | WCAG 2.2 Quick Reference | ★★★ P0 高性价比｜现状：`index.html` 目前禁止用户缩放 → 明确的合规缺口 |
| B11 | 响应式与安全区：360×640 → 4K 无横向滚动、无 UI 遮挡关键画面；`env(safe-area-inset-*)` 适配刘海屏；竖屏时给出横屏提示 | WCAG 2.2；MDN env() | ★★ P1｜现状：有 viewport 与全屏 canvas；移动布局未留证 |
| B12 | 分享卡完整：`og:title/description/image`（1200×630）、`twitter:card`、`theme-color`、favicon（已有内联 SVG 版）；用社交调试器验证渲染 | Open Graph protocol | ★★★ P0 高性价比｜现状：**缺失**（仅有 title/description/favicon）→ 用现成 screenshots 即可补齐 |
| B13 | 双语 UI：界面文案 en/zh 可切换（或按 `navigator.language` 自动）；文案集中管理避免遗漏 | WCAG 3.1.1 语言标注 | ★★ P1｜现状：HUD 文案中英混合（如 '完成'/'FINISHED'），需确认是否有语言开关 |
| B14 | 加载真实性：进度条权重反映真实任务；等待 >30 s 给出"刷新/降画质"建议；构建耗时可打印到 console 便于诊断 | web.dev RAIL | ★★ P1｜现状：boot overlay 已有进度与提示；建议把"构建耗时"打点到控制台 |
| B15 | `file://` 直开契约：双击 index.html 可玩且 CI 持续守护"无网络访问"（check-no-network 已写） | 本项目 SPEC（独有卖点） | ★★★ P0 已达成｜保持：这是本仓库差异化价值，勿在后续引入外部资源时破坏 |
| B16 | 可安装/离线（PWA）：manifest + Service Worker 缓存，可安装、断网可玩 | MDN PWA 指南 | ★ P2 低 ROI｜展示项目受众以"点开即玩"为主，收益有限 |

---

## 4. 维度 C：开源仓库完成度

参照 GitHub 社区档案清单（community profile）与 OpenSSF Scorecard 的检查项。**重要背景**：本仓库已写好其中大部分文件，但截至 2026-10-16 均处于未提交状态（`git status` 显示 `?? .github/`、`?? CHANGELOG.md` 等）。

| ID | 验收项（判定标准） | 来源 | 适用性 / 优先级（含现状） |
| --- | --- | --- | --- |
| C1 | LICENSE 存在且被 GitHub 识别（MIT） | Choose a License | ★★★ P0 已达成｜MIT 许可证已就位 |
| C2 | README 完整度：一句话定位、顶部截图/GIF、在线 Demo 链接、控制表、技术栈、快速开始（≤3 条命令）、目录结构、性能数据、许可证 | GitHub 社区档案；awesome-readme | ★★★ P0 已达成｜英/中双 README + 6 张截图已具备；建议顶部加 6 秒 GIF 与"60 秒体验路径" |
| C3 | CI 全绿徽章：push/PR 触发 install→test→build→预算→静态检查；README 挂状态徽章 | GitHub Actions 文档 | ★★★ P0｜现状：`ci.yml` 已写好（Node 22/24 矩阵 + 产物同步 + 不变量检查）但**未推送，从未运行** → 立即提交并修复首个红灯 |
| C4 | 发布产物与源码同步可被验证：CI 检查 `game.js`/`styles.css` 与 `dist/` 一致 | 可复现构建思路 | ★★★ P0 已设计｜`bundle-in-sync` job 已存在，提交后即有守护 |
| C5 | 版本发布：semver tag（v1.0.0）+ GitHub Release（附截图与要点）+ CHANGELOG 链接可点 | Keep a Changelog；SemVer | ★★★ P0 高性价比｜现状：**无任何 tag**，而 CHANGELOG 引用了 `releases/tag/v1.0.0` → 链接 404 风险；打 tag 约 15 分钟 |
| C6 | 贡献文件齐全：CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、issue 表单 ×2、PR 模板（全员已写好，提交后 community profile 应全绿） | GitHub 社区档案 | ★★ P1｜现状：文件已就位未提交；提交后回看 profile 勾选状态 |
| C7 | 可复现构建：提交 lockfile（已有）且 `npm ci` 通过；声明 Node 版本（`engines` 或 `.nvmrc`）；构建无网络依赖（已有检查脚本） | Reproducible Builds；GitHub Actions 文档 | ★★ P1｜现状：lockfile 与无网络检查已具备；`package.json` **无 engines 字段**、无 `.nvmrc` → 补齐 |
| C8 | 仓库元数据：description、homepage、topics（three.js/webgl/game/procedural 等）、社交预览图（1200×640） | GitHub 社区档案 | ★★ P1｜现状：description 与 homepage 已设；topics 与社交预览图待确认 |
| C9 | 提交卫生：Conventional Commits 风格、提交即有意义、生成物例外有说明 | Conventional Commits | ★★ P1｜现状：首个提交 `feat: ...` 已符合；保持即有加分 |
| C10 | 依赖更新策略：Dependabot/Renovate 月度 PR + CI 把关（three 主版本升级需人工回归） | OpenSSF Scorecard（Pinned-Dependencies） | ★ P2 低 ROI｜单人展示项目可后置 |
| C11 | 安全健康基线：跑一次 OpenSSF Scorecard 并记录分数与未过项 | OpenSSF Scorecard | ★ P2 低 ROI｜10 分钟可得基线；不必追满分 |
| C12 | 文档分层：SPEC（已有）、ARCHITECTURE/CONTRIBUTING（已有）、研究留档目录（本文件所在 `docs/research/`）；CI 可加"SPEC 提到的模块均在 registry 中"的一致性检查 | 本项目结构 | ★★ P1｜现状：SPEC.md 19KB + research/data/bundle.json 已建立雏形 |

---

## 5. 维度 D：3D 与性能技术质量

判定基准：60fps = 16.7ms 帧预算（建议 GPU ≤13ms、CPU 逻辑 ≤4ms，留余量）；移动 30fps = 33.3ms。draw call 与三角形没有普适硬线，但社区/引擎实践普遍认为：桌面程序化场景 **≤1500–2000 draw calls、≤3–5M 三角形**合理，移动端应为 1/4–1/8；本项目 README 自述"high 档 1300–2000 draw calls、3–4.7M 三角形"，**已贴着上限**，因此下面的阈值本质上要求"分档 + 基线化"。

| ID | 验收项（判定标准） | 来源 | 适用性 / 优先级（含现状） |
| --- | --- | --- | --- |
| D1 | 帧率目标：桌面 1080p 集显/中端独显 ≥60fps（1% low ≥50）；移动中端 ≥30fps（1% low ≥24）；录制 60s 轨迹统计帧时间 P95 | Unity/Godot 性能文档；Fix Your Timestep | ★★★ P0｜现状：无帧时间留档；先用 `scene-stats.mjs` 固化桌面基线 |
| D2 | 帧时间预算分配：GPU 帧 ≤13ms、CPU 逻辑 ≤4ms、阴影 pass ≤3ms（60fps 下总预算留 3ms 抗抖） | Godot 性能文档；renderer.info | ★★ P1｜现状：有 renderer.info 读数工具，缺分项基线 |
| D3 | draw call 分档预算：ultra/high ≤1500（硬上限 2000）、medium ≤900、low ≤400、移动 ≤300；在 10 个固定机位录制并入库 | three.js manual（Optimize lots of objects）；Unity draw call 文档 | ★★★ P0｜现状：1300–2000 @ high（README）已在边缘；分档阈值与机位清单缺失 |
| D4 | 三角形预算：high ≤5M/帧、medium ≤2.5M、移动 ≤1.5M | Unity/Godot 性能文档 | ★★ P1｜现状：3–4.7M @ high，接近上限 → 需要 LOD/远裁剪对冲（见 D6） |
| D5 | 实例化覆盖率：重复小物（树/草/石/鸟/车辆零件）≥80% 走 InstancedMesh 或合并几何；新增内容默认复用该模式 | three.js manual：Optimize lots of objects | ★★★ P0 已达成｜现状：vegetation/props/landmarks/animals/bicycle 均在使用 InstancedMesh，保持 |
| D6 | LOD 与远裁剪：高面数地标 ≥2 级 LOD（或距离/雾剔除）；远景植被降模或 billboard；数百米外几何不进 draw call | three.js LOD；Unity LOD | ★★ P1｜现状：雾已用于远景；显式 LOD 级别未见 → 主要对冲 D4 的手段 |
| D7 | 纹理与生成预算：程序化纹理边长 ≤2048（移动 ≤1024）；纹理生成总时长 ≤2s 或分帧；贴图 `colorSpace` 正确（SRGB） | three.js Color management | ★★ P1｜现状：195 张程序化纹理、SRGBColorSpace 已在用；生成耗时未单独计量 |
| D8 | 资源释放：dispose 全链路（geometry/material/texture/renderTarget）；连续"重开 3 次"后 JS 堆稳定（±10%）且 GPU 内存不增长 | three.js manual：How to dispose of objects | ★★ P1｜现状：多个模块已有 dispose（vegetation 26 处等）；缺"3 次重开"泄漏证据 |
| D9 | 时间步稳定：`dt` 上限 clamp（建议 ≤50ms，或固定步长+插值），切回标签页不得瞬移/穿透；30/60/120Hz 行为一致 | Fix Your Timestep | ★★★ P0 高性价比｜现状：主循环直接使用 `dt`（`state.dt = dt`），**未发现显式 clamp** → 最便宜的高保险修复 |
| D10 | 上下文丢失演练：用 `WEBGL_lose_context` 扩展主动触发 lost/restored，游戏能恢复（实现已存在） | Khronos：Handling Context Lost | ★★ P1｜现状：engine.js 已监听 lost/restored 并重启更新循环 → 只差一次模拟演练记录 |
| D11 | 跨浏览器矩阵：Chrome/Edge/Firefox/Safari + 移动 Safari 各完成"进入→骑行→暂停→退出"冒烟；结果写入 Release 说明 | MDN WebGL best practices | ★★★ P0｜现状：无矩阵记录；Safari/iOS 是 WebGL 项目最常见翻车点 |
| D12 | 移动 GPU 策略：pixelRatio 上限（现状 low 1.0 / medium 1.25 / high 1.5 / ultra 2.0 已分档）；避免每帧纹理上传；控制大面积 overdraw（粒子叠加）；shader 精度声明合理 | Arm Mali Best Practices | ★★ P1｜现状：pixelRatioCap 分档已实现；overdraw 与精度未验证 |
| D13 | 后台与功耗：标签页隐藏时停止渲染与音频（见 A8/B8）、回到前台按需恢复；连续游玩 10 分钟堆内存漂移 ≤10MB | three.js：Rendering on demand；MDN Page Visibility | ★★ P1｜现状：无 visibilitychange 处理 → 与 A8/D9 合并修 |
| D14 | 色彩与后处理一致性：色调映射统一（ACES/AgX）；雾色/天空/海面颜色协同；运行时不得出现 NaN 注入（历史上曾因 `Vector3.copy(Color)` 导致全场黑屏）→ 保留为回归检查项（console 无 NaN 相关警告） | three.js Color management | ★★ P1｜现状：post 链完整；建议把"黑屏类 NaN 回归"写成测试用例 |
| D15 | 性能与体积回归基线诸存：`audit-bundle`/`scene-stats`/`capture-frame` 输出入库（已有 `docs/research/data/bundle.json` ⚠ 但 provenance 指向临时目录），变更超 15% 报警 | web.dev：Performance budgets | ★★★ P0｜现状：工具与输出雏形已有；缺"入库 + 对比告警"这一环 |
| D16 | 运行时调试 HUD：`?debug=1` 显示 fps、frame ms、draw calls、三角形数、内存；发布版默认隐藏 | renderer.info；stats.js | ★★ P1｜现状：有诊断脚本但无游戏内 HUD 开关 |
| D17 | 热循环零分配：每帧不 new Vector3/Color/材质等（用 scratch 对象）；10 分钟游玩无周期性 GC 卡顿 | Chrome DevTools Memory/Performance | ★★ P1｜现状：未验证；属于"低成本、长期保险"型项目 |

---

## 6. 维度 E：代码内部质量（可维护 / 可测试 / 可诊断）

| ID | 验收项（判定标准） | 来源 | 适用性 / 优先级（含现状） |
| --- | --- | --- | --- |
| E1 | 模块契约统一：所有模块工厂返回 `{ group, update(dt,state), setQuality? }`，由 registry 装配；新增模块能过 `test-all` 且不破坏 SPEC | 本项目 SPEC（冻结接口） | ★★★ P0 已达成｜现状：16 模块 + SPEC + 8 套测试已就位 |
| E2 | 全局错误出口：`window.onerror`/`unhandledrejection` 捕获后给出可读 UI（非白屏）；boot overlay 对启动失败有兜底提示 | Khronos context-lost 思路 + 通用 Web 实践 | ★★ P1｜现状：boot overlay 已存在但未见全局错误捕获 |
| E3 | 常量集中：玩法/画质/相机可调参数集中于 `settings.js` 等单一来源，减少散落 magic number | 通用工程规范 | ★★ P1｜现状：`settings.js` 已集中画质与部分常量；建议持续收敛 |
| E4 | 体量上限：单源文件 ≤2500 行、单函数 ≤150 行（新增代码遵守）；避免继续膨胀 props.js 类模块 | 通用工程规范 | ★ P2 低 ROI｜现状：未发现违规证据，作为约束保留 |
| E5 | 浏览器级 smoke 进 CI：Playwright（已在 devDependencies）驱动"加载→骑行 5 秒→暂停"并断言无 console error | Playwright | ★★ P1｜现状：`smoke-live.mjs` 等脚本已写好但未接入 CI（且未提交） |
| E6 | 注释与 TODO 卫生：`rg TODO/FIXME` 归零或有 issue 跟踪；模块头注释与行为一致 | 通用工程规范 | ★ P2 低 ROI｜展示项目保持整洁即可 |

---

## 7. 同类优秀案例拆解（可抄的具体点）

| 案例 | 类型 | 做得好的具体点（值得本项目抄的） |
| --- | --- | --- |
| **Bruno Simon** 作品集（folio-2025，MIT 开源） | 浏览器 3D 交互标杆 | ① 加载过程本身可玩（不是白等）；② 内容分区藏在"可驾驶的世界"里，导航即内容；③ 音频设计（引擎+环境）强化"在开车"的感觉；④ WebGL + WebGPU (TSL) 双路径，兼顾兼容与新特性；⑤ 源码开源，把"展示"变成"可学习的工程"。对本项目：加载体验与"场景即导航"已是同类，可对标 ④⑤ |
| **Slow Roads**（slowroads.io，web.dev 官方案例研究） | 浏览器程序化驾驶，最接近本项目气质 | ① "只生成近处细节"——利用玩家停留在路上的预期，把算力集中在眼前（本项目为整岛一次性构建 4–11s，可借鉴其"近处优先、渐进补齐"）；② 极简 UI 与设置（画质/视野/时间），无失败、无目标亦成立；③ 2.0 全面重写以支持长期演进（引擎整洁度=长期质量）；④ Chrome 团队案例背书，成为可引用的"质量证据"。 |
| **A Short Hike**（GDC 2020 postmortem） | 小体量开放世界的完成度范本 | ① 在限制内做设计：小岛、短时长、无失败状态也能有完整弧线；② 视觉风格 + 写作（对白/涂鸦）让世界有"人味"；③ 明确的**结尾体验**（登顶）——对应本项目的"完成一圈/灯塔顶点"应该有专属演出。 |
| **Tiny Glade** | 舒适向 3D 建造（非 Web，但打磨标准可迁移） | ① 微交互：每一次放置都有即时、有重量感的反馈；② 无失败设计 + 柔和音效构成"低压力"体验；③ 程序化美学高度统一（不是拼贴）。对本项目：天气/黄昏时刻的"氛围一致性"与交互反馈可对标。 |
| **three.js 官方 examples/showcase** | 引擎级展示标准 | ① 每个 demo 自解释：标题、说明、源码链接、控件提示；② 单一功能一个 demo，便于学习和验证；③ 长期维护（r186 仍在更新）。对本项目：README 里的"特性 → 截图/按键"一一对应，已做到大半，可再补"每个特性可一句话验证"。 |
| **Awwwards 评分体系** | 展示型站点的行业口径 | 公开权重：Design 40% / **Usability 30%** / Creativity 20% / Content 10%。Usability 单项就占 30%——性能、可导航性、响应式、无障碍是硬门槛而非加分项；Content 10% 用来惩罚占位内容。对本项目：README/落地页文案与截图不是"附属品"，而是评分维度。 |
| **Steam 页面检查清单**（Chris Zukowski） | 第一印象与分发质量 | ① 首屏 GIF/截图质量决定点击；② "前 6 秒"要能看出游戏在做什么；③ 商店页所有字段（简介/标签/媒体）都要填写完整。对本项目：README 顶部加 6 秒循环 GIF；在线 Demo 链接必须是页面第一个可点元素（已接近）。 |

---

## 8. 本项目差距快照与建议动作（2026-10-16 静态审计）

### 8.1 现有优势（不要动）

- 仓库根即发布站，`index.html` 双击可玩；`check-no-network` 守护"无外部资源"这一独有卖点。
- CI 已写好三个 job：测试矩阵（Node 22/24）、产物同步（game.js/styles.css 与 src 一致）、静态检查（不变量 + README 链接）。
- 预算脚本已就位：`dist/game.js` raw 1.4MB / gzip 400KB 上限；当前 1.21MB / 372KB（测量值），有余量。
- 游戏侧已有：键盘/手柄/触屏输入、暂停菜单、照片模式、昼夜与天气、计时赛 + best lap 持久化、`webglcontextlost` 自动恢复、四档画质 + pixelRatioCap + `detectQuality()`、`?seed=` 世界重放、8 套 headless 测试、截图流水线。
- 文档侧已有：双语 README、SPEC.md、CHANGELOG（Keep a Changelog 格式）、社区健康文件全套（未提交）。

### 8.2 P0：高性价比（建议按顺序执行）

| # | 动作 | 依据 | 预计工作量 |
| --- | --- | --- | --- |
| 1 | 提交并推送全部未提交改动（.github/、社区文件、tools/dev 新脚本、docs/research/），让 CI 首次运行并修到全绿；README 挂徽章 | C3/C4/E5 | 半天（含修 CI） |
| 2 | 打 `v1.0.0` tag + GitHub Release（附 6 张截图、要点、控制说明），消除 CHANGELOG 链接 404 风险 | C5 | 15–30 分钟 |
| 3 | `index.html` 补 `og:*`/`twitter:card`/`theme-color`，用 `screenshots/ride.jpg` 生成 1200×630 分享图 | B12 | 1 小时 |
| 4 | `visibilitychange`/`blur` 自动暂停（音频 suspend + 暂停菜单 + 返回淡入），与 `dt` clamp 一并处理 | A8/D9/D13 | 半天 |
| 5 | 确认/补齐 `dt` clamp（≤50ms），复现路径：切标签页 10s → 回来，不应瞬移 | D9 | 1 小时 |
| 6 | 移除 `src/main.js:126` 的 `THREE` 命名空间逃逸，改用命名导入（审计显示可减约 62 KiB 并被 tree-shake 掉 AnimationMixer/AudioContext 等死代码），跑测试 + 体积复核 | D15/B4 | 1–2 小时 |
| 7 | `.scratch/` 加入 `.gitignore`；清理 `docs/.agent-probe.txt`（已被忽略但建议删） | C12 | 5 分钟 |
| 8 | 跑一次 Lighthouse（移动+桌面）与 PSI，把分数/截图存入 `docs/research/`；README 性能段补"实测"字样 | B1/B2/D15 | 1 小时 |
| 9 | 移动端 30fps 实测记录（1 台中端安卓 + 1 台 iPhone），README 补触屏操作说明 | A14/D1/D11 | 1–2 小时 |

### 8.3 P1：值得做（1–3 天量级）

1. **结算演出**：`race:finish` 已有事件 → 补"镜头环绕 + 粒子 + 统计卡 + 重玩按钮"，并让收集里程碑复用同一条演出管线。（A5/A11）
2. **首可玩时间优化**：目标桌面 ≤5s 出现可玩画面（低画质/简化世界先行，细节后台补齐；参考 Slow Roads 的远景策略），构建耗时打点到 console。（B3/B5/D3）
3. **无障碍包**：游戏内开关（屏震/闪烁/UI 缩放）+ 收集物形状标识 + 移除 `user-scalable=no` + JS 层联动 reduced-motion。（A3/A16/B8/B10）
4. **LOD 与分档预算**：为高面数地标加 1–2 级 LOD，建立 10 机位 draw call 基线（ultra/high/medium/low/移动）入库；medium 目标 ≤900。（D3/D4/D6）
5. **浏览器级 CI smoke**：用 Playwright 跑"加载→骑行→暂停→无 console error"，接入现有 ci.yml。（E5/B6）
6. **键盘可达性与焦点管理**：菜单焦点陷阱修正、焦点样式、Tab 顺序审查。（B9）
7. **`?debug=1` HUD 固化**：fps/frame ms/draw calls/三角形/堆内存。（D16）
8. **跨浏览器矩阵留档**：五端冒烟结果写入 Release 说明模板。（D11）
9. **README 顶部 6 秒 GIF + "60 秒体验路径"**。（C2，参考 Steam 清单与 Awwwards Content 项）

### 8.4 P2：低 ROI / 明确可后置

- PWA 离线安装（B16）：受众点开即玩，收益低。
- Dependabot/Renovate、OpenSSF Scorecard 满分、CODEOWNERS、E4 行数硬约束：对单人展示项目边际收益极低（Scorecard 跑一次留档即可）。
- 全岛几何流式加载 / WebGPU 迁移 / 端到端截图 diff CI：收益真实但成本显著高于本阶段目标；建议作为"下一个台阶"再评估。
- 更多语言 i18n、成就系统、云存档：属于产品扩展而非质量维度，若做应另立目标。

---

## 9. 度量工具链（把"验收"变成可复现的证据）

| 用途 | 工具 | 备注 |
| --- | --- | --- |
| 加载性能与 Web Vitals | Lighthouse（DevTools 内置）/ PageSpeed Insights / WebPageTest | PSI 可拿到线上 URL 的实验室数据；WebPageTest 可录制移动真机视频 |
| 持续性能门禁 | Lighthouse CI | 可在 PR 上跑分并设预算，与现有 size 预算互补 |
| 体积预算 | 已有 `check-bundle-budget.mjs` / `tools/dev/audit-bundle.mjs` | 建议保留并接 CI（已接）；size-limit 可作为备选方案 |
| 帧时间与 draw call | three.js `renderer.info` + `stats.js` + 本仓库 `scene-stats.mjs` | 固定机位采样，输出 JSON 入库比对 |
| 逐帧图形调试 | Spector.js（抓帧看每个 draw call/状态） | 定位 overdraw、状态切换、渲染目标问题 |
| 内存与 GC | Chrome DevTools Performance / Memory（堆快照对比） | "重开 3 次 ±10%"与"10 分钟漂移 ≤10MB"两条硬指标 |
| 上下文丢失演练 | `WEBGL_lose_context` 扩展 | `loseContext()` → 观察恢复；CI 里也可用 Playwright 触发 |
| 无障碍自动扫描 | axe-core（可配 Playwright） | 覆盖对比度/标签/焦点；游戏 canvas 部分仍需人工 |
| 移动端真机 | Chrome Remote Debugging / Safari 响应式设计模式 | 同时验证触控、安全区、性能档位 |

---

## 10. 参考来源

**游戏设计与打磨**

1. Juice It or Lose It（GDC Europe 2012，Jonasson & Purho）— https://gdcvault.com/play/1016487/Juice-It-or-Lose ｜视频 https://www.youtube.com/watch?v=Fy0aCDmgnxg
2. The Art of Screenshake（Jan Willem Nijman / Vlambeer，INDIGO 2013）— https://www.youtube.com/watch?v=AJdEqssNZ-U
3. Game Feel: The Secret Ingredient（Steve Swink）— https://www.gamedeveloper.com/design/game-feel-the-secret-ingredient
4. Finishing a Game（Derek Yu）— https://makegames.tumblr.com/post/1136623767/finishing-a-game
5. Vertical slice（术语与标准）— https://gamedesign.gg/glossary/vertical-slice/ ｜ https://en.wikipedia.org/wiki/Vertical_slice
6. The Door Problem（Liz England）— https://lizengland.com/blog/the-door-problem/
7. Game Accessibility Guidelines（full list / basic）— https://gameaccessibilityguidelines.com/full-list/ ｜ https://gameaccessibilityguidelines.com/basic/
8. Xbox Accessibility Guidelines（Microsoft Learn）— https://learn.microsoft.com/en-us/gaming/accessibility/guidelines
9. IGDA Game Accessibility SIG Guidelines — https://igda-gasig.org/get-involved/sig-initiatives/resources-for-game-developers/sig-guidelines/
10. A Short Hike Postmortem（GDC 2020，Adam Robinson-Yu）— https://www.gdcvault.com/play/1028679/Independent-Games-Summit-Crafting-A ｜报道 https://www.gamedeveloper.com/design/video-a-postmortem-look-at-the-making-of-i-a-short-hike-i-
11. Steam Page Checklist（Chris Zukowski）— https://howtomarketagame.com/wp-content/uploads/2020/03/SteamPageChecklistv1.pdf

**Web 前端质量**

12. Core Web Vitals 与阈值定义（web.dev）— https://web.dev/articles/vitals ｜ https://web.dev/articles/defining-core-web-vitals-thresholds
13. RAIL 性能模型 — https://web.dev/articles/rail
14. Performance Budgets 101 — https://web.dev/articles/performance-budgets-101
15. Optimize Long Tasks — https://web.dev/articles/optimize-long-tasks
16. Lighthouse Performance Scoring — https://developer.chrome.com/docs/lighthouse/performance/performance-scoring
17. MDN：WebGL Best Practices — https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
18. Khronos Wiki：Handling Context Lost — https://wikis.khronos.org/webgl/HandlingContextLost ｜WEBGL_lose_context 规范 https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/
19. WCAG 2.2 Quick Reference / Target Size (Minimum) — https://www.w3.org/WAI/WCAG22/quickref/ ｜ https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
20. MDN：prefers-reduced-motion — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
21. MDN：Autoplay guide — https://developer.mozilla.org/en-US/docs/Web/Media/Autoplay_guide
22. MDN：Page Visibility API — https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
23. Open Graph Protocol — https://ogp.me/
24. MDN：env() / safe-area — https://developer.mozilla.org/en-US/docs/Web/CSS/env ｜Gamepad API https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API ｜Web Storage https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API

**three.js 与 3D 技术**

25. three.js：How to dispose of objects — https://threejs.org/docs/#manual/en/introduction/How-to-dispose-of-objects
26. three.js manual：Optimize lots of objects（InstancedMesh）— https://threejs.org/manual/#en/optimize-lots-of-objects ｜InstancedMesh 文档 https://threejs.org/docs/#api/en/objects/InstancedMesh
27. three.js manual：Rendering on demand — https://threejs.org/manual/#en/rendering-on-demand
28. three.js：WebGLRenderer.info — https://threejs.org/docs/#api/en/renderers/WebGLRenderer.info ｜LOD https://threejs.org/docs/#api/en/objects/LOD
29. three.js：Color management — https://threejs.org/docs/#manual/en/introduction/Color-management
30. three.js examples / showcase — https://threejs.org/examples/
31. Unity：Optimizing draw calls（Graphics performance）— https://docs.unity.com/en-us/engine/6000.0/manual/analysis/graphics-performance-profiling/reduce-draw-calls/optimizing-draw-calls
32. Godot：Optimization using MultiMeshes — https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html
33. Gaffer On Games：Fix Your Timestep! — https://gafferongames.com/post/fix_your_timestep/
34. Arm：Mali GPU Best Practices / 移动图形优化 — https://developer.arm.com/community/arm-community-blogs/b/mobile-graphics-and-gaming-blog/posts/arm-mali-best-practices
35. Google：Slow Roads 案例研究（浏览器 3D 游戏）— https://web.dev/case-studies/slow-roads

**开源仓库与流程**

36. GitHub Docs：About community profiles（社区档案清单）— https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
37. OpenSSF Scorecard（含 checks 文档）— https://github.com/ossf/scorecard
38. Keep a Changelog — https://keepachangelog.com/en/1.1.0/
39. Semantic Versioning — https://semver.org/
40. Conventional Commits — https://www.conventionalcommits.org/en/v1.0.0/
41. Choose a License — https://choosealicense.com/
42. Reproducible Builds — https://reproducible-builds.org/
43. GitHub Actions 文档 — https://docs.github.com/en/actions
44. awesome-readme（README 参考集）— https://github.com/matiassingers/awesome-readme

**案例与评分体系**

45. Bruno Simon 作品集 — https://bruno-simon.com/ ｜源码（MIT）https://github.com/brunosimon/folio-2025
46. Slow Roads — https://slowroads.io/ ｜作者 2.0 技术帖 https://www.reddit.com/r/threejs/comments/1iekc71/
47. A Short Hike 官网 — https://ashorthike.com/
48. Tiny Glade — https://www.tinyglade.com/
49. Awwwards 评审体系（Design 40% / Usability 30% / Creativity 20% / Content 10%）— https://www.awwwards.com/about-evaluation/ ｜解析 https://exhibita.design/judged.html

**工具**

50. Lighthouse CI — https://github.com/GoogleChrome/lighthouse-ci ｜PageSpeed Insights https://pagespeed.web.dev/ ｜WebPageTest https://www.webpagetest.org/
51. size-limit — https://github.com/ai/size-limit ｜Playwright https://playwright.dev/ ｜axe-core https://github.com/dequelabs/axe-core
52. Spector.js — https://github.com/BabylonJS/Spector.js ｜stats.js https://github.com/mrdoob/stats.js ｜Chrome DevTools Memory https://developer.chrome.com/docs/devtools/memory/

---

### 附：本报告的核验说明

- 所有外部链接于 2026-10-16 经检索工具抓取或引用快照核对；GDC Vault 部分内容需登录，建议以官网页面标题为准引用。
- 项目现状判断基于静态审计（文件、`git` 状态、grep、bundle 审计输出），未运行游戏；"初评"分数仅用于确定投入优先级，运行验证后应更新。
- 未提交文件清单（截至审计时，且仍在变化中）：`.editorconfig`、`.github/`、`.scratch/`、`CHANGELOG.md`、`CODE_OF_CONDUCT.md`、`CONTRIBUTING.md`、`SECURITY.md`、`docs/research/`，以及 `tools/dev/` 下新增的若干审计/检查脚本（`audit-*.mjs`、`check-*.mjs`、`smoke-live.mjs`、`shot.mjs` 等）。审计期间该目录仍有并发变更，请以 `git status` 实时结果为准。
