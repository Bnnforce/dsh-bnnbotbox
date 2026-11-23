# 隐私与个人数据说明

> **一句话**：本插件处理的都是**你自己机器上、你自己群里**的数据。
> 默认全部落盘在本机，不出本机；唯一的对外传输是**调用你自己配置的大模型**。
>
> 本文说明：处理了哪些个人数据、存在哪、谁能看到、怎么关、怎么删。
> 代码分区见 §7。

---

## 1. 处理哪些个人数据

| 数据 | 来源 | 存在哪 | 能不能关 |
|---|---|---|---|
| **群聊消息**（用于判官/复盘/生活流） | QQ 消息 | 内存 + `msg-history`（宿主维护，只读） | 关 `autoJudgeEnabled` / `reviewEnabled` / `lifeStreamEnabled` |
| **群友昵称** | 消息里的 sender 字段 | 记忆库 markdown | 关 `memorySubdir` 相关功能 |
| **openid**（QQ 用户唯一标识） | 消息里的 sender 字段 | 记忆库 markdown | 同上 |
| **生日** | 群友自述 / 主人录入 | `记忆库/.../events/birthdays/` | 不启用生日相关功能 |
| **人物画像**（说话风格、关系、偏好） | 模型抽取 | `记忆库/.../entities/people/` | 关 `distillEnabled` / `autoCardEnabled` |
| **群档案**（这个群是干什么的、谁是谁） | 模型抽取 | `记忆库/.../entities/groups/` | 关 `autoCardGroupEnabled` |
| **情绪/生活状态** | 模型判定 | `persona` 数据目录 | 关 R4 相关配置 |
| **复盘错题本** | 模型自评 | `persona` 数据目录 | 关 `reviewEnabled` |

**不处理**：手机号、身份证、位置、通讯录、相册、麦克风、剪贴板。

---

## 2. 数据存在哪（全部本机）

```
{qqbotDataRoot}/.qqbot/msg-history/            ← 宿主维护的群消息历史（本插件只读）
{qqbotDataRoot}/.qqbot-extensions/data/
  └── group-memory/                            ← ★ 记忆库（个人数据集中地）
      ├── groups/<gid>/                        ← 按群隔离
      ├── private/<openid>/                    ← 单聊隔离
      └── global/                              ← 全局（群友只读、主人可写）

{PERSONA_DATA_ROOT}/                            ← 人格/情绪/复盘数据
  ├── persona-configs/                          ← 人格配置
  ├── profiles/                                 ← 用户画像
  └── review-buffer*.jsonl                      ← 复盘记录
```

两个根目录都可用环境变量或配置项重定向（见 README「配置」）。

**没有云端数据库，没有远程同步，没有遥测。**

---

## 3. 谁会看到

| 场景 | 默认行为 | 相关配置 |
|---|---|---|
| 群友问「我是谁」 | 只能读**自己**的档案 | 硬编码，不可放宽 |
| 群友读群档案 | 可以（群公共信息） | `globalPublicFiles` 限定白名单 |
| 群友**写**记忆 | 默认**不行** | `ownerWriteOnly: true` |
| 主人（owner）写记忆 | 可以 | `ownersFallback` 决定 owner 从哪来 |
| 跨群读取 | **禁止** | session-groups 只有 persona 能读，防止串群 |

> 红线：`scope` 解析必须走 persona 服务。绕过它直接读 `session-groups.json` = 可以串群读别人数据。

---

## 4. 会不会上传

**不会主动上传。** 但有两条必须说清楚的对外传输：

| 传输 | 内容 | 目的地 | 能关吗 |
|---|---|---|---|
| **模型调用** | 对话内容 + 相关记忆片段（作为 prompt） | **你自己配置的模型服务商** | 关掉对应功能，或换本地模型 |
| 无 | — | — | — |

> ⚠️ 这是**实时隐私边界**：群友说的话会进入发给模型服务商的 prompt。
> 如果你用的是第三方云模型，**群友的聊天内容会离开这台机器**。
> 部署前请让群友知情。想彻底避免 → 用本地模型，或关掉相关功能。

代码里**没有任何** `fetch` / `http` / WebSocket 直连（已核查）。所有对外通信都经宿主 `ctx.llm`。

---

## 5. 保留期与容量上限

| 上限 | 默认值 | 配置项 |
|---|---|---|
| 单文件读取字节 | 有上限（防超大文件拖死） | `readMaxBytes` |
| 单条记忆写入字节 | 有上限 | `writeMaxBytesPerEntry` |
| 单 scope 记忆条数 | 有上限 | `writeMaxEntriesPerScope` |
| 搜索返回条数 | 30 | `searchMaxHits` |
| 历史消息回溯 | 7 天 | `maxHistoryDays` |
| 记忆召回预算 | 280 字符 | `memoryRecallBudgetChars` |

**没有自动过期删除**——数据留着直到你手动删。

---

## 6. 怎么关、怎么删

### 全关
```yaml
enabled: false            # 整个插件停用
```

### 只关个人数据相关
```yaml
autoJudgeEnabled: false       # 不判官
reviewEnabled: false          # 不复盘
lifeStreamEnabled: false      # 不主动开口
distillEnabled: false         # 不抽取人物画像
autoCardEnabled: false        # 不生成人物卡
memoryRecallEnabled: false    # 不注入记忆
memoryCallbackEnabled: false  # 不主动惦记
```

### 删数据
```bash
# 全删记忆库（不可恢复，先备份！）
rm -rf "{qqbotDataRoot}/.qqbot-extensions/data/group-memory"

# 只删某个群
rm -rf "{qqbotDataRoot}/.qqbot-extensions/data/group-memory/groups/<gid>"

# 只删某个人
rm -rf "{qqbotDataRoot}/.qqbot-extensions/data/group-memory/groups/<gid>/entities/people/<名字>.md"
```

---

## 7. 代码分区：哪些代码碰个人数据

本仓库**不拆分插件**，但代码有明确的个人数据区。改动这些文件前请先读本文。

| 目录 | 个人数据相关度 | 说明 |
|---|---|---|
| `lib/memory/` | 🔴 **高** | 记忆库本体：读写按人/按群的 markdown、`qq_memory` 工具、画像抽取、人物卡审计 |
| `lib/memory/store/` | 🔴 **高** | 唯一 IO 入口 + 路径防穿透 |
| `lib/memory/tools/qq-memory.js` | 🔴 **高** | AI 读写个人记忆的入口（权限边界在这里） |
| `lib/persona/r4/` | 🟠 中 | 情绪/生活状态、关系等级（人物画像的另一半） |
| `lib/persona/memory-recall*` | 🟠 中 | 记忆召回（把个人档案塞进 prompt） |
| `lib/persona/review-*` | 🟠 中 | 复盘错题本（含聊天原文） |
| `lib/shared/` | 🟢 低 | 原子写、路径推导，不碰业务数据 |

**改这些地方的硬性要求**：

1. 所有 `readFileSync` 必须 `try-catch`（坏文件不能阻塞主聊天）
2. 所有写盘走 `atomicWriteText`（临时文件 + rename）
3. 所有路径走 `checkRelativePath`（防目录穿透）
4. 搜索/读取一律有上限（防爆 context、防超大文件）
5. 日志**不许**打完整 openid / 昵称原文（打码或只打计数）

---

## 8. 部署者须知

装之前请确认：

- [ ] 群友知道这个机器人在**记录群聊内容**用于生成人物画像
- [ ] 群友知道聊天内容会**发给模型服务商**（除非你用本地模型）
- [ ] 你清楚数据存在哪，并且有备份策略
- [ ] 未成年人所在群，遵守当地关于未成年人信息的规定

> 本插件是**自托管**工具：数据在你手里，责任也在你手里。
