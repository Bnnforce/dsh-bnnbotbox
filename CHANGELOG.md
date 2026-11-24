# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [Unreleased]

## [3.2.0] - 2026-11-24

### Added

- **DSH 设置面板里的配置页**（设置 → BnnBot 记忆与人格）。

  之前这个插件在手机上**没有任何界面**：52 项配置只能手改配置文件。
  查清原因后才知道，DSH 的设置条目不是按 Config schema 自动生成的 ——
  每个插件要自己写一个客户端页，注册进 `settings.section` slot
  （QQ 机器人那页是 617 KB 手写客户端 + 约 40 个自定义 API）。

  本次新增：
  - `client/settings.js`：客户端页，注册 `settings.section`（id=bnnbotbox, order=30）
  - `lib/settings-route.js`：宿主端点 `GET/POST /api/bnnbotbox/config`
  - `package.json`：补 `exports["./client"]` 与 `dsh.client`（platform/immediately/inject）

### 设计取舍

- **只暴露 8 项常用配置**（总开关 / 自动建档 / 记忆召回 / 记忆沉淀 / 主动说话 /
  写操作仅主人 / 记忆目录 / QQ 数据根）。其余 44 项是调优旋钮，放出来只会让人不知道填什么。
- **保存走 `configEditor.edit()`**，绝不自己读写 `cordis.patch.yml`
  （那是用户的文件，含别的插件、注释和 `!!js` 表达式）；
  宿主负责校验、串行化、并拒绝被上层覆盖的值。
- **两道鉴权**：口令在 apply 时随机生成、经 `webServer.tapIndex()` 注入 index.html，
  客户端从全局变量取出后放请求头；另加「仅本机回环」检查。缺一即 403。
- **未知字段直接 400**，不静默丢弃 —— 免得用户以为存上了。
- 保存会让插件重启（这些字段不是 `volatile`），页面如实提示，不假装悄悄生效。

### 验证

- `test/r4/r4-settings-route.mjs` 新增 20 条断言：回环/令牌鉴权、字段白名单、
  类型校验、未知字段拒绝、GET 返回当前值、POST 走 configEditor 且保留未改动字段
- 客户端模块结构自检：ModuleLoader 格式、id=包名、react 来自模块表、注册 slot 正确

> 注：3.1.4 把 `Config` 放进 default 导出，让宿主能读到 schema（状态 schema 而非 absent）。
> 但那只解决「配置能被校验」，不解决「配置有界面」—— 界面靠本次新增的客户端页。


## [3.1.4] - 2026-11-24

### Fixed

- **DSH 设置面板里本插件无法配置（状态 absent）**。

  DSH 的 `Loader.unwrapExports()` 是：

  ```js
  exports = exports.default ?? exports;
  ```

  也就是说 **只要模块有 `default` 导出，宿主就只认 `default`**，named 导出完全不看。
  我们的 `default` 原来是 `{ name, inject, apply }` —— 没有 `Config`，于是宿主
  `configOf(plugin)` 拿到 `undefined` ⇒ 该条目状态为 `absent`，**52 个配置项在界面上一个都看不到**，
  而且没有任何报错。

  现在把 `Config` / `resolveConfig` 放进 `default`（named 导出保留，兼容其它调用方式）。
  离线复现宿主的投影逻辑验证过：旧形态 → `absent`；新形态 → `schema`（52 字段）。

### Added

- `test/run-all.mjs` 新增 5 条断言，锁住「default 必须带 Config 且是原生 Schemastery schema」：
  default 存在、default.Config 存在、与 named 同一个、`Symbol.for("schemastery") === true`、
  以及 `isNativeConfigSchema` 的三项条件（symbol / type / meta）。

> 这个坑值得单独记：它**不会报错**，只是让配置在 UI 上凭空消失。


## [3.1.3] - 2026-11-24

### Fixed

- `explicitPersonaForGroup()` 的返回值**没过别名归一化**（P3）。
  状态文件里存的是别名（如「爱莉」）或带 `.md` 的文件名时，
  下游拿到一个「不是任何卡名」的字符串 —— 按名字找卡找不到，且没有任何提示。
  现在用本模块已有的 `catalogFor().aliases`（角色卡 + `persona-aliases.json`）归一：
  精确名 → 别名（大小写不敏感）→ 解析不到返回空串（交给调用方回落默认）。

### 说明

- 与扩展包 1.0.61 的改动配套：两边现在用同一套「解析不到就返回空 / 由调用方回落默认」的语义，
  不再出现「一边静默假装成功、另一边以为没设置」的分歧。

## [3.1.2] - 2026-11-24

### Added

- `assets/default-persona/规则/00-安全规则.md`：内置最小默认人格原本只有角色卡 + 配置，**缺规则文件**。
  而扩展包 `lib/io/persona-store.mjs` 的 `composePrompt()` 要求规则里包含 8 个安全标记
  （`P0 ` / `P0M ` / `P0O ` / `P0C ` / `P0R ` / `P0G ` / `P0T ` / `P1Q `），
  缺了会导致全新安装的「人格切换 → 刷新」直接失败（`规则缺少安全标记 …`）。
  现在随包提供一份**通用最小规则**（883 字，8 个标记齐全，不含任何个人信息），
  由启动自愈一起铺到 `{dirname(qqbotDataRoot)}/人格/规则/`。

- **启动自愈不再往已有配置里塞占位人格**：原实现是「逐个文件缺失就补」，
  导致已经有自己角色卡的用户重启后仍被塞进一张「小忆」，删掉下次还会长回来。
  现改为按「是否已有可用内容」分流：
  · 一张角色卡都没有 → 全量铺（卡 + 配置 + 规则）
  · 已有角色卡 → 只在 `规则/` 完全为空时补一份最小规则，**绝不塞卡**
  · 卡和规则都有 → 什么都不动，返回 `reason: existing-persona`
### 说明

- 内置角色卡「小忆」928 字，满足 `validatePersonaText` 的 ≥300 字要求，验证为有效人格
- 实测全新环境：铺完人格 + 规则后 `composePrompt` 成功（1865 字符 / 人格=小忆）
- 想写自己的规则：往 `人格/规则/` 继续加 `.md`，按文件名顺序合入；但 8 个标记必须保留

## [3.1.0] - 2026-11-21

R5.4 心理状态从 **四维扩展到八维**，并按 v3 方案做了死代码清理。

### Added

- **`lib/persona/r4/mood-official.js`（新）** —— 官方心理数据适配层。
  按铁律「先查官方，别自己造」，八维里的**亲近度 / 耐心 / 自信**不自己算，
  直接读 qqbot 官方数据：
  - `closeness` ← `.qqbot/attitude.json` 的 `a` + `affinity.json` 的 `strength`，
    用官方同一个 `R(F) = 1 + 2F` 归一化（**不硬编码 `a/3`**，不同熟识度范围不同）
  - `patience` ← 官方 `attitude.lastDelta`（负值=态度变差）
  - `confidence` ← 官方 `attitude.level`
  - `focus` ← 派生：`0.5 + (energy−0.5)×0.6 + (0.5−忙度)×0.4`
  - 全部**只读**官方文件，60 秒进程缓存，读不到降级 0.5 不抛

- **八维分三层**：情绪层（mood/energy/connection/composure，自己算）+
  关系层（closeness/patience/confidence，读官方）+ 派生层（focus，不落盘）。

- **注入分层配额**：情绪层最多 2 条、关系层最多 1 条。
  防止关系层偏离持久、永远压过情绪层（否则每轮都说「挺亲近」，单调）。

- **素材分节真值解析**：`mood-life.js` 新增 `parseSectionTruth()`。
  `Bot/事件库/*.md` 的 140 条素材按「## 分节标题」人工分成 8 类，
  **标题就是真值标签**。实测：带标题准确率 **100%**（140/140），
  词表回退 77.9%（旧实现同样场景实测 68.8%~79.6%）。

- **测试 5 个新文件**（维护侧）：`mock-mood-axis`(47)、`mock-mood-life`(24)、
  `mock-mood-official`(25)、`mock-mood-store`(13)、`mock-mood-integration`(13)。

- `lib/persona/r4/mood-axis.js` 新增 `applyRelation()` / `refreshDerived()`；
  `mood-store.js` 新增 `isFullV8()`。

### Changed

- **状态文件切换为八维，不做兼容迁移**（用户要求「不要临时方案」）。
  读到不是完整八维的文件 → 视为空状态重新累积。
  代价：上线后前 3 轮不注入（`MIN_SAMPLES=3`），一次性成本。
  旧文件已备份为 `state/archive/mood-axes.v4.bak.json`。

- **诊断字段扩到八维**（`feature-diag.jsonl` 的 `detail`），
  面板与工具无需改动（只加字段不改结构）。

- 注入文本 3 条 28 字 / 8 条 51 字，稳定在 90 字预算内。

### Removed

- **`lib/persona/r4/mood-tint.js` 删除**（死代码）。
  实测：4 个导出里 `tintOf` / `moodTintText` / `readMoodTint` **全文 0 使用**；
  唯一还在调的 `advanceMoodTint` 挂在心跳 wake 通道，而
  `heartbeat_config.generation_mode` 默认 `'legacy'` ⇒ 那条路实际不跑。
  wake 通道改为内联调用八维 `advanceMood` 逻辑。

- **`mood-store.js` 的两条迁移分支删除**：`LEGACY_FILE` / `migrateLegacy()` /
  `mood-tint.json` 读取。不再永久背着兼容分支。

- **`src/r4/mood-tint.ts` 删除**（对应 lib 侧清理）。
  同时在 `src/r4/index.ts` 顶部加说明：`src/` 不是运行时真相、已与 `lib/` 分叉、
  本插件无 tsconfig 无 build 脚本 ⇒ **不要去同步两者**。

- 测试 `run-mood-tint.mjs` 归档（测的模块已删）；
  `run-inject-integration.mjs` 改用固定文本模拟 `getMoodTint` 返回
  （该测试只验证注入链路，不验证算法）。

### Fixed

- **`focus` 派生公式 bug**（测试抓到的真 bug）：原公式
  `energy×0.6 + (1−忙度)×0.4` 在中性状态（energy=0.5、不忙）算出 **0.7**
  ⇒ 虚假偏离 0.2，导致「全中性也要注入一句『挺专注』」。
  根因：`(1−忙度)` 衡量的是「不忙」不是「专注」。改为围绕中性值的加权偏移。
  同时修：无忙碌数据时按「未知=中性 0.5」，不再假设她不忙。

- **问句信号被短句负信号抵消**：`「你好吗？」` 同时命中「短句 −0.25」和
  「问句 +0.1」⇒ 净 −0.15，问句明明是积极信号。问句加成改为最低 0.25。

### Docs

- 新增 `Bot/维护/01-开发规范/心理状态架构说明.md`
  （八维定义、数据流、官方契约、注入链路、扩展方式、已知限制）。
- 方案文档：`R5.4-八维心理状态-工业化全方案-v3.md`。

### 验收

```
插件测试        45/45 文件通过
维护全检        8/8 项
mock 测试       74/74
素材准确率      100%（140 条真值）
注入预算        ≤90 字（极端状态 29 字）
死代码          0（全库无 mood-tint 引用）
零硬编码        0 处
```

---

## [3.0.0] - 2026-11-20

首个合并版本：`dsh-anti-ai-persona` v2.6.0 + `dsh-qq-memory` v0.1.4 → `dsh-bnnbotbox`。

### Added

- **合并为单包**：人格 + 记忆一体化，部署从 2 个包变 1 个
- **`lib/shared/atomic.js`**：统一原子写（取两套长处：唯一 tmp 名 + fsync）
- **`lib/shared/paths.js`**：统一路径推导（多级兜底，零硬编码）
- **`lib/config.js`**：合并配置（persona 为主，memory 补缺）
- `eventsDir` 配置项：允许显式指定生活素材目录

### Changed

- **消除 `inject: ['persona']`**：memory 不再依赖 persona 服务的启动时序
  - 合并前 memory 的 fiber 因等 persona 而长期 PENDING
  - 现在改为同一进程内直接传实例
- **`inject` 收敛**：`['systemPrompt', 'llm']` + `['persona','tools','llm']` → `['systemPrompt','llm','tools']`
- **数据根解析统一**到 `shared/paths.js`
  - 原两套各自实现，现在一套
- **`dataRoot` 默认改为** `{DSH_HOME}/data/bnn-botbox`
  - 兼容：旧目录 `dsh-anti-ai-persona` 存在时自动沿用（老数据不丢）

### Fixed

- **3 处硬编码作者路径**（开源红线）
  - `persona/paths-runtime.js` 的 `push('{WORKSPACE_ROOT}/Bot/dshqqbot')`
  - `memory/index.js` 的同上
  - `persona/r4/config.js` 的 `events_dir` 默认值
  - 全部改为环境变量兜底 + 运行时推导
- **`events_dir` 不再写死**：由主入口从 `qqbotDataRoot` 反推 `{WORKSPACE}/Bot/事件库`

### Removed

- 两套重复的原子写实现（合并为 shared）
- 两套重复的路径推导实现（合并为 shared）


### Added (重构补充 2026-11-20)

- **`shared/atomic.js` 完整能力**：Buffer 写、mutateJsonAtomic、readJsonSafe/readTextSafe
  - 统一了原本 3 套实现（persona/memory/死代码）
  - 保留所有历史签名（writeJsonAtomic 返回 bool、atomicWriteText 返回 {ok}）
- **`shared/paths.js` 分层解析**：`resolveQqbotRootTiered` / `hasQqbotDir` / `expandHomeSafe`
- r4-bridge 测试（20 个断言，此前 23KB 代码零覆盖）

### Changed (重构补充)

- persona 的 `paths-runtime.js` 改为适配层（96 行 → 84 行），发现逻辑委托 shared
- 16 处 atomic import 改指 `shared/atomic.js`

### Removed (重构补充)

- `lib/persona/r4/atomic.js`（143 行，已并入 shared）
- `lib/memory/store/atomic.js`（48 行，已并入 shared）


### Migration

- 数据：无需迁移（自动沿用旧目录）
- 配置：两条 `- id:` 合并为一条 `- id: bnnbotbox`
- 回滚：保留旧插件目录，配置改回即可

---

## 前身版本

合并前的两个插件各自的历史：

### dsh-anti-ai-persona 2.6.0

- 四维心理状态（R5.4）：mood/energy/connection/composure
- 生活联动：时段基线 + 素材层 + 外部状态层
- 双路信号：情绪词 + 对话特征（长度/问句/省略号/间隔）
- 心跳主动开口、关系等级、新人识别、小脾气
- 画像抽取与注入（16 源 + 1000 字熔断）

### dsh-qq-memory 0.1.4

- 按群物理隔离的长期记忆
- 人物卡 / 事件卡自动建档
- `qq_memory` 单工具多 action
