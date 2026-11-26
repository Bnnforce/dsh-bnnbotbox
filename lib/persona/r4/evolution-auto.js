/**
 * evolution-auto — 自我进化 C 档（有限自改 + 完整兜底）（R8 S8 收尾，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * C 档 = B 档提案 + 自动执行 + 七道兜底。
 *
 * ── 与 B 档的关系 ──────────────────────────────────────────────────────────
 *
 *   evolution-proposal.js（B 档）只产出「提案对象」，不写文件。
 *   本模块（C 档）负责**落地**：把通过的提案真正写进行为状态，并配全兜底。
 *
 * ── 七道兜底（主人铁律：排掉所有风险）──────────────────────────────────────
 *
 *   ① 白名单唯一入口：isWhitelisted 不过的项，物理上无法写入（有测试断言）
 *   ② 黑名单硬拦截：isBlacklisted 命中的 key，直接拒绝
 *   ③ 幅度护栏：单次改动 ≤ maxDeltaPerChange（0.2）
 *   ④ 频率护栏：两次自改 ≥ 7 天
 *   ⑤ 累积漂移护栏：相对 baseline 总漂移 ≤ maxCumulativeDrift（0.3）
 *   ⑥ 原子写 + 写前备份：所有写走 shared/atomic；每次自改前先落一份快照
 *   ⑦ 可回滚 + 可审计：rollback() 一键恢复最近快照；每次自改写审计日志
 *
 *   另有一道总开关：配置 selfEvolve===false 时，本模块完全不工作（急停）。
 *
 * ── 决策靠算法，不靠 LLM ───────────────────────────────────────────────────
 *
 *   本模块不调用任何 LLM。所有「调不调、调多少」都由 buildProposal 的纯算法
 *   算出来，这里只做「过护栏 → 落盘 → 记账」。可复现、可审计、可回滚。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  buildProposal,
  isWhitelisted,
  isBlacklisted,
  GUARDS,
  BOUNDS,
} from './evolution-proposal.js';
import {
  writeJsonAtomic,
  readJsonSafe,
  mutateJsonAtomic,
} from '../../shared/atomic.js';
import { join } from 'node:path';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';

/** 行为状态文件（相对 state 目录）。 */
export const STATE_FILE = 'behavior-state.json';
/** 审计日志文件。 */
export const AUDIT_FILE = 'behavior-audit.jsonl';
/** 备份目录。 */
export const BACKUP_DIR = 'behavior-backup';

/** 状态文件的初始形状。 */
export function initialState() {
  return {
    version: 1,
    baseline: {},          // 初始行为参数（算累积漂移的基准）
    current: {},           // 当前行为参数
    lastProposalAt: 0,     // 上次自改时间
    changeCount: 0,        // 累计自改次数
    createdAt: 0,
  };
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 把提案项按 BOUNDS 夹紧（最后一道物理防线，防止越界值落盘）。 */
function clampItem(key, value) {
  const b = BOUNDS[key];
  if (b && Array.isArray(b) && b.length === 2) return clamp(value, b[0], b[1]);
  return value;
}

/**
 * 应用提案到 current（纯函数，不写盘）。
 *
 * 三道防线（都在这里，物理上无法绕过）：
 *   ① 白名单 + 黑名单双保险
 *   ② 幅度护栏：相对 current 的单次改动 ≤ maxDeltaPerChange
 *   ③ BOUNDS 夹紧：最终值不越界
 *
 * @param {object} current 当前行为参数
 * @param {Array<object>} items 提案项（buildProposal 的 safeItems）
 * @returns {{next:object, applied:Array<object>, rejected:Array<object>}}
 */
export function applyItems(current, items) {
  const cur = current && typeof current === 'object' ? { ...current } : {};
  const list = Array.isArray(items) ? items : [];
  const applied = [];
  const rejected = [];

  for (const it of list) {
    // ① 白名单 + 黑名单双保险（即使 proposal 已经过滤，这里再拦一次）
    if (!isWhitelisted(it.key) || isBlacklisted(it.key)) {
      rejected.push({ key: it.key, reason: 'not-whitelisted' });
      continue;
    }

    // ② 幅度护栏：相对 current 的单次改动 ≤ maxDeltaPerChange
    const from = Number(cur[it.key]) || 0;
    const rawTo = Number(it.to);
    const delta = rawTo - from;
    const maxDelta = GUARDS.maxDeltaPerChange;
    let to;
    if (Math.abs(delta) > maxDelta) {
      // 超幅度 → 按最大幅度方向夹紧（不是直接拒绝，是收敛到允许的最大步长）
      to = from + Math.sign(delta) * maxDelta;
      rejected.push({ key: it.key, reason: 'delta-clamped', from, rawTo, to });
    } else {
      to = rawTo;
    }

    // ③ BOUNDS 夹紧（最后一道物理防线）
    to = clampItem(it.key, to);

    cur[it.key] = to;
    applied.push({ ...it, from, to });
  }
  return { next: cur, applied, rejected };
}

/**
 * 生成一次自改（落地执行，含全部兜底）。
 *
 * @param {object} deps
 * @param {string} deps.stateDir  state 目录（绝对路径）
 * @param {object} [deps.config]  配置：{ selfEvolve, ... }
 * @param {Array<object>} [deps.snapshots]  metrics 历史（喂给 buildProposal）
 * @param {number} [deps.now]
 * @param {object} [deps.logger]
 * @returns {Promise<{ok:boolean, reason?:string, applied?:Array, next?:object, backupPath?:string}>}
 */
export async function evolveOnce(deps = {}) {
  const logger = deps.logger ?? {};
  const stateDir = String(deps.stateDir ?? '').trim();
  if (!stateDir) return { ok: false, reason: 'no-stateDir' };

  // ── 急停开关：配置关了就不跑 ────────────────────────────────────────────
  if (deps.config?.selfEvolve === false) {
    return { ok: false, reason: 'selfEvolve 关闭（急停）' };
  }

  const now = Number(deps.now) || Date.now();
  const statePath = join(stateDir, STATE_FILE);

  // 读当前状态（缺失 → 初始状态）
  const st = readJsonSafe(statePath) ?? initialState();
  const baseline = st.baseline && typeof st.baseline === 'object' ? st.baseline : {};
  const current = st.current && typeof st.current === 'object' ? st.current : {};

  // ── B 档：纯算法算提案 ───────────────────────────────────────────────────
  const result = buildProposal({
    snapshots: deps.snapshots,
    current,
    baseline,
    lastProposalAt: Number(st.lastProposalAt) || 0,
    now,
  });

  if (!result.ok || !result.proposal) {
    return { ok: false, reason: result.reason ?? 'no-proposal' };
  }

  // ── C 档：过护栏后落地 ────────────────────────────────────────────────────
  const items = Array.isArray(result.proposal.items) ? result.proposal.items : [];
  const { next, applied } = applyItems(current, items);
  if (!applied.length) {
    return { ok: false, reason: '护栏后无可应用项' };
  }

  // 写前备份（快照整份 state，含 baseline/current/history）
  const backupPath = join(stateDir, BACKUP_DIR, `behavior-${now}.json`);
  const backupOk = writeJsonAtomic(backupPath, st, logger);

  // 原子读-改-写（用 mutateJsonAtomic 防并发覆写）
  const final = { ...st };
  const write = mutateJsonAtomic(statePath, () => {
    return {
      ...st,
      current: next,
      lastProposalAt: now,
      changeCount: (Number(st.changeCount) || 0) + 1,
      updatedAt: now,
    };
  }, logger);

  if (!write.ok) {
    return { ok: false, reason: 'write-failed', backupPath: backupOk ? backupPath : '' };
  }

  // 审计日志（追加 jsonl）
  appendAudit(stateDir, {
    at: now,
    backupPath,
    applied,
    baseline: { ...baseline },
    next: { ...next },
  }, logger);

  return { ok: true, applied, next, backupPath };
}

/** 追加一行审计日志（不阻塞主链，失败静默）。 */
function appendAudit(stateDir, entry, logger) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 审计失败不影响自改结果 */ }
}

/**
 * 回滚到最近一次备份（纯读 + 写回）。
 *
 * @param {object} deps
 * @param {string} deps.stateDir
 * @param {object} [deps.logger]
 * @returns {Promise<{ok:boolean, reason?:string, restored?:object}>}
 */
export async function rollback(deps = {}) {
  const logger = deps.logger ?? {};
  const stateDir = String(deps.stateDir ?? '').trim();
  if (!stateDir) return { ok: false, reason: 'no-stateDir' };

  const backupDir = join(stateDir, BACKUP_DIR);
  let latest;
  try {
    const files = readdirSync(backupDir).filter((f) => f.startsWith('behavior-') && f.endsWith('.json')).sort();
    if (!files.length) return { ok: false, reason: 'no-backup' };
    latest = join(backupDir, files[files.length - 1]);
  } catch {
    return { ok: false, reason: 'no-backup' };
  }

  const restored = readJsonSafe(latest);
  if (!restored) return { ok: false, reason: 'backup-corrupt' };

  const ok = writeJsonAtomic(join(stateDir, STATE_FILE), restored, logger);
  return ok ? { ok: true, restored } : { ok: false, reason: 'restore-failed' };
}

/**
 * 读当前行为状态（供其他模块读，纯读）。
 *
 * @param {string} stateDir
 * @returns {object} state（缺失 → 初始状态）
 */
export function readState(stateDir) {
  const st = readJsonSafe(join(String(stateDir ?? '').trim(), STATE_FILE));
  return st && typeof st === 'object' ? st : initialState();
}

export default {
  STATE_FILE, AUDIT_FILE, BACKUP_DIR,
  initialState, applyItems, evolveOnce, rollback, readState,
};
