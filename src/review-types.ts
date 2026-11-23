/**
 * review-types — 复盘/错题本的公共类型与常量
 *
 * 从 `review.ts` 拆出（重构阶段 2 / 批次 A）。
 * 这里只放**纯类型与常量**，不放任何逻辑，避免被拆出去的文件互相 import 造成循环。
 */

/** 一条错题本记录（判官/群友吐槽都写这个结构）。 */
export interface ReviewRecord {
  at: number;
  sessionId: string;
  groupId?: string;
  persona?: string;
  source?: 'correction' | 'judge';
  userText: string;
  assistantText: string;
}

/** 轻量模型路由。 */
export interface ReviewRoute {
  provider: string;
  model: string;
}

/**
 * 历史包袱（2026-11-01 的旧口径）：只有「比安安」单独一份 `review-buffer-biananan.jsonl`，
 * 其余全部进主本 `review-buffer.jsonl`。那是当时「默认人格=比安安」的特例写法。
 *
 * 2026-11-02 修正（主人要求「按当前实际人格正确分流」）：
 *   · 默认人格已经改成**爱莉希雅**，继续用「名字里含比安安」当判据是过时的；
 *   · 现在改成**通用**分流：任何具名人格 → 自己的本子 `review-buffer-<安全人格名>.jsonl`；
 *     没有人格信息（`persona` 为空）→ 主本 `review-buffer.jsonl`；
 *   · 为兼容已有数据，`比安安` 仍然映射到历史文件名 `review-buffer-biananan.jsonl`
 *     （否则老的错题会突然读不到）。
 *
 * 读侧改为**扫目录**（`review-buffer*.jsonl` 全部读），这样新增人格不需要再改这个常量，
 * 老的三个本子（主本 + 比安安本 + 爱莉希雅本）都能被复盘读到。
 */
export const LEGACY_REVIEW_BUFFER_FILES = ['review-buffer.jsonl', 'review-buffer-biananan.jsonl'] as const;

/** 主本（无人格信息时写入）。 */
export const MAIN_REVIEW_BUFFER = 'review-buffer.jsonl';
