/**
 * R4.0 模块三：人物画像（强防幻觉）— **统一出口门面**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 重构阶段 2 / 批次 B（2026-11-05）：
 *   本文件原来是 550 行的单体模块，现按「写路径 / 读路径 / 公共件」拆成 4 个文件：
 *
 *     profile-types.ts    常量 + 「永久/临时」决策规则（决策点 ②）+ 类型再导出
 *     profile-utils.ts    内部纯工具（深拷贝、全半角、敏感词…）**不对外暴露**
 *     profile-extract.ts  写路径：校验 → 归一化 → 合并 → 7 天/50 tag 清理
 *     profile-view.ts     读路径：画像正文渲染、统计、冷启动、提及记录
 *
 *   本文件**精确 re-export 原有的 14 个公开函数**，一个不多一个不少 ——
 *   保证对外 API 面与拆分前**完全一致**（所有调用方的 import 路径与签名都不用改）。
 *
 *   业务行为零变化：所有逻辑是原样搬移，连注释里的历史决策都逐字保留。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 图纸 3.1–3.6 纪律（原文保留）：
 *  - 校验从严：category ∈ privacy_whitelist、不命中敏感词、tag ≤20 字、单次 ≤5 个；
 *  - 归一化：全半角 → 英文小写 → trim → 同义词；
 *  - 「≥3 次才进画像正文」与「7 天清理」「每 user 最多 50 tag」「80 字」全部本地统计；
 *    模型输出里的任何计数一律忽略；
 *  - 冷启动 3 天内只写不用；lastMentionedTags 仅由「AI 主动提及/追问」调用方更新。
 *
 * 纪律：本模块**不做 IO、不用 Date.now()、不用随机数**；`now` 一律入参，返回新对象
 * （调用方负责原子写）。签名逐字对齐 `contracts.ts`。
 */

export { isForcedPermanentCategory, resolvePermanent } from './profile-types.js';

export { normalizeTag, validateExtractedTag, applyExtraction, pruneEvents } from './profile-extract.js';

export {
  countRecent,
  recentTempEventsOf,
  countPermanentTags,
  buildProfileText,
  canInjectProfile,
  touchColdStart,
  markTagMentioned,
  staleTagsFor,
} from './profile-view.js';
