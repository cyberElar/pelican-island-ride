# 提鹅鹏 · 单车环岛 — 内容深度与完整体验审计

> 审计类型：**只读内容审计**（未修改 `src/` 下任何文件；本报告为唯一新增产物）
> 项目：`D:\projects\vibecoding_tool_box\pelican-island-ride`
> 日期：2026-10-16　种子：`20261014`（默认）+ 抽样 1/2/3/5/8/13/21/42/100/777/2024/123456/999983/55555/31415926/8675309
> 结论基线：`src/` 源码 + `npm test`（8 套模块测试全绿）+ 无头 Edge 实测运行（`dist/game.js`，与根目录 `game.js` 哈希一致，构建时间晚于全部 `src`，故实测行为代表当前源码）

**审计方法**

1. 逐文件阅读 `src/world/landmarks.js`、`props.js`、`animals.js`、`gameplay/*.js`、`ui/hud.js`、`ui/menus.js`、`main.js`、`core/*.js`、`fx/*.js`、`registry.js`、`docs/SPEC.md`。
2. 运行 `node tools/dev/test-all.mjs`（8/8 通过）与 `test-props/test-landmarks/test-life/test-layout` 获取真实构建数字。
3. 用 `playwright-core` + 无头 Edge 对构建产物做 9 组运行时探针：静态场景统计、羽毛/碰撞体几何可达性分析（16 个种子）、计时赛状态机、40 根羽毛全量收集、地标发现计数、镜头模式粘滞、HUD 实时性、小地图刷新。
4. 所有结论均可回溯到 `file:line` 或探针实测输出。

---

### 审计快照与并发改动说明（重要）

- 审计基线：`git HEAD = 3301739`；审计开始时工作区仅有 1 个未跟踪文件（`tools/dev/smoke-live.mjs`）。
- **审计过程中检测到另一个会话正在并发修改同一个工作区**：`src/core/audio.js`、`src/core/engine.js`、`src/core/input.js`、`src/core/settings.js`、`src/fx/post.js`、`src/world/sky.js`、`src/main.js`，另新增 `.github/`、`CHANGELOG.md`、`tools/dev/audit-*.mjs` 等。其内容是性能/健壮性方向（像素预算、WebGL 上下文丢失恢复、设置版本化、音频挂起、输入硬重置），**与本次审计的 16 条缺陷没有重叠**；审计完成后已逐条复核，D1~D16 在当前工作区依然成立。
- 因此本报告中 `src/main.js` 的行号在并发改动合并后会漂移。下表给出最常引用锚点的对照，其余引用请以代码片段为准。

| 锚点 | 审计时行号 | 并发改动后行号 |
| --- | --- | --- |
| `minimapPoiBase` 构造 | `src/main.js:136` | `src/main.js:167` |
| `hud.setDiscoveredTotal(minimapPoiBase.length)` | `src/main.js:161` | `src/main.js:192` |
| `enterPhotoMode()` / 写死滤镜名「海风胶片」 | `src/main.js:240-245` | `src/main.js:279-284` |
| `onStart()` / 「开始骑行」toast | `src/main.js:272-285` | `src/main.js:312-324` |
| `bus.on('poi:discovered')` → `hud.setLetterbox(true)` | `src/main.js:369-371` | `src/main.js:446-448` |
| `ORDER`（含 `'hud'`） | `src/main.js:378-380` | `src/main.js:574-576` |
| `modules.hud?.update?.(dt, state)`（D1 关键行） | `src/main.js:442` | `src/main.js:649` |
| `input.pressed('reset')` | `src/main.js:399` | `src/main.js:595` |

---
## A 段 · 现状清单（核实后的真实数字与功能）

### A.1 世界与内容规模（实测）

| 项目 | 实测值 | 证据 |
| --- | --- | --- |
| 世界尺寸 / 陆地占比 | 6000 × 6000 m，陆地 43.8%，高度 -105 ~ 397 m | `src/core/settings.js:5`；`test-layout` 输出 |
| 环岛公路 | 10 946 m，最大坡度 12.7%，出生点 (0, 1620) | `src/world/layout.js`（`test-layout` 输出） |
| 地标 Set-piece | **20 个**（`landmarks.stats.count = 20`，163 mesh，26 194 tri，9 collider，1 emitter） | `src/world/landmarks.js:257`；`test-landmarks` 输出 |
| 地标清单 | lighthouse / standingStones / treehouse / ruins / seaArch / seaStacks / lakePavilion / lakeJetty / balloons / summitCairn / observatory / summitFlag / gates / bridge / waterfall / shipwreck / ropeSwing / picnic / viewpoint | `src/world/landmarks.js:312-1789`（20 处 `createPiece`） |
| 村庄/港口等 | props.js 负责：16 栋村屋 + 2 栋礼拜堂小屋（**随种子 1~16 波动**）、市场喷泉、晒衣绳、14 根灯柱 + 108 片灯罩、292 段矮墙、149 段护栏、5 座石堆、4 座便桥、港口 4 浮 2 搁浅船 | `src/world/props.js:870`、`src/world/props.js:887`；探针 11 个种子 |
| 道具/建筑总数 | 1564 件道具 / 28 栋建筑 / 118 碰撞体 / 22 烟囱（运行时 low 下 1404/28/460 全局碰撞体） | `test-props` 输出；探针 `colliderCount: 460` |
| 植被 | 乔木 1090（45 变体）、草 27 591、花 5838、岩石 613、灌木 518、芦苇 1890、睡莲 183、海草 351、浮木 68、贝壳 99；树碰撞体 107 | `test-vegetation`；探针 `vegetation.stats` |
| 生物 | **high/ultra 234 只**（medium 163 / low 106）：海鸥 12、鸭 10、苍鹭 2、野兔 10、鹿 4、蟹 12、蝴蝶 30、蜜蜂 16、萤火虫 120、鱼 14、鲸 1、海豚 3 | `src/world/animals.js:436-1554`；`test-life` 输出 |
| 生物行为 | 海鸥拍翅/滑翔/降落、鸭潜水+涟漪、苍鹭摆头+跳、野兔跳+**10 m 内逃跑**、鹿吃草/定住/小跑、蟹侧行+陷沙、蝴蝶/蜜蜂、萤火虫夜间跟人 90 m、鱼跳水、鲸 36 s 一次跃出+喷水 sprite、海豚 3 只弧线跃水 | `src/world/animals.js:11-13`、`:816-828`、`:1459-1520`、`:1553-1600` |
| 粒子 | 6 族（dust/smoke/leaf/spray/confetti/spark），池 2026（low 525），运行时 24 个 emitter；bursts：dust / waterSplash / leaves / sparkle / confetti / smokePuff | `src/world/particles.js:33`、`:684-690`；探针 `emitters: 24` |
| 天空 | 大气渐变、日/月盘、星空、银河带、1~3 层云；**无极光、无流星** | `src/world/sky.js:148-164`、`:264` |
| 天气 | 雨（900 段 line）+ 26 团晨雾/暮霭 + 雾密度耦合；每 150~420 s 掷一次，14% 概率下雨 | `src/fx/weather.js:16`、`:51`；`src/gameplay/events.js:120-126` |
| 后期 | bloom、god rays、split-tone 调色、暗角、色散、胶片颗粒、SMAA、ACES、PMREM 环境图（≤8 s 重算一次）、拍照 DOF（半分辨率 depth 预处理） | `src/fx/post.js:196-300`；`src/world/environment.js:118` |
| 音频 | 全合成：风/浪/林鸟/蟋蟀/夜虫/猫头鹰/海鸥/钟声/胎噪（6 种路面 EQ）/链条/车铃/水花/摔车/拾取/发现/烟花/加速/刹车/雷（**从未触发**）；生成式音乐（和弦进行 + pad + pentatonic pluck + kick/hat），强度随时间/速度/靠近 POI 变化 | `src/core/audio.js:55-92`、`:1416-1428`、`:1170-1334` |
| 收集品 | **40 根羽毛 = 沿环岛路 18 根（交替左右 3.4~8.5 m）+ POI 周边 22 根**，拾取半径 2.5 m，`InstancedMesh` 原地消失 | `src/gameplay/collectibles.js:12`、`:52`、`:63`、`:121` |
| 地标发现 | 代码内 `DISCOVERABLE` **25 条**（letterbox 名卡 + 音效 + 慢速时 7 s 环绕运镜） | `src/gameplay/events.js:11-38`、`:145-153` |
| 计时赛 | 8 个门（`t = i/8` 环岛均布）+ 必须按序 + 最佳圈存 `localStorage['pelicanIsland.bestLap']` | `src/gameplay/events.js:44`、`:53`、`:80`、`:202` |
| 昼夜 | 900 s 一整天（15 min），5 个时间预设键（T 键），夜间地标自发光由 `state.hour` 驱动（12 处 `registerNightLight`） | `src/core/settings.js:9`；`src/world/landmarks.js:288-1535`、`:1842` |
| 相机 | chase / firstPerson / cinematic / photo / tour 五模式；FOV 随速度 54→67；摔车 shake；空闲 7 s 自动电影镜头 | `src/gameplay/camera.js:1-7`、`:106-115`、`:160-175`；`src/gameplay/events.js:227` |
| 存档 | **只有 2 个键**：`pelicanIsland.settings`（画质/音量/静音/时间模式）、`pelicanIsland.bestLap` | `src/main.js:305-313`、`src/gameplay/events.js:53`；探针 `localStorageKeys` |
| 输入 | KEY_ACTIONS 20 条，**实际接线 11 条**；手柄：左摇杆 + RT/LT + A | `src/core/input.js:9-29`、`:105-118`；`src/main.js:385-419` |

### A.2 README / SPEC 与实现的偏差（逐条纠正）

| 文档说法 | 实现真相 | 证据 |
| --- | --- | --- |
| README「**28 discoverable landmarks**」 | 实际可发现 **25 个**；HUD 分母却是 **28**（把 `spawn`/`gates`/`pool` 也算进去了），因此**永远到不了 28/28**（最多 25/28） | `src/main.js:136-161`（pois 32 个 − 4 区域 = 28）vs `src/gameplay/events.js:11-38`（25 条） |
| README「**21 hand-built landmarks**」 | `landmarks.stats.count = 20`（landmarks.js）；村庄/港口/农田在 props.js，属另一类 | `test-landmarks`：`stats: count=20` |
| README「Seabreeze Village (**16 houses**)」 | 目标 16 栋，但**随种子最低 1 栋**（seed 2024 → 1、777 → 2、5 → 4） | `src/world/props.js:870`；探针 11 种子 |
| README「**234 creatures**」 | 仅 high/ultra；medium 163、low 106 | `src/world/animals.js`（`test-life`：`low=106 medium=163 high=234 ultra=295`） |
| About 页「手柄与触屏同样可用 · **GAMEPAD & TOUCH SUPPORTED**」 | 触屏代码存在但**无人调用**（`setTouchAxes` / `touchButton` 零引用），移动端只有画质降级，**没有任何触屏 UI** | `src/ui/menus.js:630`；`rg setTouchAxes src/` → 仅 `src/core/input.js:87` |
| HUD 提示「收集金色羽毛可以**解锁纪念册**」/ "feathers fill the **almanac**" | 项目中不存在纪念册/相册/成就页 | `src/ui/hud.js:78`、`:106` |
| SPEC 4.22「photo-mode overlay (grid, focal length, **filters**)」「photo **gallery** hint」 | 只有一格静态标签「海风胶片」，**没有任何滤镜实现或切换**；没有相册 | `src/main.js:245`（写死 filterName）；`src/fx/post.js`（无 filter 分支） |
| SPEC §5 事件契约 `photo:enter` / `photo:exit` / `sfx:music:intensity` / `time:hour` | **从不发出**（HUD 有监听者，音乐强度外部 boost 通道永远为 0） | `rg "photo:enter" src/` → 仅 `src/ui/hud.js:1297-1298`；`src/core/audio.js:1540` 无发送方 |
| README「Enter 开始计时赛」等操作表 | 文案与实现不符：菜单写「R 重置视角 RESET VIEW」，实现是**回到最近路面**；H/E/V/Digit1-3 是死键 | `src/ui/menus.js:59-77`；`src/core/input.js:19-29` vs `src/main.js:385-419` |

---

## B 段 · 差距分析（10 维）

### B1. 首次体验 / 上手（first 5 minutes）

- **现状证据**：标题页有 5 个按钮 + 一行按键提示（`src/ui/menus.js:363-441`），并有独立的「关于与操作」页含 15 行按键表（`src/ui/menus.js:59-77`、`:616-631`）。点「开始骑行」→ 一条 toast「按住 W 加速 · C 切换相机 · M 地图」（`src/main.js:285`）。**没有教学、没有目标提示、没有可交互引导**；小地图默认关闭（实测 class 无 `is-on`），HUD 的时速表/时钟/罗盘因缺陷 D1 全部冻结（`0` km/h、`17:10`、`000°`）。「开始骑行」与「自由环游」两个按钮走**完全相同**的分支（`src/main.js:272-289` 只有 `photo` 特判）。
- **行业常见标准**：开放世界/骑行类作品在 30 秒内用「目标提示 + 首个可完成的小任务」建立动线（A Short Hike 的任务卡、Alba 的拍照指引、Forza Horizon 的首次导航），并把操作说明做成**情境式**而非只放设置页。
- **差距**：玩家进入后没有任何「现在该做什么」的信息通道；仅有的情境提示不到 9 个字且 3.5 s 后消失；两个起始按钮语义重复。
- **建议**：3 步情境教学（骑行 30 m → 拾取 1 根羽毛 → 打开地图），把第一根羽毛固定生成在出生点前方，HUD 常驻「最近羽毛 ↗ 320 m」目标条；两种起始模式给出差异（引导式 / 纯自由，后者隐去所有提示）。

### B2. 核心循环与目标层级

- **现状证据**：即时目标 = 随便骑（无）；短期 = 拾羽毛（40）与发现地标（25）；长期 = 破自己最佳圈速（`bestLap` 单值，`src/gameplay/events.js:53-80`）。进度可视化只有 2 个 HUD 芯片：羽毛 `0 / 40`（`src/ui/hud.js:285`、事件驱动更新正常）与「已探索 X / 28」（`src/ui/hud.js:277`，**分母错误**）。里程碑只有 3 条羽毛 toast（1/10/40，`src/gameplay/events.js:160-168`）；`milestones.village` / `bridge` 只置位不提示（`src/gameplay/events.js:170-183`）。收集 40 根后只有一句 toast + confetti（`src/gameplay/events.js:162-168`），**没有结局、没有完成界面**。
- **行业常见标准**：收集类作品标配「分区完成度 + 里程碑播报 + 完成结算界面/结局演出」，且进度**跨会话保存**。
- **差距**：无进度存档（见 D3）→ 40 羽毛在事实上不可完成（需单次会话骑满约 11 km 环线 + 全部离路点位）；无中期目标（10→40 之间空档）；完成无结算。
- **建议**：成就/纪念册系统 + 完成结局运镜 + 分区进度（东/南/西/北）与「下一步」推荐。

### B3. 奖励与反馈（juice）

- **现状证据**：拾取 = 音效（**双触发**，见 D6）+ 14 粒 sparkle + HUD 芯片脉冲（`src/gameplay/collectibles.js:121-127`；`src/ui/hud.js:1213-1225`）；发现地标 = discovery 音效（双触发）+ letterbox 名卡 + 慢速时 7 s 环绕运镜（`src/gameplay/events.js:145-153`）；速度感 = FOV 54→67 与侧向推镜（`src/gameplay/camera.js:163-200`）；摔车 = shake + 红闪（`src/gameplay/camera.js:122-124`；`src/main.js:372`）；圈速完成 = 烟花音 + confetti（`src/gameplay/events.js:87-89`）。**缺少**：连击/连续拾取、拾取计数播报音阶、屏幕内数量提示、里程/速度里程碑、任何「+1」浮字。
- **行业常见标准**：拾取反馈遵循「音高递增 + 视觉爆发 + 计数动画 + 每 N 个一次大反馈」四件套，且**每个 N 都有播报**（Mario/Kirby/Spyro 传统）。
- **差距**：反馈点集中在 1/10/40 三处；无节奏/强度递增；letterbox 反而会**卡住不消失**（D4）造成负反馈。
- **建议**：拾取音高随连拾递增 + 飘字 + 每 5 根一次播报；「连续 5 根不摔车」combo；地标发现按区域累计播报。

### B4. 可玩性深度

- **现状证据**：物理为单速自行车模型——加速 7.4、刹车 11.5、最大 13.2 m/s（boost 16.6，键鼠 Shift 消耗/回复 stamina `src/gameplay/controls.js:12-14`、`:91-96`）；6 种路面摩擦表（`src/gameplay/controls.js:22-29`）；坡度重力 `a -= slope * 7.0`（`:128-131`）；跳跃仅在「前方落差 > 1.2 m 且速度 > 6.5」时被动触发（`:172-189`）；摔车 = 0.85 s 失控 + 速度 ×0.32（`:160-166`），**无里程/时间惩罚、无摔车动画状态**。**没有**：主动跳跃、翘头/滑行/漂移、刹车痕迹、特技、连击、危险物（无野生动物撞击、无落石、无风阻）。天气对玩法**零影响**：`state.wind` 只喂植被 shader 与雨滴漂移，`controls.js` 完全不读 wind/rain；雨天不打滑、不减速。
- **行业常见标准**：骑行/滑板类至少要 2~3 个主动技巧（跳跃、漂移、加速带）+ 失败代价 + 地形分级；天气应至少改变抓地力或视野。
- **差距**：操作深度接近「能转向的加速/刹车」，技巧表达为零；风险与回报结构缺失（抄近路走草地只损失速度，无实际惩罚）。
- **建议**：主动 hop（Space 短按）+ 高速急刹漂移（留痕）+ 空中姿态；把 wet 因子接入摩擦表；摔车扣时间/破圈有效性。

### B5. 重复可玩性

- **现状证据**：计时赛只有 1 条环岛路线（8 门均布，`src/gameplay/events.js:44-50`）；成绩只有 1 个 `bestLap`（`src/gameplay/events.js:53`、`:80`）；无分段计时、无幽灵、无排行榜、无难度、无每日/种子挑战入口（`?seed=` 只能手工改 URL，`src/main.js:44-46`）；无 HUD-hide 挑战（V 键未接线）；无速通/DLC 式额外目标。
- **行业常见标准**：单赛道计时赛至少提供「分段 / 幽灵 / 多难度或路线变体 / 本地成绩榜」中的 3 项，才会产生二次挑战动机。
- **差距**：内容层面仅 1 次可挑战 → 破纪录后动机归零；`?seed=` 的重玩潜力完全未被界面化。
- **建议**：多赛道（环线/北岸/湖畔/越野）+ 幽灵回放 + 分段表 + 本地 Top5 + 每日种子挑战。

### B6. 世界叙事与氛围

- **现状证据**：地标全部程序化建模且质量高（灯标夜间旋转光束、热气球漂移、水车轮、风车、教堂+墓地、船骸、绳秋千、观景长椅，`src/world/landmarks.js:1843-1900`）；夜间 12 处自发光材质（`src/world/landmarks.js:288-1535`）；生物有分工行为（见 A.1）；音景分层（风/浪/林鸟/蟋蟀/猫头鹰/海鸥 + 6 路胎噪 EQ，`src/core/audio.js:55-92`）。**但没有**：任何 NPC、任何对话/文本叙事、任何「稀有/奇观」事件（无鲸群跃水群像、无流星雨、无极光、无彩虹），村庄只是静态房屋集合（村屋 + 晒衣绳 + 邮筒 + 菜园，无人在活动）；`shipwreck`/`ruins`/`standingStones` 无任何旁白或碑文。
- **行业常见标准**：环境叙事至少靠「可读文本（碑文/路牌/日志）+ 少量 NPC 或拟人化生物反馈 + 1~2 个稀有奇观」建立发现惊喜；村里应有生活迹象（晾衣、集市、猫）。
- **差距**：世界是「美丽的布景」而非「有故事的岛」；亲眼看见稀有事件的概率 ≈ 0（鲸 36 s 一次但只在离岸 3200 m 处，玩家几乎看不到）。
- **建议**：5~8 处碑文/路牌可交互文本 + 村民 NPC（沿路散步、招手、招手镜头）+ 稀有事件调度器（雨后彩虹、夜间流星雨、鲸群靠近港湾）。

### B7. 摄影 / 分享

- **现状证据**：拍照模式具备自由飞行（WASD + Shift/Space 升降）、滚轮变焦 18~95°、`F` 三分网格、DOF（焦点跟随骑手距离，`src/fx/post.js:279-288`）、焦距 MM 显示、`P` 退出（`src/gameplay/camera.js:268-292`；`src/ui/hud.js:361-380`）。**没有**：滤镜切换（只有写死标签）、曝光/光圈/焦距手动控件、隐藏 HUD、单键截图/导出、水印署名、录制/GIF。
- **行业常见标准**：拍照模式（Horizon/Ghost of Tsushima/Spider-Man）标配「滤镜切换 + 光圈/曝光 + 隐藏 HUD + 一键导出/分享」；截图能直接落盘是基本体验。
- **差距**：当前拍照模式**能看不能带走**——玩家只能靠系统截图，构图参数不可调，MM 读数与滤镜标签还因 D1/D8 冻结。
- **建议**：3~5 组 uniform 滤镜 + 光圈/曝光滑杆 + HUD 一键隐藏 + `renderTarget` readPixels → PNG 导出（带署名水印）+ 相册页。

### B8. 元系统

- **现状证据**：设置只有 4 组：画质（4 档）、时间模式（5 档）、语言（zh/en）、3 条音量 + 静音（`src/ui/menus.js:24-57`、`:497-604`）；存档只有 settings + bestLap；**没有**重置进度、没有统计页（`distanceTravelled` 每帧累加但从不展示也从不保存：`src/gameplay/controls.js:198`，全项目仅此一处引用）、没有难度、没有按键重映射、没有镜头灵敏度、没有 HUD 缩放/字幕/无障碍。
- **行业常见标准**：设置页三段式（画面 / 声音 / 操作+辅助），存档含进度与统计，且提供「重置进度」入口。
- **差距**：作为展示级项目缺少「元层可信度」；统计已有原始数据却完全浪费。
- **建议**：统计页（总里程/时长/摔车/最高速/完成度）+ 重置进度 + 音量外的辅助项（HUD 缩放、字幕语言随界面语言）。

### B9. 内容量 vs「展示级」同类项目

- **现状证据**：程序化资产密度非常高（484 geometry / 195 texture / 1090 树 / 234 生物 / 6 粒子族 / 20 地标 / 40 收集品 / 8 门），美术与音频质量明显高于一般 web demo。
- **单薄处（可核实）**：
  1. 只有 1 种降水天气（雨），无雪/雷暴/大风天，且天气不改变玩法（见 B4）；
  2. 夜晚只有自发光材质 + 萤火虫，**没有一盏真实动态光源**（nightLights 全部是 `emissiveIntensity`，`src/world/landmarks.js:1840-1842`），村庄夜里不会「亮起来」；
  3. 生物是循环动画 + 有限状态（兔子 10 m 内逃跑是唯一「被玩家影响」的行为）；它们不与玩家产生任何交互反馈（撞击/受惊/跟随）；
  4. 村庄为静态房屋集合（无 NPC、无事件、无昼夜活动、无任务），房屋数量还会随种子跌到 1 栋（D10）；
  5. 无 NPC、无对白、无任务、无结局、无成就（`milestones` 只有 6 个有效项）。
- **行业常见标准**：同量级「展示级」项目通常用「1 个主角 + 3~10 个可交互角色 + 1 条主目标线 + 2~3 种玩法变体」撑住 20~40 分钟体验；本项目在 5~10 分钟后进入重复。
- **差距**：广度（美术/程序化）已达展示级，**深度（系统/叙事/目标）停留在技术 demo**。
- **建议**：优先补「系统深度」而非再堆资产：成就、纪念册、天气玩法、村民、稀有事件、多赛道。

### B10. 可能的 bug / 逻辑漏洞（摘要，明细见 D 段）

- HUD 逐帧更新从未执行（时速表/时钟/罗盘/小地图全部冻结）——**P0**
- 「已探索 X / 28」永远无法达成——**P0**
- 进度不存档（40 羽毛无法跨会话完成）——**P0**
- 发现地标后 letterbox 永久常驻、镜头永不再回到跟随、`C` 键索引错位——**P1**
- 拾取/发现/摔车音效双触发——**P1**
- 计时赛：倒计时期间可自由骑行且起跑门被立即消耗；只校验 8 个门，可直线穿岛抄近路（实测 1.93 s 完成一圈）——**P1**
- 深水 = 隐形墙且会卡住玩家（只能按 R）——**P1**
- 羽毛摆放不做地形/碰撞校验，抽样中最小碰撞余量 1.96 m（可达阈值 2.29 m）；7~12/40 落在 >32° 坡面——**P2**
- 帧率下降时树木碰撞穿透（dt 上限 0.1 s × 25.6 m/s = 2.56 m/帧）——**P2**
---

## C 段 · 增值功能提案 Top 12

> 优先级定义：**P0** = 不做则产品承诺不成立（含必修缺陷）；**P1** = 强烈建议，直接提升留存与口碑；**P2** = 可选增强。
> 代码量均为「新增/修改行数」估算（含必要注释，不含测试）。

### C1 [P0] 让 HUD 「活过来」：接线 `hud.update` + 修正进度分母

- **玩家价值**：时速表、数字车速、时钟、昼夜阶段、罗盘、小地图、圈速计时器全部恢复实时刷新——这是玩家读懂游戏状态的唯一通道，目前 100% 失效。
- **实现要点**：
  - `src/main.js:442` 把 `modules.hud?.update?.(dt, state)` 改为直接调用 `hud.update?.(dt, state)`（HUD 不是 registry 模块，`modules.hud` 恒为 `undefined`）；或把 `hud` 也注册进 `src/registry.js` 并允许 `factory(ctx)` 拿到 `options.minimapData/container`。
  - `src/gameplay/events.js:214-218` 补 `state.race.total = RACE_GATES`（否则面板会显示 `x/28`）。
  - `src/main.js:136-161` 的 `minimapPoiBase` 过滤掉 `spawn`/`gates`/`pool`，或直接使用 `DISCOVERABLE.length` 作为「已探索」分母（同时修好 D2）。
  - `src/main.js:370` 的 `hud.setLetterbox(true)` 改为延时自动关闭（4 s），不要走 `letterboxUser` 常驻路径。
- **风险**：极低（接线与常量）；唯一注意点是小地图重绘已有 8 Hz 节流（`src/ui/hud.js:36`），无需新增性能预算。
- **代码量**：约 15 行。

### C2 [P0] 进度存档与统计：`save.js` + 重置进度 + 统计页

- **玩家价值**：40 根羽毛、25 个地标、最佳圈速、总里程、游玩时长、摔车次数可跨会话累积，收集行为才具备意义；「重置进度」让种子挑战/重玩成立。
- **实现要点**：
  - 新增 `src/gameplay/save.js`：`load()` / `save(patch)` / `reset()` / `migrate()`，键名 `pelicanIsland.save.v1`，结构 `{ v, seed, feathers: number[], discovered: string[], bestLap, laps: number[], stats: { distance, playTime, crashes, topSpeed }, updatedAt }`，写入用 500 ms debounce，兼容读取旧 `pelicanIsland.bestLap`。
  - 接线：`src/gameplay/collectibles.js:126`（拾取）与 `src/gameplay/events.js:150`（发现）后 `save.markFeather(i)` / `save.markPoi(id)`；`src/main.js` 在 boot 后按存档恢复 `state.feathers.collected` 与 `state.discovered`，并在初始化时把 `list[i].collected` 置位（需给 `collectibles` 暴露 `applyProgress(savedIndexes)`）。
  - 统计：每 30 s 与 `beforeunload` 写入 `state.player.distanceTravelled`（已有累加，`src/gameplay/controls.js:198`）。
  - UI：`src/ui/menus.js` 暂停页加「统计」卡片，设置页「其他」区加「重置进度（需二次确认）」按钮（复用 `section/row/button` 组件）。
- **风险**：旧存档字段缺失需默认值；恢复位置不要直接写 `player.position`（避免卡进地形），恢复进度但保留出生点出生。
- **代码量**：约 200 行（save.js 120 + 接线 40 + UI 40）。

### C3 [P0] 首次体验引导：3 步情境教学 + 目标条 + 教学羽毛

- **玩家价值**：5 分钟内知道「我是谁 / 去哪 / 做什么」，把标题页的按键表变成可执行动作。
- **实现要点**：
  - 新增 `src/ui/tutorial.js`（约 180 行）：状态机 `ride30m → firstFeather → openMap`，每步给出 1 条横幅 + 1 个勾选条件；监听 `state.player.distanceTravelled`、`bus.on('feather:collected')`、`input.pressed('map')`；任一步完成后自动隐藏，`Esc` 或 90 s 超时跳过；完成后写入 `pelicanIsland.tutorialDone`。
  - 目标条：在 `src/ui/hud.js` 增加 `#pi-objective` 面板（复用 `.pi-chip` 样式），由恢复后的 `hud.update` 每 0.25 s 计算「最近未收集羽毛」的距离与相对方位角（`state.player.heading` vs `atan2(dx,dz)`），显示「金色羽毛 320 m ↗」；数据源：`options.minimapData()` 里附带最多 40 个羽毛坐标（`src/main.js:136-146`）。
  - 教学羽毛：`src/gameplay/collectibles.js:52-60` 把索引 0 的环岛羽毛改为固定生成在 `layout.pois.spawn` 沿 heading 方向 40 m、路边 2.5 m（保证第一分钟必得）。
  - 标题页：把「开始骑行 / 自由环游」改为「开始骑行（含引导）」/「自由环游（无提示）」，并在按钮下加一行说明（`src/ui/menus.js:363-392`）。
- **风险**：引导过强会破坏「无压力散步」气质 → 默认只出现一次、随时可关；不要阻断输入（无模态弹窗）。
- **代码量**：约 240 行。

### C4 [P1] 计时赛 2.0：多赛道 + 幽灵回放 + 分段计时 + 本地 Top5

- **玩家价值**：给「再来一次」提供 4 倍以上的动机，是重复可玩性的核心。
- **实现要点**：
  - `src/gameplay/events.js:44-50` 抽出 `buildTrack(spec)`，`spec` 支持 `{ gates: [...t], requireRoad: true|false }`；新增 3 条赛道：北岸环线（t 0.5→1.0 往返）、湖畔线（含 `layout.spurs` 采样）、越野赛（环岛 + 峰顶 spur，禁用抄近路惩罚）。
  - 新增 `src/gameplay/ghost.js`（约 150 行）：每 0.1 s 记录 `{t, x, z, heading}` 到预分配 `Float32Array`（20 min 上限 = 12000 采样 ≈ 144 KB），结束时用 Int16 delta + base64 存 `pelicanIsland.ghost.<trackId>`；比赛中以半透明骑手（复用 `src/character/rider.js` 的 group，`material.transparent`）插值重放。
  - 分段：HUD 圈速面板加 8 行分段表（`hud.setRace` 扩展 `splits: number[]`），显示与 best 的差值颜色。
  - 排行榜：`src/ui/menus.js` 新增「计时赛」子页（赛道选择 + 本地 Top5 + 「开始」按钮，直接调用 `modules.events.startRace(state, trackId)`）。
- **风险**：新增赛道可能压到陡坡/无路区（需用 `layout.projectToRoad` 校验每个门的可达性）；幽灵数据要限制条数以控存储。
- **代码量**：约 450 行。

### C5 [P1] 拍照模式 2.0：滤镜 + 参数控件 + 一键导出（含水印）+ 相册

- **玩家价值**：展示级项目的口碑传播闭环——目前「能看不能带走」。
- **实现要点**：
  - 滤镜：`src/fx/post.js` 的 `GradeShader` 增加 `uLutStrength` 与 4 组预设 uniform（暖胶片/青橙/黑白/正片），`createPost` 暴露 `setFilter(index)`；`src/gameplay/camera.js` 的 `photo` 增加 `filter` 字段与 `nextFilter()`；按键直接用已定义却闲置的 `Digit1-4`（`src/core/input.js:29`）。
  - 参数：光圈 `[` `]`、曝光 `-` `=`（写入 `post.setPhoto({ aperture })` 与 `renderer.toneMappingExposure`），焦距 MM 读数改为每帧刷新（修好 C1 后自动生效）。
  - 导出：`src/core/engine.js` 已支持 `?preserve=1`；导出时改为「同一帧内 `renderer.setRenderTarget(rt)` → `readRenderTargetPixels` → `ImageData` → canvas → `toBlob` → `a[download]`」，文件名 `pelican-YYYYMMDD-HHMMSS.png`，水印（署名 + 种子 + 时间）用离屏 canvas 叠加；`H` 键已定义（`src/core/input.js:19`）但未接线 → 直接复用为「隐藏 HUD」。
  - 相册：新增 `src/ui/gallery.js`（约 120 行），缩略图存 IndexedDB（`pelicanShots`，单张 256×144 JPEG ≈ 15 KB，上限 60 张）。
- **风险**：`readPixels` 必须与渲染同帧且需在 composer 之后的 `outputPass` 目标上读取；`file://` 下 `download` 属性可用但需 `URL.createObjectURL` 兜底。
- **代码量**：约 320 行。

### C6 [P1] 天气进入玩法 + 稀有奇观（雷暴 / 彩虹 / 流星雨）

- **玩家价值**：把「天气只是背景」变成「这个时刻值得记住/值得重玩」。
- **实现要点**：
  - 玩法耦合：`src/gameplay/controls.js:22-29` 的 `SURFACE` 增加 `wetGrip` 因子，`update()` 中读取 `state.weather.rain`（>0.3 时沥青 `roll ×1.35`、刹车距离 +20%、转向 authority −10%），并在水洼溅水时复用 `particles.bursts.waterSplash`。
  - 天气状态机：`src/gameplay/events.js:120-126` 由「每 150~420 s 掷骰」升级为 `clear → overcast → rain → storm → clearing` 曲线，storm 期间 `state.wind.strength = 1.2`、雨量 0.9、并触发 `bus.emit('sfx', { name: 'thunder' })`（音频已实现，`src/core/audio.js:1420`，从未被调用）+ `environment` 太阳强度瞬时尖峰模拟闪电。
  - 彩虹：`src/world/sky.js` 增加一个可复用的弧带 mesh，出现条件 = 雨停后 45 s 内且 `hour ∈ [16, 18]`，朝向背阴方向。
  - 流星雨：`src/world/sky.js` 在 `hour ∈ [1, 4]` 且 `seed % 7 === 0` 的岛屿上，按 40 颗/分钟的周期生成短促 star streak（着色器内加 `uMeteorPhase`，避免新几何）。
- **风险**：闪电补光与 bloom 叠加可能过曝；彩虹弧需要正确的朝向与地形遮挡处理（可用 `depthWrite:false + renderOrder` 简化）。
- **代码量**：约 380 行。

### C7 [P1] 成就系统：18 项成就 + 成就页 + 进度播报

- **玩家价值**：补上「中期目标层」，让 25 地标 / 40 羽毛 / 8 门之外还有可追求的清单。
- **实现要点**：
  - 新增 `src/gameplay/achievements.js`（约 200 行）：`{ id, zh, en, check(state, bus), progress }` 定义 18 项，例如「首根羽毛 / 10 / 20 / 30 / 40」「八大地标各一」「夜访灯塔（hour>20.5 且距离<120）」「雨中骑行 5 km」「日出与日落各看一次」「登顶 320 m」「单圈 < 4:00」「不摔车骑完一圈」「摔车 10 次也不放弃」「拍照 10 张（依赖 C5）」「发现全部 25 个地标」。
  - 数据源：已有 `bus` 事件（`feather:collected` / `poi:discovered` / `rider:crash` / `race:finish`）+ 每 1 s 采样 `state`；解锁写 `save.js`，弹出复用 `hud.toast` 样式加金色边框。
  - UI：`src/ui/menus.js` 新增「成就」页（2 列网格，已解锁高亮/未解锁灰度 + 进度条），标题页与暂停页各加入口。
- **风险**：与 C2 强耦合（需先有存档）；成就判定要防重复触发（用 `unlocked` set）。
- **代码量**：约 320 行。

### C8 [P1] 结束感：纪念册（Almanac）+ 收集完成结局演出

- **玩家价值**：兑现 HUD tips 里已承诺的「纪念册」，并给 40/40 一个真正的终点。
- **实现要点**：
  - 新增 `src/ui/almanac.js`（约 250 行）：40 张羽毛卡（编号、拾取时间、所在区域/最近地标、距离出生点距离）；25 张地标卡（名卡缩略图：进入区域时用 C5 的截图管线抓一张 256×144 存 IndexedDB）；未收集显示为剪影 + 「未知」。
  - 入口：标题页第 6 个按钮 + 暂停页；网格用 CSS 变量控制 4/6/8 列响应式。
  - 结局：`src/gameplay/events.js:162-168` 收集完成后触发 `bus.emit('finale')` → `src/gameplay/camera.js` 新增 `finale` 模式：沿 `tourCurve` 的 0.55→0.75 段飞向灯塔，8 s 内叠加字幕（3 句）+ 最终统计（总里程/时长/最大速度），结束后回到标题并标记 `pelicanIsland.cleared`。
- **风险**：IndexedDB 写入失败要静默降级（只存文本卡）；结局长镜头要避免穿地形（复用 camera 的 `heightAt` 下限保护）。
- **代码量**：约 400 行。

### C9 [P1] 操控深化：主动跳跃 / 漂移留痕 / 特技连击

- **玩家价值**：把「会骑」升级为「骑得帅」，是骑行类作品的核心表达与二次游玩动机。
- **实现要点**：
  - `src/gameplay/controls.js`：新增 `p.trickState`（idle / hop / air / drift / slide）；`Space` 短按（<180 ms）触发主动 hop（`p.velocity.y = 4.6`，`airTime` 路径已存在 `:172-189`）；速度 > 9 且 `brake > 0.6` 且转向 → `drift`，`lean` 上限放宽到 0.62，速度衰减改为侧滑角函数；空中按 `S` 触发后轮点地。
  - 新增 `src/world/skids.js`（约 140 行）：预分配 256 段 ribbon（`BufferGeometry` + `DynamicDrawUsage`），漂移时按 `p.position` 写左右两条轨迹顶点与 alpha，60 s 后循环覆盖；材质用现有 `textures` 的 roughness 贴图。
  - 反馈：漂移中 `camera.addShake(0.06)` + `particles.bursts.dust`；HUD 增加连击芯片「COMBO ×3」（连续漂移/腾空且未摔车），并把 `state.player.tricks` 纳入 C2 统计与 C7 成就。
- **风险**：漂移会改变计时赛最优解 → 让技巧只影响分数/统计，不改变物理极速，避免破平衡。
- **代码量**：约 350 行。

### C10 [P1] 村民与环境叙事：NPC + 可读文本 + 村庄生活

- **玩家价值**：让岛「有人住」，把静态布景变成叙事场；同时也是拍照模式的绝佳素材。
- **实现要点**：
  - 新增 `src/world/villagers.js`（约 260 行）：8~12 个低多边形村民（复用 `src/world/animals.js` 的 `bakeParts` + InstancedMesh 思路，每个村民 3~4 个部件），行为：在村中固定路径往返、码头钓鱼、广场长椅休息、路过时招手（距离 < 12 m 且玩家速度 < 6 触发招手动画 + `bus.emit('sfx',{name:'bell',volume:0.3})`）。
  - 可读文本：`src/world/landmarks.js` 在 6 处地标（石阵/教堂/船骸/废墟/树屋/观景台）加木牌 mesh + 交互提示（`E` 键已定义却闲置，`src/core/input.js:25`）；按 E 弹出 `hud` 文本卡（3~4 句背景故事，中英双语）。
  - 村庄日常：`src/world/props.js` 的晒衣绳/集市摊位与时间段绑定（`state.hour` 6-9 摊主摆摊、18-21 灯笼点亮），并在广场加一个「村广播」音源（`bus.emit('sfx', ...)` 的广播铃 + 一次性区域 toast）。
- **风险**：NPC 与 `colliders` 冲突（村民不参与碰撞，需设为不可碰撞以免卡住玩家）；性能（12 个 NPC ≈ 3~4 draw call，可接受）。
- **代码量**：约 420 行。

### C11 [P2] 导航 2.0：羽毛标记 + 罗盘 POI 指示 + 快速旅行 + 隐藏区域/稀有羽毛

- **玩家价值**：解决「40 根羽毛找不到」的挫败，把探索从盲找变成有策略的路线规划。
- **实现要点**：
  - `src/main.js:136-146` 的 `minimapData()` 增加 `feathers`（未收集坐标数组，按需 0.5 s 采样）与 `pois` 的 `discovered` 已有；`src/ui/hud.js` 的 `drawMinimap` 增加羽毛圆点（3 色：路旁 / 已进入区域可见 / 未知灰点）。
  - 罗盘：`buildCompass` 的 strip 内按角度插入最多 3 个 POI 三角标记（`src/ui/hud.js:524-561`）。
  - 快速旅行：暂停页/地图点击已发现 POI → 调用已有 `window.__pelican.teleport` 的同源逻辑（在 `src/main.js` 暴露 `travelTo(id)`，仅 `state.discovered[id]` 为真时可用），落地前用 `layout.projectToRoad` 校验避免卡地形。
  - 隐藏区域与稀有羽毛：`src/world/layout.js` 手工加 3 个隐藏点（海蚀拱内部平台 / 灯塔地下室 / 树屋顶），`src/gameplay/collectibles.js` 增加 4 根「稀有羽毛」（第二套 InstancedMesh，材质偏青金、更大、拾取时全屏金色闪 + 专属音效），并纳入纪念册与成就。
- **风险**：导航过强会削弱探索感 → 只标记「已进入区域内的」羽毛；快速旅行限 POI 且不可在计时赛中使用。
- **代码量**：约 300 行。

### C12 [P2] 触屏可玩 + 手柄完善 + 辅助选项（兑现现有文案）

- **玩家价值**：About 页已宣称触屏可用（`src/ui/menus.js:630`）；这是唯一能扩大可玩人群的低成本项。
- **实现要点**：
  - 触屏 UI：`src/core/input.js:87-89` 的 `setTouchAxes` / `touchButton` 已实现但零调用。新增 `src/ui/touch.js`（约 180 行）：左半屏虚拟摇杆（pointerdown/move → `steer`）、右下三键（油门/刹车/冲刺，长按语义），并在 `src/ui/styles.css` 用 `@media (pointer: coarse)` 显示；触屏时禁用 `canvas.requestPointerLock`（`src/core/input.js:100`）。
  - 手柄：补 `A` 跳跃（C9）、`X` 环视、`Y` 地图、`LB/RB` 切换相机；在「关于与操作」页把 `KEY_ROWS`（`src/ui/menus.js:59-77`）改为运行时按设备渲染按键图标文案。
  - 辅助：HUD 缩放（`--pi-hud-scale`）、字幕/双语切换已存在语言开关但只覆盖部分字符串（`src/ui/hud.js:52-110`），补齐 HUD 文案表；修正操作表中「R 重置视角」为「R 回到最近路面」。
- **风险**：触屏摇杆与 `pointer` 事件会和相机拖拽冲突（用 pointerId 归属管理）；移动端性能需把默认画质强制为 low/medium（`detectQuality` 已返回 medium，可再降）。
- **代码量**：约 260 行。

---

## D 段 · 缺陷清单（可复现证据）

> 严重度：**S1** 阻断/核心功能失效；**S2** 明显影响体验；**S3** 打磨问题。
> 每条附「代码证据」与「复现步骤/实测结果」。

### D1 [S1] HUD 的逐帧更新从未执行 → 时速表、时钟、罗盘、小地图全部冻结

- **代码证据**：`src/registry.js:29-53` 的模块清单**不含 hud**，而 `src/main.js:442` 调用的是 `modules.hud?.update?.(dt, state)` → `modules.hud` 恒为 `undefined`（实测 `typeof window.__pelican.modules.hud === "undefined"`）。HUD 对象的 `update()`（`src/ui/hud.js:935-1002`）因此从不被调用，而它负责：指针表 `applyNeedle`、数字车速、时钟 `#pi-clock-value`、昼夜阶段、罗盘 `applyCompass`、小地图 8 Hz 重绘、圈速面板刷新、HUD 与 state 的暂停/拍照状态镜像（`src/ui/hud.js:952-960`）。
- **复现**：开局 → 长按 W 骑行 6 s。实测结果：`state.player.speed = 4.89`（曾达 13 m/s 级别）而 `#pi-speedo-value` 恒为 `0`、指针 `transform="rotate(240.00 110 100)"` 不变、`#pi-clock-value` 恒为 `17:10`（实际 `state.hour = 16.36`）、`#pi-compass-readout` 恒为 `000°`。
- **附加复现（小地图）**：按 M 打开地图 → 记录 `#pi-minimap-canvas.toDataURL().length = 41254` → `teleport(1200, -600)` → 等 2.5 s → 仍为 `41254`，玩家点位置未更新（`drawMinimap` 只在 `setMinimap`/`toggleMinimap` 与 update 中调用）。
- **修复**：见 C1。

### D2 [S1] 「已探索 X / 28」不可能达成（分母包含 3 个不可发现 POI）

- **代码证据**：`src/main.js:136-161` 用 `Object.values(layout.pois)` 过滤森林/沙滩 4 项得到 **28**（含 `spawn`/`gates`/`pool`），而可发现列表 `DISCOVERABLE` 只有 **25** 条（`src/gameplay/events.js:11-38`）。实测：`poiTotalAll = 32`、`hudDiscoveredTotal = 28`、`discoverableCount = 25`、`poisThatCanNeverBeDiscovered = ["forest","pineForest","beach","beachEast","spawn","gates","pool"]`。
- **复现**：开局读 HUD 即「已探索 0 / 28」；把 25 个地标全部走完，计数停在上限 25（`src/ui/hud.js:647-658` 的 `applyDiscoveredText` 使用 `poiTotal`）。
- **附带**：修好 D1 后，圈速面板分母会从当前的 `x/8` 变成 `x/28`（`src/ui/hud.js:995` 在 `state.race.total` 缺失时回退到 `poiTotal`，而 `src/gameplay/events.js:214-218` **从未写 `state.race.total`**）——即 D1 与 D2 必须一起修。

### D3 [S1] 进度不存档：40 根羽毛/25 地标在刷新后归零

- **代码证据**：全项目 `localStorage` 只有两处写入——`src/main.js:305-313`（设置）与 `src/gameplay/events.js:53/80`（`bestLap`）。实测 40 根羽毛全收集后 `Object.keys(localStorage) = ["pelicanIsland.bestLap"]`，`window.__pelican.state.feathers.collected` 在重载后回到 0；`src/gameplay/collectibles.js:140-143` 的 `reset()` 从未被调用（死代码）。
- **复现**：收集任意数量羽毛 → 刷新页面 → 计数归零、`state.discovered` 清空、HUD 回到 0/40。
- **修复**：见 C2。

### D4 [S2] 首次发现地标后，电影黑边（letterbox）永久常驻

- **代码证据**：`src/main.js:369-371` 在 `poi:discovered` 时调用 `hud.setLetterbox?.(true)`，而 `src/ui/hud.js:1032-1036` → `letterboxUser = true`，`applyLetterbox()`（`:563-571`）取 `letterboxUser || letterboxTemp`；唯一把 `letterboxUser` 复位的地方是进入拍照模式（`src/main.js:246`）。
- **复现**：开局骑进村庄触发发现 → 等待 9 s（HUD 自身的 4 s 临时黑边早已结束）→ 实测 `#pi-letterbox.className = "pi-letterbox is-on"`，之后一直保留。

### D5 [S2] 镜头粘在电影模式 + C 键循环索引错位

- **代码证据**：`src/gameplay/camera.js:106-115` 的 `flyby()` 直接 `setMode('cinematic')`，7 s 后只是把 `cine.phase` 置为 `'idle'`（`:239`）→ 继续绕骑手缓慢环绕，**没有任何代码把它切回 chase**；而 `src/main.js:236` 的 `cameraCycleIndex` 只在 `setCamera()` 中更新，所以按键循环与真实模式失步。
- **复现（实测）**：开局不动 → t+10.5 s `state.camera.mode = "cinematic"`（空闲运镜触发）→ t+18.5 s 仍为 `cinematic`；触发港口发现后 9 s 仍为 `cinematic`；按一次 `C` 得到 `firstPerson`（而非回到 `chase`），需要再按两次。

### D6 [S2] 拾取 / 发现 / 摔车音效双重触发（+6 dB 且相位叠加）

- **代码证据**：`src/gameplay/collectibles.js:125` 主动 `bus.emit('sfx', { name: 'pickup' })`，同时 `src/core/audio.js:1533` 自己也监听 `feather:collected` 再放一次；发现同理（`src/gameplay/events.js:149` vs `src/core/audio.js:1534`）；摔车同理（`src/gameplay/controls.js:163` vs `src/core/audio.js:1535-1536`，且后者还额外叠加 splash）。
- **复现**：拾取任意羽毛 → 同一帧内触发两次 `pickupSfx`（可在 `AudioContext` 层用 `sfx` 计数打断点验证）。

### D7 [S2] 计时赛可被绕过：起跑门被倒计时吞掉、倒计时可骑行、无路线约束

- **代码证据**：`src/gameplay/events.js:194-212`——门判定在 `race.active` 内，**不受 `race.countdown` 约束**；`startRace()` 把玩家放到 `layout.pois.spawn`（与 `gates[0]` 同点，`:44-50`）→ 出生即距门 0 为零 → 倒计时期间 `checkpoint` 直接变成 1。`src/gameplay/controls.js` 全程不检查 `state.race`，因此倒计时 3 s 内可以自由骑行而 `race.time` 尚未开始计时。门的判定半径 14 m 且只校验 8 个点，`layout.isClear`/路面约束未参与，直穿岛屿内部即可。
- **复现（实测）**：开始计时赛后 1.5 s（倒计时还剩 1.76 s、玩家未动）→ `state.race.checkpoint = 1`，并已发出 `race:checkpoint {checkpoint:1,total:8,time:0}`；随后按 8 个门坐标依次 `teleport` 再回到起点门 → `race:finish {time:1.933, record:true}` 并写入 `bestLap = 1.9333`（一个 11 km 的圈被 1.9 s 完成）。

### D8 [S2] 拍照模式：滤镜只是文字、焦距读数冻结、无导出

- **代码证据**：`src/main.js:245` 写死 `filterName: '海风胶片'`，`src/fx/post.js` 中不存在任何滤镜分支/LUT；`#pi-photo-focal` 只在 `setPhotoMode` 时由 `focalFromFov`（`src/ui/hud.js:187-192`、`:1059-1077`）写一次，滚轮变焦（`src/gameplay/camera.js:280`）不会更新它；全项目无 `toBlob`/`toDataURL`/`download`/`MediaRecorder`（`rg` 结果为空）。
- **复现**：进入拍照模式 → 滚轮从 18 mm 变到 95 mm → MM 读数与滤镜名保持不变；按任何键都无法保存图片。

### D9 [S2] 死键与文案不一致（含虚假功能声明）

- **代码证据**：`src/core/input.js:19-29` 定义了 `help(H)`、`lookBack(E)`、`hud(V)`、`ui1~ui3(Digit1-3)`，但 `src/main.js:385-419` 的 `handleActions` 只处理 pause/photo/camera/map/reset/bell/race/mute/time/grid → 5 组按键完全无效。`src/ui/menus.js:59-77` 的按键表把 `R` 描述为「重置视角 RESET VIEW」（实际为回到最近路面，`src/gameplay/controls.js:66-80`）；`:630` 声称「手柄与触屏同样可用」。`src/ui/hud.js:78/106` 声称羽毛解锁「纪念册 / almanac」——项目内不存在该功能。
- **复现**：游戏中按 H/E/V/1/2/3 无任何反应；按 R 会瞬移到最近路面（与设置页描述不符）。

### D10 [S2] 村庄内容随种子剧烈波动（1~16 栋房）

- **代码证据**：`src/world/props.js:870` 目标 16 栋，但每栋都要通过 `roadsideSpot()` 的地形过滤（`:874-884`），失败则 `continue`。抽样实测：seed 2024 → **1 栋**（building 13）、777 → **2 栋**、5 → **4 栋**，其余 8 个种子为 16 栋；`emitters` 同步从 24 降到 9/10。
- **复现**：`?seed=2024` 打开岛屿 → 村庄几乎空无一屋，而 HUD/README 仍把它当作 16 栋的地标。

### D11 [S2] 羽毛摆放不做地形与碰撞校验（latent 不可达风险 + 陡坡落点）

- **代码证据**：`src/gameplay/collectibles.js:51-60`（18 根路旁羽毛：纯几何偏移 3.4~8.5 m，无 `layout.isClear`）与 `:62-75`（22 根 POI 羽毛：`randomSpotNear`，**不检查建筑/道具碰撞体**——`layout.isClear` 只查路/河/POI 距离与坡度，不查 collider，`src/world/layout.js:559-580`）。玩家无法靠近碰撞体中心超过 `r+0.44`（`src/gameplay/controls.js:145-160`），而拾取需要水平距离 ≤ 2.29 m（3D 半径 2.5 m、羽毛高出地面 1 m）。
- **实测（16 个种子 × 40 根 = 640 个落点）**：0 例落在建筑内或水中（当前安全），但最小碰撞余量只有 **1.96 m（seed 777）与 2.13 m（seed 31415926）**——距不可达阈值仅 0.16~0.33 m；同时每个种子有 **7~12 根**落在坡度 > 32° 的坡面上，最陡达 76°（seed 20261014 第 7 根、seed 123456 第 11 根），这类落点只能靠冲下坡或按 R 传送回收。
- **修复建议**：生成时用 `ctx.colliders`（构建顺序上 collectibles 在 props/landmarks 之后，`src/main.js:378` 的 ORDER 已保证）做一次「与碰撞体中心距离 > r + 2.6」过滤，并对坡度 > 0.6 的候选点重采样。

### D12 [S2] 深水是隐形墙，且会永久卡住玩家（无提示、无自动救援）

- **代码证据**：`src/gameplay/controls.js:104-124`——`p.inWater = depth > 0.45`，水中阻力 `a -= sgn * 7.0 * clamp01(depth)`，而水中油门上限只有 `ACCEL * 0.5 = 3.7` → 水深 ≥ ~0.53 m 时净加速度为负，玩家**推不动**；没有任何溺水/自动传送逻辑，只能按 R（`src/main.js:399`）。
- **复现**：骑入镜湖或海边深水区 → 速度归零且无法前进/后退回岸（浅水边缘尚可），按 R 才回到路面。

### D13 [S3] 低帧率下的碰撞穿透（无扫掠检测）

- **代码证据**：`src/core/engine.js:116` 把 `dt` 上限设为 0.1 s；`src/gameplay/controls.js:171-190` 直接把 `position += forward * speed * dt` 后做**离散圆-圆重叠**判定。25.6 m/s（`MAX_SPEED_BOOST + 9`，`:133`）× 0.1 s = 2.56 m/帧，远大于树碰撞体半径（`r = trunkRadius * scale * 0.9`，`src/world/vegetation.js:1018`，典型 0.3~0.7 m + 0.44 m 加宽）。
- **复现**：把帧率压到 < 20 fps（低画质 + 后台标签页）后高速冲入树林，会直接穿过树干而不触发摔车。

### D14 [S3] 事件契约未兑现（监听者永远等不到消息）

- **代码证据**：`docs/SPEC.md:365-389` 声明的事件里，`photo:enter` / `photo:exit`（只有 `src/ui/hud.js:1297-1298` 监听）、`sfx:music:intensity`（只有 `src/core/audio.js:1540` 监听）、`time:hour`（无发送方）**从不被发出**；`src/fx/weather.js:130` 的 `setRain()` 发出的 `weather:rain` 也没有任何监听者。后果：音乐强度外部 boost 通道恒为 0（`src/core/audio.js:1309` 的 `intensityBoost` 永远衰减到 0）。

### D15 [S3] 两个里程碑只有标志位、没有任何反馈

- **代码证据**：`src/gameplay/events.js:170-173`（village）与 `:181-184`（bridge）只把 `milestones.*` 置 `true`，既无 toast 也无音效，属于「写了没接线」的半成品（对比 `:169`、`:174-180`、`:185-190` 都有 toast）。

### D16 [S3] 摔车/跌落无代价，危险感与挑战曲线缺失

- **代码证据**：撞上碰撞体只有 `impact > 4.2` 才摔（`src/gameplay/controls.js:161-166`），代价是 0.85 s 失控 + 速度 ×0.32；`airTime` 落地（`:172-189`）**无任何伤害/惩罚**；没有里程、时间、生命、载具状态惩罚，也没有翻车动画状态机。

---

## 附：本次审计的量化底稿

| 指标 | 数值 |
| --- | --- |
| `npm test` | 8/8 模块测试通过（layout/character/vegetation/props/landmarks/life/audio/ui） |
| 地标 | count 20 / meshes 163 / tris 26 194 / colliders 9 / emitters 1 |
| 道具 | props 1564 / buildings 28 / villageHouses 16（1~16 随种子）/ colliders 118 / lamps 108 / wallSegs 292 / guardrails 149 |
| 植被 | trees 1090 / grass 27 591 / flowers 5838 / rocks 613 / bushes 518 / reeds 1890 / treeColliders 107 |
| 生物（high） | total 234（含萤火虫 120）/ 31 draw call / 22 050 tri；low 106 / medium 163 / ultra 295 |
| 粒子 | 池 2026 / 6 族 / 运行时 emitter 24 |
| 运行时全局碰撞体 | 460（seed 20261014, low） |
| 羽毛 | 40 = 18 路旁 + 22 POI；拾取半径 2.5 m；16 种子 × 40 落点中 0 例在建筑/水中，最小碰撞余量 1.96 m |
| 计时赛 | 8 门；出生即消耗第 1 门；实测 1.93 s「完成」一圈（teleport 穿岛） |
| 存档键 | 仅 `pelicanIsland.settings`、`pelicanIsland.bestLap` |
| 界面 | 标题/暂停/设置/关于 4 屏；设置项 4 组（画质/时间/语言/音量+静音）；无重置、无统计、无重映射 |