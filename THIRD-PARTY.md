# 第三方组件声明

本仓库（`dsh-bnnbotbox`，人格 + 记忆插件）自身以 **MIT** 发布（见 [`LICENSE`](LICENSE)）。

**本仓库不 vendor 任何第三方代码** —— 仓库内没有 `node_modules/`、没有 `vendor/` 目录，
所有依赖都由 `package.json` 声明、由使用方在 DSH profile 里安装。
因此这份声明的全部内容就是一张依赖清单。

> 另有一份更长的说明 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)（含宿主能力与角色素材版权说明）。
> 两者冲突时，**以本文件（`THIRD-PARTY.md`）的依赖表为准**，它直接对齐 `package.json`。

---

## 一、直接依赖

版本以 [`package.json`](package.json) 为准。

| 组件 | 声明 | 实际安装版本 | 许可证 | 用途 | 分发方式 |
|---|---|---|---|---|---|
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) | `~3.19.0`（dependencies） | 3.19.0 | **MIT** | 配置 schema 校验（`z.object` / `z.volatile()`） | 由使用方安装，不随本仓库分发 |
| [`@deepseek-ai/dsh-tools`](https://www.npmjs.com/package/@deepseek-ai/dsh-tools) | `>=0.1.1-rc.2`（dependencies + optional peer） | 0.2.2-rc.3 | **MIT** | 工具注册辅助（`defineTool` 等） | 通常由 DSH 宿主提供；本包不打包 |
| [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis) | `~4.1.0`（**peerDependency**） | 4.1.0 | **MIT** | 插件运行时（Service / Context / 生命周期） | 由 DSH 宿主提供，本包既不打包也不修改 |

三者的上游仓库都是 <https://github.com/deepseek-ai/deepseek-harness>
（`vendor/schemastery`、`packages/core/tools`、`vendor/cordis`），许可证文本均为 MIT。
`schemastery` 与 `cordis` 的版权行为 `Copyright (c) 2021-present Shigma`，
`dsh-tools` 为 `Copyright (c) 2026 DeepSeek`。

## 二、客户端注入的宿主包（不属本仓库）

`package.json` 的 `dsh.client.inject` 声明了下面两个包，用于把设置面板挂进 Web 前端。
它们是 **DSH 宿主自带的包**，本仓库只引用其已注册的 slot，不分发也不修改：

| 组件 | 实际版本 | 许可证 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-settings` | 0.2.2-rc.3 | MIT | 设置面板容器 |
| `@deepseek-ai/dsh-client-ui-slots` | 0.2.2-rc.3 | MIT | slot 注册 |

## 三、Node 内置模块

本仓库运行时只用到 Node 标准库（`node:fs`、`node:path`、`node:crypto`、`node:sqlite` 等），
随 Node.js 一起分发，适用 Node.js 自身的 MIT 许可证，无需单独声明。

## 四、宿主能力（不是依赖）

插件通过宿主能力与外部交互，**不直接依赖也不分发**其实现：

| 能力 | 说明 |
|---|---|
| `ctx.llm` | 模型调用。具体服务商由使用方在 DSH 设置里配置 |
| `ctx.systemPrompt` | prompt 注入通道 |
| `ctx.tools` | 工具注册 |

这些能力背后可能是第三方服务（各家大模型 API 等），其许可与隐私条款由各自服务商提供。
数据流向见 [`PRIVACY.md`](PRIVACY.md)。

## 五、素材与角色版权

本仓库**不含任何第三方角色素材**（图片、语音、音乐、模型权重均无）。

`assets/default-persona/` 里附带一份最小默认人格卡「小忆」，是本仓库原创的通用占位文本，
不基于任何第三方作品的角色；可随意改名、改写或删除。

使用者自行放入 `人格/角色卡/` 的角色卡，其版权与合规责任由使用者承担
（例如基于《崩坏3》《原神》等作品的角色属于二创，需遵守原作方的二创规定）。

## 六、AI 生成内容声明

机器人输出的每句话都是模型生成内容，不构成事实性主张或专业建议。

---

## 更新记录

- 2026-11-26：首次建立。按 `package.json` 对齐三个直接依赖
  （schemastery / dsh-tools / cordis），并补客户端注入包与 Node 内置模块说明。

*升级依赖后请同步更新本文件第一节的版本号。*
