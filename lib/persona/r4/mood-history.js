/**
 * mood-history — 情绪每日快照（R6.4）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 要解决的问题
 *
 *   `mood-axes.json` 只存**当前值**，昨天的值被今天的覆盖。
 *   结果：她无法回答「我最近怎么样」「这一周过得怎样」——
 *   因为她自己也没有历史。
 *
 *   本模块每天落一份快照，保留 30 天，供：
 *     ① `/状态` 命令读趋势
 *     ② 自我叙述引用
 *     ③ 诊断「最近状态」而不是只看此刻
 *
 * ── 设计 ────────────────────────────────────────────────────────────────────
 *
 *   · 文件：`state/mood-history/YYYY-MM-DD.json`
 *   · 内容：当天的最终状态（八维 + samples + 日期）
 *   · 幂等：同一天多次调用，只保留**最后一次**（覆盖写，反正是最新值）
 *   · 上限：只保留最近 30 天，更早的自动删（防无限膨胀）
 *   · 永不抛：任何 IO 异常都静默返回 false，绝不影响主链
 *
 * ── 为什么不是"每小时一份" ──────────────────────────────────────────────
 *
 *   情绪变化慢，一天一份足够看出趋势。每小时一份会让 30 天变成 720 个文件，
 *   且大部分是重复的。一天一份 = 30 个文件，每个 <1KB。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAxes } from './mood-axis.js';
// ★ 2026-11-25：原子写统一收敛到 shared/atomic（唯一真源）。
//   之前本文件自造 tmp+rename（固定 tmp 名 `tmp-${pid}`：多进程/多实例并发会互踩）。
//   writeJsonAtomic 提供：唯一 tmp 名 + fsync 文件与目录 + 失败清理 tmp + warn 后不重试。
import { writeJsonAtomic } from '../../shared/atomic.js';

/** 历史目录名。 */
export const HISTORY_DIR = 'mood-history';
/** 保留天数。 */
export const KEEP_DAYS = 30;

/** 本地日期 YYYY-MM-DD。 */
export function ymdOf(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 历史目录路径。 */
export function historyDirOf(dataRoot) {
  return join(String(dataRoot ?? '').trim(), 'state', HISTORY_DIR);
}

/**
 * 记录今日快照（幂等：同一天覆盖写）。
 *
 * @param {string} dataRoot
 * @param {object} axes 八维状态（会归一化）
 * @param {object} [logger]
 * @returns {boolean} 成功与否
 */
export function recordDaily(dataRoot, axes, logger) {
  try {
    const st = normalizeAxes(axes);
    const target = join(historyDirOf(dataRoot), `${ymdOf()}.json`);
    // 原子写：mkdir -p + 唯一 tmp + fsync + rename 全部由 shared/atomic 负责
    return writeJsonAtomic(target, { date: ymdOf(), ...st }, logger);
  } catch (e) {
    // normalizeAxes / 路径拼接等前置步骤失败（写盘失败已由 writeJsonAtomic 内部 warn）
    try { logger?.warn?.(`[mood-history] 记录快照失败：${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
    return false;
  }
}

/**
 * 清理超过 KEEP_DAYS 的旧快照。
 *
 * @param {string} dataRoot
 * @returns {number} 删除的文件数
 */
export function pruneOld(dataRoot, now = Date.now(), keepDays = KEEP_DAYS) {
  try {
    const dir = historyDirOf(dataRoot);
    if (!existsSync(dir)) return 0;
    const cutoff = ymdOf(Number(now) - Number(keepDays) * 86400000);
    let removed = 0;
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m) continue;
      if (m[1] < cutoff) {   // 字符串比较即可，YYYY-MM-DD 字典序 = 时间序
        try { rmSync(join(dir, f), { force: true }); removed += 1; } catch { /* ignore */ }
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * 读某个日期（或最近 N 天）的快照。
 *
 * @param {string} dataRoot
 * @param {object} [opts]
 * @param {string} [opts.date] 精确日期 YYYY-MM-DD
 * @param {number} [opts.recentDays] 最近 N 天（与 date 二选一）
 * @returns {Array<object>} 快照数组（按日期升序）
 */
export function readHistory(dataRoot, opts = {}) {
  try {
    const dir = historyDirOf(dataRoot);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
      const date = f.replace(/\.json$/, '');
      if (opts.date && date !== opts.date) continue;
      if (opts.recentDays && date < ymdOf(Date.now() - Number(opts.recentDays) * 86400000)) continue;
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        out.push({ ...j, date });
      } catch { /* 脏文件跳过 */ }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  } catch {
    return [];
  }
}

export default { HISTORY_DIR, KEEP_DAYS, ymdOf, historyDirOf, recordDaily, pruneOld, readHistory };
