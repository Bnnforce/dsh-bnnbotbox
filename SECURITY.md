# 安全说明

## 数据在哪里

**全部在你自己机器上。** 没有云端、没有遥测、没有第三方上报。

| 数据 | 位置 |
|---|---|
| 人格卡 / 规则 / 素材 | `{工作区}/Bot/人格/` |
| 群记忆 / 人物卡 | `{数据根}/.qqbot-extensions/data/group-memory/` |
| 聊天记录 | `{数据根}/.qqbot/msg-history/` |
| 配置 | DSH profile 的 `cordis.patch.yml` |

**QQ 凭证**（AppID/AppSecret）由 DSH 的通道插件保管，本插件不读也不存。

## 会接触到什么

本插件处理这些个人信息：

- 群友昵称、openid（QQ 平台的账号标识）
- 生日（如果群友主动说过）
- 聊天内容（用于生成记忆和人物画像）

详见 [`PRIVACY.md`](PRIVACY.md)。

## 边界设计

| 机制 | 作用 |
|---|---|
| **每群独立记忆** | A 群的记忆绝不会出现在 B 群的召回里（有测试断言） |
| **8 个安全标记** | 规则文件必须含全部标记，否则插件拒绝加载 |
| **主人白名单** | 写操作默认可限主人（`ownerWriteOnly`） |
| **无出网请求** | 插件本身不发起任何外部网络请求 |

## 报告漏洞

**请不要在公开 issue 里贴聊天正文或凭证。**

- 用 GitHub 的 [Private vulnerability reporting](https://github.com/Bnnforce/dsh-bnnbotbox/security/advisories/new)
- 或者发邮件到仓库 owner 的公开邮箱

我会在 7 天内回复。如果确认是漏洞，修复会优先于新功能。
