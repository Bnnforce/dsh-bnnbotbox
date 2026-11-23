/**
 * profile-types — 人物画像的常量与「永久/临时」决策规则
 *
 * 从 `r4/profile.ts` 拆出（重构阶段 2 / 批次 B）。
 * 只放**常量 + 纯决策函数 + 类型再导出**，不放 IO、不放统计。
 */

import type {
  Dictionaries,
  ExtractedTag,
  ProfileEvent,
  ProfileEventsFile,
  ProfileIndex,
  ProfileIndexEntry,
} from './types.js';

// 让 profile-extract / profile-view 不必各自再 import 一遍 types.ts
export type {
  Dictionaries,
  ExtractedTag,
  ProfileEvent,
  ProfileEventsFile,
  ProfileIndex,
  ProfileIndexEntry,
};

/** 一天的毫秒数（★ 2026-11-05 批次 D：定义已归一到 `r4/time.ts`，这里只做再导出）。 */
export { DAY_MS } from './time.js';

/** 默认保留天数（图纸 3.3/3.4：近 7 天）。 */
export const DEFAULT_RETENTION_DAYS = 7;

/** 默认每 user 最多 tag 数（图纸 3.4：50）。 */
export const DEFAULT_MAX_TAGS_PER_USER = 50;

/** 默认单次最多 tag 数（图纸 3.2：5）。 */
export const DEFAULT_MAX_TAGS_PER_EXTRACTION = 5;

/** 默认 tag 字符上限（图纸 3.2：20 字）。 */
export const DEFAULT_MAX_TAG_CHARS = 20;

/** 默认画像正文字数上限（图纸 3.4：80 字）。 */
export const DEFAULT_MAX_PROFILE_CHARS = 80;

/** 默认冷启动天数（图纸 3.5：3 天）。 */
export const DEFAULT_COLD_START_DAYS = 3;

/** 单 user 永久标签上限（决策点 ④：防止无限膨胀；满了按最久未提及淘汰）。 */
export const DEFAULT_MAX_PERMANENT_PER_USER = 12;

/**
 * ★ 2026-11-04 双层记忆 · category 硬规则（决策点 ②）。
 *
 * 模型对 `permanent` 的判断不足以完全信任，所以这几类 **category 强制覆盖为永久**：
 *   - `互动风格` / `常用表情/梗` / `语气特征` —— 这三类是**稳定人格特征**，
 *     一旦被提取就代表"这个人怎么说话"，绝不可能是"昨天吃了什么"。
 *     即模型误标 `permanent:false`，这里也纠正为 `true`。
 *
 * 反向**不强制**：`话题偏好` / `活跃时段` 允许模型判断（"最近爱聊股票"确实可能是临时的）。
 *
 * 配置里 `privacy_whitelist` 若被用户改过（增删 category），这里按字面匹配；
 * 不在本集合里的 category 一律**听模型的**（不硬改），保证向后兼容。
 */
const FORCED_PERMANENT_CATEGORIES = new Set(['互动风格', '常用表情/梗', '语气特征']);

/** 该 category 是否被强制为永久标签。 */
export function isForcedPermanentCategory(category: string): boolean {
  return FORCED_PERMANENT_CATEGORIES.has(String(category ?? '').trim());
}

/**
 * 决定一条已通过校验的 tag 是否算永久标签（决策点 ② 的唯一入口）。
 *
 * 优先级：category 硬规则 **高于** 模型给的 `permanent`。
 * 模型给的 `permanent` 非布尔（undefined / 字符串 / 数字）→ 按 false（保守）。
 */
export function resolvePermanent(category: string, modelFlag: unknown): boolean {
  if (isForcedPermanentCategory(category)) return true;
  return modelFlag === true;
}
