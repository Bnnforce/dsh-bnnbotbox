/**
 * mood-store — 八维状态读写（2026-11-21 R5.4 v3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计要点
 *
 *   ① **原子写**：tmp + rename，防并发写坏文件
 *   ② **失败关闭**：任何 IO 异常都返回默认值，绝不抛
 *   ③ **不做兼容迁移**（v3 决定，见下）
 *   ④ **归一化**：读到脏数据自动修复
 *   ⑤ **EPERM 重试**：Android FUSE 瞬时错误（规范 §7.2）
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
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_AXES, DIMENSIONS, normalizeAxes } from './mood-axis.js';

/** 八维状态文件名。 */
export const AXES_FILE = 'mood-axes.json';

/** 旧四维文件备份名（只用于运维脚本，代码不读）。 */
export const V4_BACKUP_FILE = 'mood-axes.v4.bak.json';

/** Android FUSE 瞬时 EPERM 重试次数（规范 §7.2）。 */
const WRITE_RETRIES = 6;

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

/** 同步睡（毫秒），用于 EPERM 重试间隔。 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) { /* busy wait */ }
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
  const dir = stateDirOf(dataRoot);
  const target = axesPathOf(dataRoot);
  const tmp = `${target}.tmp-${process.pid}`;
  const text = JSON.stringify(st);

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* 下面写会再报 */ }

  // ① 写临时文件（EPERM 重试）
  let lastErr = null;
  for (let i = 0; i < WRITE_RETRIES; i += 1) {
    try {
      writeFileSync(tmp, text, 'utf8');
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      sleepSync(30);
    }
  }
  if (lastErr) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    try { logger?.warn?.(`[mood] 写状态失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`); } catch { /* ignore */ }
    return false;
  }

  // ② rename 到目标（同样可能瞬时 EPERM）
  for (let i = 0; i < WRITE_RETRIES; i += 1) {
    try {
      renameSync(tmp, target);
      return true;
    } catch (e) {
      lastErr = e;
      sleepSync(30);
    }
  }
  try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  try { logger?.warn?.(`[mood] 状态替换失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`); } catch { /* ignore */ }
  return false;
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
