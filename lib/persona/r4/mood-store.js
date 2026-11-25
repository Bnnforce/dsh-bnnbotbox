/**
 * mood-store — 八维状态读写（2026-11-21 R5.4 v3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计要点
 *
 *   ① **原子写**：统一走 `lib/shared/atomic.js` 的 writeJsonAtomic
 *      （唯一 tmp 名 + fsync 文件与目录 + 失败清理 tmp）
 *   ② **失败关闭**：任何 IO 异常都返回默认值，绝不抛
 *   ③ **不做兼容迁移**（v3 决定，见下）
 *   ④ **归一化**：读到脏数据自动修复
 *   ⑤ **不重试**：写失败 warn 后跳过（atomic.js 的红线：绝不 busy-wait 阻塞主链）
 *      —— 2026-11-25 起删除原 `sleepSync(30ms) × 6` 同步忙等重试
 *
 * ── 为什么 v3 删掉了「旧四维兼容」和「mood-tint 迁移」────────────────────
 *
 *   用户明确要求「不要打补丁、不要临时方案」。旧实现里有两条迁移分支：
 *
 *     · readAxes() 读不到新文件 → migrateLegacy() 从 mood-tint.json 迁移
 *     · normalizeAxes() 缺字段 → 补中性值
 *
 *   这两条会**永久留在热路径上**，且掩盖真实问题（旧数据永远不知道何时清完）。
 *
 *   v3 改为**一次性干净切换**：
 *     · 上线前由运维脚本把 `mood-axes.json` 备份成 `mood-axes.v4.bak.json`
 *     · 新代码只认八维；读到缺字段 → 视为空状态（samples 归零）⇒ 冷启动重累积
 *     · `mood-tint.js` / `mood-tint.json` 由运维脚本归档，代码里**没有任何引用**
 *
 *   代价：上线后前 3 轮不注入（MIN_SAMPLES=3）。这是**可接受的一次性成本**，
 *   远好于永久背着兼容分支。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_AXES, DIMENSIONS, normalizeAxes } from './mood-axis.js';
// ★ 2026-11-25：原子写统一收敛到 shared/atomic（唯一真源）。
//   之前本文件自造 tmp+rename，并用 sleepSync(30ms)×6 busy-wait 重试 EPERM
//   （同步忙等会阻塞聊天主链路）。shared/atomic 负责：唯一 tmp 名、fsync、失败清理。
import { writeJsonAtomic } from '../../shared/atomic.js';
// ★ 2026-11-24 R6.4：情绪每日快照。mood-history 只依赖 mood-axis，无循环依赖，
//   直接 static import。recordDaily 幂等（同一天覆盖写），失败静默返回 false。
import { recordDaily } from './mood-history.js';

/** 八维状态文件名。 */
export const AXES_FILE = 'mood-axes.json';

/** 旧四维文件备份名（只用于运维脚本，代码不读）。 */
export const V4_BACKUP_FILE = 'mood-axes.v4.bak.json';

/**
 * 状态目录。
 * @param {string} dataRoot
 */
export function stateDirOf(dataRoot) {
  return join(String(dataRoot ?? '').trim(), 'state');
}

/**
 * 八维状态文件路径。
 * @param {string} dataRoot
 */
export function axesPathOf(dataRoot) {
  return join(stateDirOf(dataRoot), AXES_FILE);
}

/**
 * 把调用方 logger 适配成 shared/atomic 的 logger 形状，并给告警加 `[mood]` 前缀。
 *
 * shared/atomic 自己会发 `[atomic] 原子写失败…` 的 warn；为了保持本模块原有
 * 的日志语义（`[mood] 写状态失败：…`），这里在 warn 里再补一条带 `[mood]` 前缀的。
 * 传入的 logger 缺 warn 方法 → 返回 undefined（atomic 内部走静默）。
 *
 * @param {object} [logger]
 */
function writeWarnAdapter(logger) {
  if (!logger || typeof logger.warn !== 'function') return undefined;
  return {
    warn: (msg) => {
      try { logger.warn(`[mood] 写状态失败：${msg}`); } catch { /* ignore */ }
    },
  };
}

/**
 * 判断读到的对象是否是「完整的八维状态」。
 *
 * 只要缺任何一个维度的 key，就认为不是 v3 状态 ⇒ 视为空（冷启动）。
 * **这就是「不做兼容」的落地点** —— 不做补值，直接重来。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isFullV8(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return DIMENSIONS.every((k) => Number.isFinite(Number(raw[k])));
}

/**
 * 读八维状态。**永不抛**。
 *
 * @param {string} dataRoot
 * @param {object} [logger]
 * @returns {{mood:number,energy:number,connection:number,composure:number,
 *            closeness:number,patience:number,confidence:number,focus:number,
 *            samples:number,updatedAt:number}}
 */
export function readAxes(dataRoot, logger) {
  const p = axesPathOf(dataRoot);
  try {
    if (!existsSync(p)) return { ...EMPTY_AXES };
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // ★ v3：不是完整八维 ⇒ 视为空状态（不做补值兼容）
    if (!isFullV8(raw)) {
      try { logger?.warn?.('[mood] 状态文件不是完整八维（旧版本），按空状态处理，将重新累积'); } catch { /* ignore */ }
      return { ...EMPTY_AXES };
    }
    return normalizeAxes(raw);
  } catch (e) {
    try { logger?.warn?.(`[mood] 读状态失败（用默认值）：${e instanceof Error ? e.message : String(e)}`); } catch { /* ignore */ }
    return { ...EMPTY_AXES };
  }
}

/**
 * 写八维状态（原子写 + EPERM 重试）。**永不抛**。
 *
 * @param {string} dataRoot
 * @param {object} axes
 * @param {object} [logger]
 * @returns {boolean} 成功与否
 */
export function writeAxes(dataRoot, axes, logger) {
  const st = normalizeAxes(axes);
  const target = axesPathOf(dataRoot);

  // 原子写全部收敛到 shared/atomic（唯一 tmp 名 + fsync + 失败清理 tmp + warn 不重试）。
  // writeJsonAtomic 内部已 mkdir -p，无需前置 existsSync/mkdirSync。
  // ★ 2026-11-25：删除了原先的 sleepSync(30ms) × 6 busy-wait 重试（同步阻塞聊天主链）。
  //   注意：atomic.js 的设计是「写失败 warn 后跳过，不重试」——不阻塞优先。
  const ok = writeJsonAtomic(target, st, writeWarnAdapter(logger));
  if (!ok) return false;

  // ★ 2026-11-24 R6.4：写成功后顺带记录今日快照（情绪历史）。
  //   幂等（同一天覆盖写），失败绝不影响状态写入（主链优先）。
  try { recordDaily(dataRoot, st, logger); } catch { /* ignore */ }
  return true;
}

/**
 * 删除状态（测试 / 回滚用）。
 * @param {string} dataRoot
 */
export function clearAxes(dataRoot) {
  try { rmSync(axesPathOf(dataRoot), { force: true }); return true; } catch { return false; }
}

export default {
  AXES_FILE,
  V4_BACKUP_FILE,
  stateDirOf,
  axesPathOf,
  isFullV8,
  readAxes,
  writeAxes,
  clearAxes,
};
