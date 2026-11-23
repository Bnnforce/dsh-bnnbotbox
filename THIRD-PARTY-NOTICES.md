# 第三方组件许可声明

> 本仓库代码以 [MIT](LICENSE) 发布。
>
> 与「扩展包」仓库不同，**本仓库不内置（vendor）任何第三方代码** ——
> 依赖全部通过 `package.json` 声明，由使用方自行安装。所以这份声明很短。

---

## 一、运行时依赖（不随本仓库分发）

| 组件 | 版本要求 | 许可 | 作者/维护 | 作用 |
|---|---|---|---|---|
| [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) | `~3.19.0` | **MIT** | DeepSeek | 配置 schema 校验（`z.object` / `volatile()`） |
| [`@deepseek-ai/cordis`](https://www.npmjs.com/package/@deepseek-ai/cordis) | `~4.1.0`（peer） | **MIT** | DeepSeek | 插件运行时（由 DSH 宿主提供，本包不打包） |

> `@deepseek-ai/cordis` 是 **peerDependency**：由 DeepSeek Harness 宿主提供，
> 本包既不打包也不修改它。

## 二、宿主能力（不属本仓库）

本插件通过宿主能力包与外部交互，**不直接依赖也不分发**这些实现：

| 能力 | 说明 |
|---|---|
| `ctx.llm` | 模型调用。具体服务商由使用方在 DSH 里配置 |
| `ctx.systemPrompt` | prompt 注入通道 |
| `ctx.tools` | 工具注册 |

> 这些能力背后可能是第三方服务（如各家大模型 API）。其许可与隐私条款由各自服务商提供，
> 与本仓库无关。数据流向见 [`PRIVACY.md`](PRIVACY.md) §4。

## 三、素材与角色版权

本仓库**不含任何角色素材**（图片、语音、音乐、模型权重均无）。

⚠️ 例外说明：`assets/default-persona/` 里自带一份**最小默认人格卡**（「小忆」）。
它是本仓库原创的通用占位文本，**不基于任何第三方作品的角色**，
目的是让全新安装立刻有个能说话的身份。你可以随意改名、改写或删除。

若你把自己的角色卡放进 `人格/角色卡/`，那部分内容的版权与合规责任由你承担
（例如基于《崩坏3》《原神》等作品的角色属于二创，需遵守原作方的二创规定）。

---

*本文件的依赖版本以 `package.json` 为准。升级依赖后请同步更新本文件。*
