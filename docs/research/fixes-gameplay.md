# 玩法与体验修复交付

日期：2026-10-16。环境：Windows 11 / PowerShell，three.js r186，默认种子 20261014。

本任务只修改 `src/gameplay/{camera,collectibles,controls,events}.js`、HUD 同一位置的 6 行及测试清单；新增玩法测试、本报告和用户要求的临时浏览器脚本。未修改 main.js、地形、植被、天空、海洋、core、menus、touch、样式或 landmarks。工作区内这些文件的其他改动属于并行任务，全部保留。用户已确认 HUD / styles / camera 的并行修改属于预期；下列行号以收尾时文件为准，后续可能漂移。

**状态：模块修复与验证已交付；C 键接线、完赛 HUD 的固定分母和菜单重置入口仍需 main.js 集成。不能将尚未接线的 C 键循环称为端到端修复完成。**

## 逐条修复

### 1. 探索分母与新存档回归（D2）

- 缺陷：地图筛选得到 28 个 POI，但发现列表只有 25 个；spawn / gates / pool 无发现事件。
- 根因：主程序以小地图 POI 数充当可发现数；实现中曾为 25 个 ID 全部写入 true/false，而 HUD 用 `Object.keys(state.discovered).length` 计数，导致新存档错误显示 25/25。
- 改法：从 `DISCOVERABLE` 中筛出实际存在的 POI，动态生成分母；`state.discovered` 只为真正发现的 ID 写入 `true`，绝不以 false 占位。未开始游戏不触发发现。HUD 从 `state.discoverableTotal` 同步分母。
- 文件：`src/gameplay/events.js:43`、`:166`、`:204`、`:211`；`src/ui/hud.js:1084`。公开只读数值 `modules.events.discoverableTotal`。
- 验证：jsdom 中先故意给 HUD 分母 28，再运行模块，断言发现键数为 0、HUD 为 0/25、分母等于模块实际数量；无头浏览器全新存档输出 `{"keys":0,"hud":"已探索 0 / 25"}`。远离所有 POI、速度设为 25.6 m/s，发现数仍为 0、总数 25。
- 集成边界：首次 HUD 更新前主程序仍会设置一次 28；下文给出小地图筛选的替换代码，可同时去掉不可发现图标和这一瞬间的错误分母。没有靠硬编码 25 修复。

### 2. 发现电影黑边不消失（D4）

- 缺陷：主程序对发现事件调用 `setLetterbox(true)` 后没有永久黑边的关闭路径。
- 根因：HUD 临时黑边和用户黑边是两个开关，临时定时器不能清除后者。
- 改法：events 维护单个 7 秒发现演出计时器；到期走 `endDiscovery()`，调用可用的 `ctx.hud.setLetterbox(false)` 并发出 `discovery:end`；共享状态 `discoveryActive=false` 后，HUD 自己调用 `setLetterbox(false)`，因此现有 main.js 未注入 ctx.hud 时也能收尾。重复发现已记录 ID 不会触发，新发现覆盖同一计时器，不堆叠计时器。
- 文件：`src/gameplay/events.js:67`、`:170`、`:226`；`src/ui/hud.js:1080`。
- 验证：jsdom 等待 HUD 原有临时定时器结束后断言 `is-on=false`；浏览器演出后输出 `LETTERBOX pi-letterbox`，不含 `is-on`。
- 注意：暂停会冻结 events 的游戏时间；拍照入口已有清黑边代码。未引入另一套墙钟定时器。

### 3. 相机粘滞与循环索引（D5）

- 缺陷：flyby 结束后仍停在 cinematic；main.js 的独立 cameraCycleIndex 与实际模式不一致。
- 根因：旧代码只把 flyby 阶段置为 idle；主程序索引不跟随自动运镜和 photo 模式变化。
- 改法：flyby 到期直接回 chase；切换到其他模式清除旧 flyby。新增 `camera.cycleMode()`，从实际 current mode 计算 chase → firstPerson → cinematic → chase，避免维护第二份索引。既有拍照退出路径回 chase。
- 文件：`src/gameplay/camera.js:88`、`:255`、`:321`。
- 验证：单测覆盖三态循环、flyby 到期回 chase、photo → chase 后再次循环到 firstPerson。
- **待接线**：当前 main.js:590 的 C 键仍使用旧索引，必须使用下文替换片段；单测调用的是新方法，不冒充现有 C 键已完成浏览器验收。

### 4. 拾取 / 发现 / 摔车音效双触发（D6）

- 缺陷：同一事件同时发 sfx 和业务事件，而 audio 两者都监听。
- 根因：collectibles 的 pickup sfx + feather:collected、events 的 discovery sfx + poi:discovered、controls 的 crash sfx + rider:crash 形成两路播放。
- 改法：三类事件只发业务事件，由现有 audio 监听者以设计音量播放一次；摔车冷却期间不重复发 crash。比赛开始、烟花和落水仍使用独立 sfx 事件，不与这三类业务事件重复。
- 文件：`src/gameplay/collectibles.js:180`、`src/gameplay/events.js:215`、`src/gameplay/controls.js:194`。
- 验证：stub 同时模拟 audio 的业务订阅和通用 sfx 路由，结果 `pickup=1 discovery=1 crash=1`。同位置重复 update 不再重复拾取或发现。没有对声压作仪器测量；修复证据是播放入口计数从两路降至一路。

### 5. 计时赛（D7，及 D2 的比赛分母）

- 缺陷：倒计时吞起跑门、可提前骑行、8 个离散点能在 1.93 秒瞬移完成；finish 后 active 被后续赋值重新置 true。
- 根因：门检测位于倒计时分支外，controls 不看 race 状态；没有完整路线/可信距离/时间门槛。
- 改法：起点统一为 roadPoint(0)，倒计时锁车，不消耗起跑门。检查点数量按 `max(32, ceil(roadLength / 100))` 动态计算，默认 **110**；先过 1..109，再回 0 闭环。每帧只验证下一个门；瞬移步长大于 `25.6 * dt + 0.5` 不计通过和里程。只有路面附近的可信移动累计到至少环线长度的 85%，且用时达到 `roadLength * 0.85 / 25.6`，才允许最后完赛。time/best/checkpoint/total/active/finished/countdown 统一写回 state.race，finish 不再被覆盖。拒绝旧存档中明显不可能的最佳圈速。
- 文件：`src/gameplay/events.js:74`、`:82`、`:95`、`:115`、`:263`、`:272`、`:278`；`src/gameplay/controls.js:94`。
- 验证：单测“直冲终点 / 瞬移全部门”均未完赛；按真实 roadPoint 连续移动才完成 110/110（单测约 546.80 s）。无头浏览器同样复现攻击：1.93 s、0/110、finished=false；按序连续移动为 **110/110、546.70 s、finished=true、active=false**。
- 倒计时浏览器实测：Enter 后约 1 秒，speed=0、checkpoint=0、countdown=1.9819。Enter 后共 5 秒（包含 3 秒倒计时），speed=**8.616 m/s**、比赛计时 1.9973 s、checkpoint=0/110、finished=false。
- 边界：110 个门为逻辑检查点；未新增门体模型、路线指引或下一门导航。浏览器完整圈验证是逐帧构造符合速度限制的路线上输入，不是 9 分钟人工操作整圈，也不是绕过门/距离检查直接修改 race 字段。
- **待接线**：main.js 完赛监听里仍写死 total:8，替换代码见下文。

### 6. 深水隐形墙 / 救援（D12）

- 缺陷：水中不能加速，阻力将速度压为零后无法离开。
- 根因：只有水阻力，没有失足后的反馈与恢复状态机。
- 改法：非道路位置水深 >0.45 m 时，播放一次 splash、调用现有 ocean.splash、复用最近道路 reset，并提示落水救援；reset 同时清 speed / velocity / airTime / inWater / crash，修正 groundY。道路位置豁免，避免桥面因下方水深误触救援。
- 文件：`src/gameplay/controls.js:71`、`:100`。
- 验证：将玩家置于深海，单测确认一次 player:reset、speed=0、airTime=0，未停留在水中等待油门脱困。比赛中救援走同一个 player:reset 罚时入口。

### 7. 进度持久化与重置（D3）

- 缺陷：40 羽毛、发现地标刷新后归零。
- 根因：仅 settings / bestLap 有存储路径。
- 改法：两模块各自读写，按种子隔离，数据格式固定为：

```js
// pelicanIsland.feathers.<seed>
{ v: 1, data: { indices: [0, 1] } }
// pelicanIsland.discovery.<seed>
{ v: 1, data: { ids: ['village'] } }
```

- 羽毛只接受 0..total-1 的整数索引，重复值不重复计数；地标只接受当前世界实际可发现 ID。未知字段、伪造 count、spawn、__proto__、数字 ID、负索引、越界、小数、字符串索引均不导入。版本不是 1 或格式不合法则视为无有效进度。读取、解析、写入均有 try/catch，存储不可用不阻断游戏。
- 序列化和 localStorage 写入安排在预创建的微任务回调中，合并同帧写入；不在逐帧更新中创建存档数组/JSON。恢复后收集实例隐藏、HUD 由共享 state 更新，不重放拾取/发现业务事件。
- 文件：`src/gameplay/collectibles.js:101`、`:121`、`:127`、`:163`、`:181`；`src/gameplay/events.js:45`、`:56`、`:167`、`:315`。
- 验证：1 羽毛 + village 往返一致；全部 **40/40 羽毛刷新后仍为 40**；损坏 JSON 不抛；未知字段与非法 ID/索引过滤；重置后计数归零。
- 菜单调用函数：**`modules.collectibles.resetProgress()`** 和 **`modules.events.resetProgress()`**。原有 collectibles.reset 保留为兼容别名。这两个方法清当前种子的收集/发现，不清设置或 bestLap；重置入口代码见下文。

## 审计 D 段其余项

| 条目 | 根因与处理 | 文件:行 / 验证 |
| --- | --- | --- |
| D1 HUD 冻结 | 主程序以前未调用 HUD update。本任务开始时主程序已由并行修改补上，未重复编辑。 | 当前 main.js:654；无头截图能显示动态罗盘/时间。 |
| D8 摄影 | 焦距只在进入时设置：在同一 HUD 补丁里按相机 FOV 更新；滤镜、导出涉及 post/main/UI，未实现。 | hud.js:1081；仅源码核对，未单独浏览器验收焦距。 |
| D9 死键 / 虚假文案 | H/E/V/数字键、菜单说明和纪念册文案不适合在 HUD 单处 15 行限制内全部处理；保留给 UI/main 集成。 | 未认领其他并行 UI 改动成果；需 UI 负责人复核现状。 |
| D10 村屋数量 | props 的选址拒绝后 continue，文件不在写入范围。 | 未修。 |
| D11 羽毛可达性 | 原始落点不查建筑圆碰撞/陡坡；构造时检查 waterDepth<=0.1、slope<=0.6、距有效碰撞体中心 >= r+2.6；非法候选重新采样道路附近，最多 4096 次，失败显式报错而非静默放到不可达位置。 | collectibles.js:79；单测默认种子的全部羽毛均满足坡度/水深限制，完整 40 根可收集并恢复；未重跑审计全部 16 个种子。 |
| D13 碰撞穿透 | 原先只检查帧末重叠；补上运动线段到圆心的最近距离检测，扫掠命中时回到碰撞前侧再推出。 | controls.js:179；25 m/s、dt=0.1、小半径障碍单测触发一次 crash，位置未穿过圆心。 |
| D14 未发事件 | 相机切换补 photo:enter / photo:exit；整数小时变化发 time:hour；发现发 sfx:music:intensity。weather:rain 无消费者仍保留，未为无需求事件强加副作用。 | camera.js:92、:101；events.js:180、:216。相机模式有单测，音乐及小时事件仅源码核对。 |
| D15 村 / 桥里程碑 | 只有标志位无提示；补各自一次 toast。 | events.js:242、:253；未另写专门视觉测试。 |
| D16 失败代价 | 比赛摔车 +3 s，回路/救援 +5 s；垂直着陆速度低于 -9 m/s 触发一次 crash，并减速。 | events.js:137、:138；controls.js:216。普通撞击一次事件有单测；罚时和重落地阈值未单独覆盖，需进一步手感测试。未新增生命/损坏/翻车动画系统。 |

## 必须由 main.js 接入的代码

以下是供项目负责人应用的原样代码，本任务没有编辑 main.js。既有每帧 `hud.update(dt, state)` 必须保留。

### A. C 键使用实际模式，移除第二份索引（必须）

将原 CAMERA_CYCLE、cameraCycleIndex 和 setCamera 定义替换为：

```js
function setCamera(mode) {
  modules.camera?.setMode(mode);
}
```

将 handleActions 中整个 camera 按键分支替换为：

```js
if (input.pressed('camera')) {
  modules.camera?.cycleMode();
}
```

保留 enterPhotoMode(false) 的 `setCamera('chase')`。此后自动 flyby、photo 进出和 C 键共用模块里的实际模式，不需要再同步索引。

### B. 完赛 HUD 移除写死的 8（必须）

替换既有 race:finish 监听：

```js
bus.on('race:finish', (p) => {
  hud.setRace?.({
    checkpoint: state.race.total,
    total: state.race.total,
    time: p.time,
    best: p.best,
    finished: true,
    newRecord: p.record,
  });
});
```

### C. 小地图与探索分母采用同一列表（建议一并应用）

在 imports 中加入（如果已有同文件导入，合并具名导入）：

```js
import { DISCOVERABLE } from './gameplay/events.js';
```

将 minimapPoiBase 的整个构造替换为：

```js
const discoverableIds = new Set(DISCOVERABLE.map(([id]) => id));
const minimapPoiBase = Object.values(layout.pois)
  .filter((p) => discoverableIds.has(p.id))
  .map((p) => ({
    id: p.id, name: p.name,
    x: p.position.x, z: p.position.z, type: p.type,
  }));
```

保留 `hud.setDiscoveredTotal?.(minimapPoiBase.length)`，此时它会动态得到 25。不要把分母赋给发现计数，也不要为全部可发现 ID 预填 false。

### D. 菜单重置进度入口（新增入口时调用）

```js
function resetGameplayProgress() {
  modules.events?.stopRace();
  modules.collectibles?.resetProgress();
  modules.events?.resetProgress();
  hud.update?.(0, state);
  hud.toast?.('探索进度已重置', 'Exploration progress reset');
}
```

将此函数交给菜单负责人绑定到重置操作。其本身不会修改 settings/bestLap。无需在 main.js 实现第二套存档读写。ctx.hud 注入不是现有黑边修复的前置条件；若已有注入，events 也会使用。

## 实测证据

新增永久测试：`tools/dev/test-gameplay.mjs`，已加入 test-all。临时浏览器脚本保留于 `tools/dev/_verify-gameplay-live.mjs` 供复核；没有加入 npm test，不依赖额外包。

### 无头 Edge 骑行 / 防秒完成

命令（PowerShell）：

```powershell
npm run build
node tools/dev/shot.mjs --out .scratch/gameplay.png
node tools/dev/_verify-gameplay-live.mjs
```

普通受限运行无法启动 Edge；通过用户已授权的提权执行完成浏览器验证。此前记录的原始输出如下（实际墙钟骑行 10 秒，再 Enter 后骑行 5 秒；后者包含倒计时）：

```text
FRESH {"keys":0,"hud":"已探索 0 / 25"}
FULL_SPEED_NO_POI {"speed":25.6,"discovered":0,"total":25}
RIDE_10S {"speedMps":0.006,"checkpoint":0,"total":110,"countdown":0,"raceSeconds":0,"active":false,"finished":false,"distance":6.92}
COUNTDOWN_1S {"speedMps":0,"checkpoint":0,"total":110,"countdown":1.981899999991061,"raceSeconds":0,"active":true,"finished":false,"distance":6.92}
RACE_RIDE_5S {"speedMps":8.616,"checkpoint":0,"total":110,"countdown":0,"raceSeconds":1.9972999999970198,"active":true,"finished":false,"distance":17.45}
TELEPORT_1_93S {"seconds":1.9299999999999986,"checkpoint":0,"total":110,"finished":false}
ORDERED_LAP {"seconds":546.7000000000505,"checkpoint":110,"total":110,"finished":true,"active":false}
LETTERBOX pi-letterbox
CONSOLE_ERRORS 0
```

截图 `.scratch/gameplay.png` 已人工查看，探索计数为 0/25、羽毛 0/40，游戏画面正常生成。shot 的输出为 `world ready in 7.6s`、`wrote .scratch\gameplay.png`，随后报告 **1 条 warning**（THREE.WebGLProgram / D3D X4122 浮点精度），因此 shot **退出码为 1**。这是已有着色器/驱动警告，非 JS console error；没有为让工具“绿”而过滤 warning 或修改受限范围外着色器。浏览器驱动脚本单独记录 console error / pageerror，两者合计为 0，断言全部通过、退出码 0。

**存疑：10 秒 W 骑行只累计 6.92 米，最终速度 0.006 m/s**。无转向直行可能撞到出生区域障碍或驶离道路；未取得足够碰撞/地形采样证据确认根因，不能把这段标成“骑行体验正常”。Enter 重置到 roadPoint(0) 后实际能加速到 8.616 m/s。此项与尚未进行的人工正常骑行整圈、110 门可见导航、罚时手感一起列为后续实机验收项。

上述浏览器数值来自此前构建的实测记录；收尾额外将完赛通知对象预分配、bestLap 写入移到微任务，并增加了 40 羽毛恢复断言。最终完整测试输出另附于下一节，不将历史浏览器数据伪称为并行所有改动之后的重新截图。

### 契约与更新循环

保留现有工厂、update、spawn/reset、setMode 等入口；新增 resetProgress / cycleMode / discoverableTotal 为兼容性扩展，供上面的集成使用。本任务未越界修改 SPEC；新增入口记录在此。构造期生成地标白名单、碰撞校验和事件载荷；camera 复用 photo 状态、tour 输出向量，photo 移动方向改为标量；controls 缓存 spur ID；拾取、摔车、发现、完赛事件复用载荷。JSON 序列化和存储数组放在预创建微任务回调中。未声称整个现有工程或外部 HUD/音频监听者已经通过堆分配分析；本轮未做浏览器堆分配 profiling。

### 最后一次 npm test（在确认保留并行改动后）

完整实际输出见下，另保存于 `.scratch/gameplay-final-npm-test.txt`。

```text
npm notice run pelican-island@1.0.0 test
npm notice run node tools/dev/test-all.mjs
PASS  engine       1.0s  ALL ENGINE TESTS PASSED
PASS  layout       0.2s  ALL LAYOUT TESTS PASSED
PASS  character    0.2s  ALL CHARACTER TESTS PASSED
PASS  vegetation   4.9s  ALL VEGETATION TESTS PASSED
PASS  props        0.3s  ALL PROPS TESTS PASSED
PASS  landmarks    0.3s  ALL LANDMARKS TESTS PASSED
PASS  life         0.2s  ALL LIFE TESTS PASSED
PASS  audio        0.1s  ALL AUDIO TESTS PASSED
PASS  ui           4.7s  ALL UI TESTS PASSED
PASS  gameplay     5.4s  gameplay PASSED

npm test: all 10 suites passed
```
