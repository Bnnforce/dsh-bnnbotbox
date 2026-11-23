# `lib/memory/` —— 个人数据区

> ⚠️ **这个目录里的代码直接读写「具体某个人」的数据。**
> 改动前请先读仓库根目录的 [`PRIVACY.md`](../../PRIVACY.md)。

---

## 这里是什么

群记忆库：按「群 / 单聊」隔离的 markdown 记忆库，存群友的**昵称、openid、生日、性格画像、关系、群档案**。

```
store/             ← 唯一 IO 入口（所有读写必须经它）
  guard.js         ← 路径防穿透（相对路径校验）
  index.js         ← 记忆的增删改查 + 搜索打分
tools/qq-memory.js ← AI 可调工具 `qq_memory`（权限边界在这）
distiller.js       ← 从聊天里抽取人物画像（会调用模型）
distill.js         ← 抽取的纯逻辑
auto-card.js       ← 自动生成人物卡 / 群卡
card-audit.js      ← 卡内容质量审计
scope.js           ← scope 解析（哪个群 → 哪份记忆）
service.js         ← 对外服务
bridge.js          ← 与 persona 侧的桥
tasks.js           ← 维护任务（清理/压缩）
config.js          ← 配置 schema
index.js           ← 入口
```

## 硬性纪律（违反会出事）

| # | 纪律 | 为什么 |
|---|---|---|
| 1 | 所有 `readFileSync` 包 `try-catch` | 一个坏文件不能让整个群聊卡死 |
| 2 | 所有写盘走 `atomicWriteText` | 断电/中断会写坏文件，原子写才能保命 |
| 3 | 所有路径过 `checkRelativePath` | 防 `../../` 穿透读到别的群 |
| 4 | 搜索/读取必须有上限 | 防爆 context、防超大文件拖死 |
| 5 | 日志不打完整 openid / 昵称 | 日志会被贴到群里排障，等于泄露 |
| 6 | scope 解析必须走 persona 服务 | 直接读 `session-groups.json` 会串群 |

## 数据分区

```
{qqbotDataRoot}/.qqbot-extensions/data/group-memory/
├── groups/<gid>/          ← 按群隔离（群 A 读不到群 B）
├── private/<openid>/      ← 单聊隔离
└── global/                ← 全局（群友只读，主人可写）
```

## 源码状态

> 📌 本目录的 TypeScript 源码**尚未迁入** `src/`（合并自 `dsh-qq-memory v0.1.4`，迁移未完成）。
> 当前这里的 `.js` 就是运行代码，不是构建产物。
> 详见仓库根目录 README 的「源码结构」一节。
