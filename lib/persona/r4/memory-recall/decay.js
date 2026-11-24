/**
 * decay — 记忆强度衰退（**只作用于事件层**）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 极其重要：衰退不能一刀切 ★★
 *
 *   记忆库里有三层数据，性质完全不同：
 *
 *   | 层 | 内容 | 有时间属性 | 该衰退 |
 *   |---|---|---|---|
 *   | 人物卡 entities/people/ | 某人的档案（昵称/习惯/关系） | ❌ 长期事实 | **绝不** |
 *   | 群卡 entities/groups/    | 群的基本信息 | ❌ 基本不变 | **绝不** |
 *   | 事件 events/             | 发生过的事 | ✅ 会过时 | **作用在这里** |
 *
 *   证据：`recentEventsOf()` 里有 cutoff = now - days*24h 的过滤；
 *        `PersonCardIndex.find()` 没有任何时间过滤。
 *
 *   本模块**只处理 events/**。如果哪天要扩大范围，先想清楚：
 *   把"她不吃香菜"降级成概要 = 她开始记错人。
 *
 * ── 三档规则 ──────────────────────────────────────────────────────────────
 *
 *   pinned    ：含明确偏好词 → 永不降级（strength 保持 1）
 *   normal    ：30 天无提及 → 强度线性降到 0.4（保留可检索）
 *   ephemeral ：7 天开始降，60 天归零
 *
 * ── 安全边界（四条防线，缺一不可）──────────────────────────────────────────
 *
 *   ① **md 文件永不修改** —— 只读它算强度，不写回
 *   ② 归零后**不删除**，进 pending_review 等人工裁决
 *   ③ 索引可随时丢弃重建（md 是真相）
 *   ④ 每次运行都产出"今天降级了什么"的报告，可随时回查
 *
 *   有了这四条，「不灰度直接上」的最坏情况只是召回质量下降，
 *   执行一次重建即可恢复 —— 不会真的丢东西。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { TIER } from './semantic-index.js';

/** 默认阈值（毫秒）。 */
export const DECAY_DEFAULTS = Object.freeze({
  /** normal 档：多久无提及开始降。 */
  normalMs: 30 * 24 * 60 * 60 * 1000,
  /** ephemeral 档：多久开始降。 */
  ephemeralStartMs: 7 * 24 * 60 * 60 * 1000,
  /** ephemeral 档：多久归零。 */
  ephemeralZeroMs: 60 * 24 * 60 * 60 * 1000,
  /** normal 档降到的下限（不清零，保持可检索）。 */
  normalFloor: 0.4,
});

/**
 * 算一条记忆的新强度。
 *
 * 纯函数（不碰 IO），方便单测。
 *
 * @param {object} item { tier, strength, mentionedAt }
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{ strength: number, tier: string, reason: string }}
 */
export function computeStrength(item, now, cfg = DECAY_DEFAULTS) {
  const tier = String(item?.tier ?? TIER.NORMAL);
  const strength = Number.isFinite(item?.strength) ? Number(item.strength) : 1;
  const at = Number.isFinite(item?.mentionedAt) ? Number(item.mentionedAt) : now;
  const dt = Math.max(0, now - at);

  // ★ pinned 永不降级 —— 这是"不误杀偏好"的最后一道闸
  if (tier === TIER.PINNED) {
    return { strength: 1, tier, reason: 'pinned-keep' };
  }

  if (tier === TIER.EPHEMERAL) {
    if (dt >= cfg.ephemeralZeroMs) return { strength: 0, tier, reason: 'ephemeral-zero' };
    if (dt >= cfg.ephemeralStartMs) {
      // 从 start 到 zero 线性降到 0
      const span = Math.max(1, cfg.ephemeralZeroMs - cfg.ephemeralStartMs);
      const ratio = 1 - (dt - cfg.ephemeralStartMs) / span;
      return { strength: Math.max(0, Math.min(1, ratio)), tier, reason: 'ephemeral-fade' };
    }
    return { strength, tier, reason: 'ephemeral-fresh' };
  }

  // normal：超过阈值后线性降到 floor（不清零）
  if (dt >= cfg.normalMs) {
    // 用 30 天为单位继续降，最低到 floor
    const over = dt - cfg.normalMs;
    const steps = over / cfg.normalMs;                 // 每过 30 天降一档
    const target = Math.max(cfg.normalFloor, strength - steps * 0.2);
    return { strength: target, tier, reason: 'normal-fade' };
  }
  return { strength, tier, reason: 'normal-fresh' };
}

/**
 * 对索引里某个 scope 的所有条目跑一次衰退，返回变更报告。
 *
 * ⚠️ 只更新索引里的 strength 字段，**不碰任何 md 文件**。
 *
 * @param {object} idx   openIndex() 返回
 * @param {string} scope 群 ID
 * @param {number} [now]
 * @param {object} [cfg]
 * @returns {{ changed: Array, zeroed: Array, scanned: number }}
 */
export function runDecay(idx, scope, now = Date.now(), cfg = DECAY_DEFAULTS) {
  const sid = String(scope ?? '').trim();
  if (!sid || !idx?.db) return { changed: [], zeroed: [], scanned: 0 };

  let rows = [];
  try {
    rows = idx.db
      .prepare("SELECT id,tier,strength,mentionedAt,body FROM mem WHERE scope = ? AND superseded = '0'")
      .all(sid);
  } catch {
    return { changed: [], zeroed: [], scanned: 0 };
  }

  const changed = [];
  const zeroed = [];
  const upd = idx.db.prepare("UPDATE mem SET strength = ? WHERE id = ?");

  for (const r of rows) {
    const cur = Number(r.strength) || 0;
    const next = computeStrength(
      { tier: r.tier, strength: cur, mentionedAt: Number(r.mentionedAt) },
      now,
      cfg,
    );
    if (Math.abs(next.strength - cur) < 1e-6) continue;

    changed.push({
      id: r.id,
      tier: r.tier,
      from: cur,
      to: next.strength,
      reason: next.reason,
      preview: String(r.body ?? '').slice(0, 40),
    });
    if (next.strength <= 0) zeroed.push(r.id);

    try { upd.run(String(next.strength), r.id); } catch { /* ignore */ }
  }

  return { changed, zeroed, scanned: rows.length };
}

/**
 * 生成"今天降级了什么"的报告（人类可读）。
 *
 * 为什么要这个：不灰度直接上，靠它事后回查。
 *
 * @param {object} result runDecay 的返回
 * @param {string} scope
 * @param {number} now
 * @returns {object} 可 JSON 序列化的报告
 */
export function buildReport(result, scope, now = Date.now()) {
  return {
    at: new Date(now).toISOString(),
    scope: String(scope ?? ''),
    scanned: result?.scanned ?? 0,
    changedCount: result?.changed?.length ?? 0,
    zeroedCount: result?.zeroed?.length ?? 0,
    changed: (result?.changed ?? []).map((c) => ({
      id: c.id,
      tier: c.tier,
      from: Number(c.from.toFixed(3)),
      to: Number(c.to.toFixed(3)),
      reason: c.reason,
      preview: c.preview,
    })),
  };
}

export default { DECAY_DEFAULTS, computeStrength, runDecay, buildReport };
