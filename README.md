# dsh-bnnbotbox

QQ 机器人的人格与记忆一体化插件，为 [DeepSeek Harness](https://github.com/deepseek-ai) 设计。

> 由 `dsh-anti-ai-persona`（v2.6.0）与 `dsh-qq-memory`（v0.1.4）合并而来。

> 🔒 **这个插件会处理个人数据**（群友昵称、openid、生日、人物画像、聊天内容）。
> **装之前请先读 [`PRIVACY.md`](PRIVACY.md)** —— 存哪、谁能看、会不会上传、怎么关、怎么删，都写在那里。
>
> 🚀 **机器上什么都没有也能跑**：人格卡、配置、数据目录全缺时，插件照常启动并降级
> （缺什么打 warn，后台心跳自动关闭）。验证方法：`node test/install/fresh-env.mjs`

---

## 功能

### 人格（persona）

| 能力 | 说明 |
|---|---|
| **四维心理状态** | 心情 / 精力 / 联系感 / 从容度，随对话缓慢漂移 |
| **生活联动** | 时段基线（早/午/晚/深夜）+ 生活素材 + 外部状态（心跳/独处）|
| **心跳主动开口** | 静默一段时间后自己找话聊 |
| **关系与新知** | 关系等级、新人识别、小脾气状态机 |
| **画像抽取** | 从对话中沉淀用户偏好，写入画像文件 |
| **Prompt 注入** | 16 个注入源 + 1000 字熔断预算 |

### 记忆（memory）

| 能力 | 说明 |
|---|---|
| **群记忆隔离** | 按群物理隔离，物理目录不互串 |
| **人物卡 / 事件卡** | 自动建档 + 手动沉淀 |
| **单一工具入口** | `qq_memory` 多 action（search/read/list/remember/update/forget）|
| **跨群通用** | 全局卡 + 群内卡两级 |

---

## 安装

### 前置要求

| 项 | 版本 |
|---|---|
| DSH | >= 0.2.2 |
| Node.js | >= 20 |

### 1. 放入插件目录

```bash
{DSH_HOME}/plugins/dsh-bnnbotbox/
├── lib/
│   ├── index.js          主入口
│   ├── config.js         合并配置（persona + memory 单一 schema）
│   ├── persona/          人格模块
│   ├── memory/           记忆模块
│   └── shared/           公共层（atomic / paths / bootstrap-persona）
├── assets/
│   └── default-persona/  ★ 内置的最小默认人格（小忆）
│       ├── 角色卡/小忆.md
│       └── persona-config.json
├── node_modules/         依赖（pnpm 安装）
├── cordis.patch.yml      加载声明
└── package.json
```

> ⭐ **本仓库自带一个人格**：`assets/default-persona/` 里的「小忆」。
>
> 它是一个**最小可用的人格**（一个名字 + 基本说话方式 + 硬规则），
> 目的是让全新安装**开箱就有身份**，而不是空着。
>
> **首次启动时**会自动复制到 `{workspace}/Bot/人格/`（**只在缺失时复制，绝不覆盖已有文件**）。
> 想换成自己的角色：把卡放进 `人格/角色卡/<名字>.md`，
> 再把 `人格/persona-config.json` 的 `defaultPersona` 改成那个名字即可。
>
> ⚠️ 它只是占位符，**不是**某个二次元角色。有版权顾虑就自己写一份。

### 2. 挂到 profile

```bash
dsh plugin add /path/to/dsh-bnnbotbox
```

或在 `{PROFILE}/package.json` 的 `dependencies` 里加：

```json
"dsh-bnnbotbox": "link:/path/to/dsh-bnnbotbox"
```

---

## 配置

有两种方式，**优先用设置面板**：

### 设置面板（推荐）

DSH → 设置 → **BnnBot 记忆与人格**。页面只放 8 项常用配置：

| 项 | 作用 |
|---|---|
| 总开关 | 关掉后记忆与人格功能整体停用（QQ 通道仍工作） |
| 自动建档 | 按群消息为缺失的群卡/人物卡建骨架，只写可观测事实 |
| 记忆召回 | 对话前自动捞相关记忆注入上下文 |
| 记忆沉淀 | 定时从群聊提炼事实写进人物卡 History |
| 主动说话 | 按时间窗自己开口（受 QQ 主动消息限制） |
| 写操作仅主人 | 开启后群友只能搜/读/列记忆 |
| 记忆目录 | 相对 qqbotDataRoot 的子目录 |
| QQ 数据根 | 指向 <工作区>/Bot/dshqqbot |

> 保存会让插件重启一次（这些字段不是 volatile），页面会提示。

为什么不把 52 项全放出来：其中大半是调优旋钮（召回预算、沉淀条数、心跳窗口…），
放出来只会让人不知道该怎么填。**默认值就是给日常用的**。

### 直接改配置（高级）

其余字段改 `cordis.patch.yml` 里 `id: bnnbotbox` 那一行的 `config`：

```yaml
- id: bnnbotbox
  config:
    enabled: true
    qqbotDataRoot: "/sdcard/DSH/Bot/dshqqbot"
    memorySubdir: .qqbot-extensions/data/group-memory
```

改完整份配置文件要重启 DSH 才生效。常用冷门项的说明见 `lib/memory/config.js` 的注释。


全部字段可留空，运行时自动解析。

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | 总开关 | `true` |
| `qqbotDataRoot` | qqbot 数据根 | 自动探测 |
| `dataRoot` | 插件数据根 | `{DSH_HOME}/data/bnn-botbox` |
| `eventsDir` | 生活素材目录 | `{WORKSPACE}/Bot/事件库` |
| `moodTemplate` 等 | 见 `lib/persona/r4/config.js` | 内置默认 |

### 环境变量

| 变量 | 作用 |
|---|---|
| `QQBOT_DATA_ROOT` | 覆盖 qqbot 数据根（测试隔离用）|
| `PERSONA_DATA_ROOT` | 覆盖插件数据根 |
| `BOT_DATA_ROOT` | 兜底数据根（无配置时）|
| `PERSONA_EVENTS_DIR` | 覆盖生活素材目录 |

### 数据根解析顺序

```
qqbotDataRoot:
  ① 配置 explicit
  ② QQBOT_DATA_ROOT
  ③ DSH_HOME/qqbot
  ④ 从 cwd 向上探测（含 .qqbot/msg-history 即命中）
  ⑤ ~/.dsh-qqbot

dataRoot:
  ① 配置 explicit
  ② PERSONA_DATA_ROOT
  ③ DSH_HOME/data/bnn-botbox
  ④ 兼容：DSH_HOME/data/dsh-anti-ai-persona（旧目录存在则沿用）
```

---

## 数据目录

```
{dataRoot}/                      默认 {DSH_HOME}/data/bnn-botbox
├── state/
│   ├── mood-axes.json           四维心理状态
│   ├── daily-mood.json          今日生活素材
│   ├── life-stream.json         碎片生活流
│   └── heartbeat/<gid>.json     心跳状态
├── elysia/
│   └── profiles/*.md            用户画像
└── persona-configs/
    └── elysia.json              人格配置

{qqbotDataRoot}/.qqbot-extensions/data/group-memory/
└── groups/<gid>/
    ├── entities/people/*.md     人物卡
    └── events/*.md              事件卡
```

**所有数据都在本地，不上传任何服务器。**

---

## 从旧版迁移

### 数据：自动沿用

若 `{DSH_HOME}/data/dsh-anti-ai-persona` 存在，会自动沿用它作为 `dataRoot`，
**无需手动迁移数据**。

### 配置：改一处

原 `cordis.patch.yml` 里的两条：

```yaml
- id: anti-ai-persona
- id: qq-memory
```

改为一条：

```yaml
- id: bnnbotbox
  name: 'dsh-bnnbotbox'
  config:
    enabled: true
```

### 回滚

保留旧插件目录，配置改回去即可。两套互不干扰。

---

## 架构

```
lib/index.js
├── 解析数据根（shared/paths）
├── 推导事件库目录
├── ① apply persona  → 提供 PersonaService
└── ② apply memory   → 直接用 PersonaService 实例
```

**关键设计**：两个模块各自独立 `apply`，互不阻塞。
- persona 失败 → memory 降级运行（scope 解析返回空）
- memory 失败 → persona 不受影响

相比合并前的 `inject: ['persona']`，消除了启动时序依赖。

---

## 源码结构（重要：TS 迁移进行中）

本包由两个插件合并而来，**TypeScript 迁移只完成了人格侧**。请按下面的方式理解仓库：

| 目录 | 内容 | 状态 |
|---|---|---|
| `src/` | TypeScript 源码（74 个 `.ts`） | ✅ 人格模块已迁移 |
| `lib/` | **实际运行的代码**（94 个 `.js`） | ⚠️ 混合 |
| `assets/` | 内置的最小默认人格 | ✅ |
| `test/` | 测试（`.mjs`，直接跑，无构建） | ✅ |

`lib/` 里有两类文件，**必须区分**：

1. **有 TS 源的**（77 个）— 由 `src/*.ts` 编译而来，改动应改 `src/` 再编译
2. **没有 TS 源的**（17 个）— **这些 `.js` 就是源码，不是构建产物**

没有源码的 17 个文件：

```
lib/memory/                    11 个（整个记忆模块）
  auto-card.js  bridge.js  card-audit.js  distill.js  distiller.js
  scope.js  service.js  tasks.js  store/guard.js  store/index.js
  tools/qq-memory.js
lib/persona/r4/                 4 个（情绪轴）
  mood-axis.js  mood-life.js  mood-official.js  mood-store.js
lib/shared/                     2 个（公共工具）
  atomic.js  paths.js
```

> **为什么**：合并前 `dsh-qq-memory v0.1.4` 是纯 JS；合并时只把 persona 侧转成了 TS，
> 记忆侧的 `.ts` 源码没有一并带过来（原仓库已不可考）。
> 它的 `.js` 带完整中文注释、可直接阅读与修改，只是不是 TS。
> 后续可以逐步迁移，但不影响现在使用。

> 本目录的 `README.md` 已标注：`lib/memory/` 是**个人数据区**，改动前先读 [`PRIVACY.md`](PRIVACY.md)。

---

## 开发

### 检查

```bash
# 语法（应 0 错误）
for f in $(find lib -name '*.js'); do node --check "$f"; done

# 零硬编码（应只剩注释）
grep -rnE "'(/Users/|/home/|/storage/|/data/)" lib/ | grep -v 'process\.env'
```

### 测试

```bash
node test/run-all.mjs
```

---

## 已知限制

| # | 限制 | 说明 |
|---|---|---|
| 1 | 素材需自备 | `Bot/事件库/`、曲库、语音样本不在仓库中 |
| 2 | 依赖 cordis | 需要 DSH 宿主提供 |
| 3 | 仅 Android 验证 | 路径推导跨平台，但未在其他平台测试 |

---

## 许可

[MIT](LICENSE)

角色相关素材（《崩坏3》及爱莉希雅）版权归 miHoYo 所有，本仓库不含任何素材。
