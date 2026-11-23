/**
 * phrase-cooldown — 文案冷却小表（R4.3，F2/F3/F4/F5 共用）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 阶段 A1：**完整实现**（不是骨架 —— 三个并行批次都要用它，必须先稳定）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 为什么需要独立小表，而不是塞进画像/关系文件：
 *   · 冷却条目和业务实体没有必然关系（同一句仪式文案不分用户）
 *   · 独立表方便整体过期清理，不会污染画像
 *
 * 安全边界：
 *   · 上限 500 条，超出按时间淘汰最旧
 *   · 条目 30 天过期自动清理
 *   · 读损坏 → 视为空表（绝不抛）
 *   · 写失败 → 静默（冷却失效最多是多说一次，不影响主流程）
 */

import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './atomic.js';
import type { R4Logger } from './logger.js';

interface CooldownFile {
  version: number;
  /** key -> 最后一次使用时间（ms） */
  items: Record<string, number>;
}

const VERSION = 1;
/** 表上限：超过按时间淘汰最旧（防无限增长）。 */
const MAX_ITEMS = 500;
/** 条目过期：30 天没用就删。 */
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

export function cooldownPath(root: string): string {
  return join(root, 'state', 'phrase-cooldown.json');
}

function readTable(root: string): CooldownFile {
  const raw = readJsonSafe<CooldownFile>(cooldownPath(root));
  if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
    return { version: VERSION, items: {} };
  }
  return { version: VERSION, items: Object.assign({}, raw.items) as Record<string, number> };
}

/**
 * 某个 key 是否还在冷却中。
 * @param days 冷却天数；`<= 0` 表示不冷却（永远返回 false）
 */
export function isCoolingDown(key: string, days: number, root: string, now = Date.now()): boolean {
  if (!key || !(days > 0)) return false;
  const at = Number(readTable(root).items[key] ?? 0);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at < days * 24 * 60 * 60 * 1000;
}

/** 标记某个 key 已使用（顺手做过期清理 + 上限淘汰）。写失败静默。 */
export function markUsed(key: string, root: string, now = Date.now(), logger?: R4Logger): void {
  if (!key) return;
  const table = readTable(root);
  table.items[key] = now;

  // ① 过期清理
  for (const [k, v] of Object.entries(table.items)) {
    const at = Number(v);
    if (!Number.isFinite(at) || now - at > EXPIRE_MS) delete table.items[k];
  }
  // ② 上限淘汰（最旧优先删）
  const keys = Object.keys(table.items);
  if (keys.length > MAX_ITEMS) {
    keys.sort((a, b) => Number(table.items[a] ?? 0) - Number(table.items[b] ?? 0));
    for (const k of keys.slice(0, keys.length - MAX_ITEMS)) delete table.items[k];
  }
  try { writeJsonAtomic(cooldownPath(root), table, logger); } catch { /* 冷却失效不影响主流程 */ }
}

/**
 * 从候选里随机挑一个**不在冷却中**的。
 * @returns 空串 = 全部都在冷却中
 */
export function pickUnused(
  candidates: string[],
  days: number,
  root: string,
  now = Date.now(),
  random: () => number = Math.random,
): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const fresh = candidates.filter((c) => Boolean(c) && !isCoolingDown(c, days, root, now));
  if (fresh.length === 0) return '';
  const idx = Math.min(fresh.length - 1, Math.floor(random() * fresh.length));
  return fresh[idx] ?? '';
}
