/**
 * mood-official — 官方心理数据适配层（2026-11-21 R5.4 八维）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么有这个文件（铁律 1：先查官方，别自己造）
 *
 * 做八维时第一版方案打算从 `relationships/*.json`（我们自己的数据）
 * 自己算「亲近度 / 耐心 / 自信」。按铁律去读官方 `dist/features/`，发现
 * **官方早就把这三件事做完了**，而且成熟得多：
 *
 *   · attitude.js      好感度 A 值（1598 条事件累积、XP、等级、阻尼、范围）
 *   · local-signals.js 熟识度 memoryStrength（复习次数 + 遗忘曲线，可解释）
 *   · emo-samples.js   情绪分类（暖 / 冷 / 中性，本地 kNN）
 *   · tendency-samples.js 意向分类（亲近 / 拒绝 / 任务，本地 kNN）
 *
 * **关键事实**：官方这些产出**没有任何 prompt 注入消费方**
 * （全文搜 attitudeTier / memoryTier 只在自己模块内用，不进 inject-rules.js）
 * ⇒ 官方是「只记账不用」，**把状态注入对话是真实缺口，我们补它不违反铁律**。
 *
 * ── 本模块的定位 ────────────────────────────────────────────────────────────
 *
 * **只做映射，不重算算法。** 这是本文件唯一的设计原则：
 *
 *   ✅ 读官方 attitude.json 的 `a` 值 → 用官方同一个 R(F)=1+2F 归一化 → closeness
 *   ❌ 不看 `a`，自己从 messageCount 重新推一个"亲近度"（那是重复造轮子）
 *
 * 官方算法依据（逐行读 dist 确认，改动前请复核）：
 *   attitude.js:122  attitudeRange(f)  = 1 + 2×clamp(f,0,1)     好感度范围
 *   attitude.js:49   attitudeTier(a,f) = ratio 分 5 档          态度档位
 *   attitude.js:126  attitudeDamping(f)= 1/(1+3f)               阻尼（本模块不用）
 *   local-signals.js memoryStrength(e) 熟识度 0~1（本模块不重算，只用现成值）
 *
 * ── 数据安全 ────────────────────────────────────────────────────────────────
 *
 * 全部**只读**。绝不写官方文件。任何异常返回空对象（调用方降级 0.5），绝不抛。
 * 注入文本只出「描述词」，**绝不出现 openid / 昵称**（隐私红线）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 中性值（与 mood-axis 保持一致）。 */
const NEUTRAL = 0.5;

/** 钳制到 0~1；非法值 → 中性。 */
function clamp01(v) {
  // null / undefined / '' 必须显式排除（Number(null) === 0 会误判成 0）
  if (v === null || v === undefined || v === '') return NEUTRAL;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NEUTRAL;
}

/** 安全读 JSON：不存在/坏/无权限 → null。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────
 * 一、官方数据读取（只读，绝不写）
 * ────────────────────────────────────────────────────────────── */

/**
 * 官方数据根（`.qqbot`）。
 *
 * @param {string} qqbotDataRoot qqbot 数据根（如 `/…/Bot/dshqqbot`）
 * @returns {string}
 */
function officialDirOf(qqbotDataRoot) {
  const root = String(qqbotDataRoot ?? '').trim();
  return root ? join(root, '.qqbot') : '';
}

/** 进程内缓存（官方数据变化慢，60 秒足够；避免每轮读盘）。 */
const cache = new Map();
const CACHE_TTL_MS = 60_000;

/**
 * 带 TTL 的缓存读。
 *
 * @param {string} file
 * @param {number} now
 * @returns {object|null}
 */
function readCached(file, now = Date.now()) {
  if (!file) return null;
  const hit = cache.get(file);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  // 文件不存在时也缓存（避免每轮 statSync）
  const value = readJsonSafe(file);
  cache.set(file, { at: now, value });
  return value;
}

/** 清缓存（测试用）。 */
export function __clearOfficialCache() {
  cache.clear();
}

/**
 * 读官方好感度台账。
 *
 * 官方文件：`{dataRoot}/.qqbot/attitude.json`
 * 结构（实测）：`{ map: { "person:<openid>": { a, xp, level, levelName, events, lastDelta, ... } } }`
 *
 * @param {string} qqbotDataRoot
 * @param {number} [now]
 * @returns {object} `attitude.map`；失败返回 `{}`
 */
export function readOfficialAttitude(qqbotDataRoot, now = Date.now()) {
  const dir = officialDirOf(qqbotDataRoot);
  if (!dir) return {};
  const j = readCached(join(dir, 'attitude.json'), now);
  const map = j && typeof j === 'object' ? j.map : null;
  return map && typeof map === 'object' ? map : {};
}

/**
 * 读官方熟识度台账。
 *
 * 官方文件：`{dataRoot}/.qqbot/affinity.json`
 * 结构（实测）：`{ map: { "person:<openid>": { msgs, mentions, replies, reviews, strength, firstAt } } }`
 *
 * @param {string} qqbotDataRoot
 * @param {number} [now]
 * @returns {object} `affinity.map`；失败返回 `{}`
 */
export function readOfficialAffinity(qqbotDataRoot, now = Date.now()) {
  const dir = officialDirOf(qqbotDataRoot);
  if (!dir) return {};
  const j = readCached(join(dir, 'affinity.json'), now);
  const map = j && typeof j === 'object' ? j.map : null;
  return map && typeof map === 'object' ? map : {};
}

/**
 * 从某个 key 取一条官方条目（key 形如 `person:<openid>`）。
 *
 * @param {object} map readOfficialAttitude/Affinity 的返回
 * @param {string} openid
 * @returns {object|null}
 */
export function entryOf(map, openid) {
  const id = String(openid ?? '').trim();
  if (!id || !map || typeof map !== 'object') return null;
  const hit = map[`person:${id}`] ?? map[id];
  return hit && typeof hit === 'object' ? hit : null;
}

/* ──────────────────────────────────────────────────────────────
 * 二、映射：官方数据 → 我们的维度（只映射，不重算）
 * ────────────────────────────────────────────────────────────── */

/**
 * **官方公式的等价实现**（依据 `dist/features/attitude.js:122`）。
 *
 * ```ts
 * export function attitudeRange(f) { return 1 + 2 * Math.max(0, Math.min(1, f)); }
 * ```
 *
 * 含义：好感度范围随熟识度扩大 —— 陌生人 ±1，45 天熟人 ≈ ±2.5。
 *
 * ⚠️ **必须用这个公式归一化，不能硬编码「a / 3」** ——
 *   不同人的 A 值范围不同（取决于 F=熟识度），硬编码会在熟人身上失真。
 *
 * @param {number} f 熟识度 0~1
 * @returns {number} 范围上界（≥1）
 */
export function attitudeRange(f) {
  return 1 + 2 * Math.max(0, Math.min(1, Number(f) || 0));
}

/**
 * 官方分档的等价实现（依据 `dist/features/attitude.js:49`）。
 *
 * ratio = a / R(F)：
 *   ≥ 0.6 很亲近 / ≥ 0.2 亲近 / > −0.2 中立 / > −0.6 冷淡 / 其余 疏远
 *
 * @param {number} a 好感度 A 值
 * @param {number} f 熟识度 0~1
 * @returns {'很亲近'|'亲近'|'中立'|'冷淡'|'疏远'}
 */
export function attitudeTierOf(a, f) {
  const r = attitudeRange(f);
  const ratio = r > 0 ? Number(a) / r : 0;
  if (!Number.isFinite(ratio)) return '中立';
  if (ratio >= 0.6) return '很亲近';
  if (ratio >= 0.2) return '亲近';
  if (ratio > -0.2) return '中立';
  if (ratio > -0.6) return '冷淡';
  return '疏远';
}

/**
 * 官方好感度 + 熟识度 → **亲近度 `closeness`**（0~1，0.5 中性）。
 *
 * 算法（映射，非重算）：
 *   ① 熟识度 f = 官方 affinity.strength（0~1，官方现成值）
 *   ② 范围 R = 1 + 2f（官方公式）
 *   ③ 占比 ratio = a / R（−1 ~ +1）
 *   ④ closeness = (ratio + 1) / 2（线性映射到 0~1，0.5 = 中性）
 *
 * @param {object|null} attitudeEntry 官方 attitude 条目
 * @param {object|null} affinityEntry 官方 affinity 条目
 * @returns {number} 0~1；无数据 → 0.5
 */
export function closenessOf(attitudeEntry, affinityEntry) {
  const a = Number(attitudeEntry?.a);
  if (!Number.isFinite(a)) return NEUTRAL;
  const f = clamp01(affinityEntry?.strength ?? 0);
  const r = attitudeRange(f);
  const ratio = r > 0 ? a / r : 0;
  return clamp01((ratio + 1) / 2);
}

/**
 * 官方等级 + 熟识度 → **自信 `confidence`**（0~1）。
 *
 * 为什么用 level：官方 level 是「关系等级」（0~N，实测有 levelName 如「依赖」），
 * 等级越高说明互动越稳 ⇒ 她对这个人的表达越笃定（不犹豫）。
 *
 * 映射：level 归一化。实测最高见到 6 级，用 6 作为参考上限（超出按 1 处理）。
 *
 * @param {object|null} attitudeEntry
 * @returns {number} 0~1；无数据 → 0.5
 */
export function confidenceOf(attitudeEntry) {
  const lv = Number(attitudeEntry?.level);
  if (!Number.isFinite(lv) || lv < 0) return NEUTRAL;
  // 0 级 = 刚认识（中性偏下），6 级及以上 = 很笃定
  return clamp01(0.35 + (Math.min(lv, 6) / 6) * 0.55);
}

/**
 * 意向统计 → **耐心 `patience`**（0~1）。
 *
 * 数据来源（全部官方现成）：
 *   · `attitude.lastDelta` —— 上次事件增量，负值说明最近态度在变差
 *   · `attitude.events`   —— 事件总数，作为置信度（太少不判）
 *
 * 为什么不自己分类「亲近/拒绝」：官方 tendency kNN 已经做完分类，
 * 那笔数据落在 `four-source.jsonl`，属于异步落盘，同步读取成本高。
 * 本模块改用**官方 attitude 的增量方向**做代理信号 —— 简单、零额外 IO、
 * 且方向与「耐心」正相关（态度变差时通常伴随不耐烦）。
 *
 * @param {object|null} attitudeEntry
 * @returns {number} 0~1；无数据 → 0.5
 */
export function patienceOf(attitudeEntry) {
  const d = Number(attitudeEntry?.lastDelta);
  const events = Number(attitudeEntry?.events);
  if (!Number.isFinite(d)) return NEUTRAL;
  // 样本太少不判（< 20 条事件属冷启动）
  if (Number.isFinite(events) && events < 20) return NEUTRAL;
  // lastDelta 典型范围 ±0.15（实测 互动 +0.15 / 拒绝 −0.10）
  // 增量正 → 有耐心；负 → 不耐烦。放大 4 倍后钳制。
  return clamp01(NEUTRAL + d * 4);
}

/**
 * **派生专注 `focus`**（0~1，不落盘）。
 *
 * 为什么派生而不是独立采集：素材里「专注」关键词命中率实测 0/140，
 * 没有可靠独立信号。派生比硬编一个哑维诚实。
 *
 * 公式：`focus = energy × 0.6 + (1 − 忙度) × 0.4`
 *   · 精力是基础（累了一定不专注）
 *   · 忙度来自 life-stream（今日条数越多越忙）
 *
 * @param {{energy?:number}} axes 当前八维状态
 * @param {{todayLifeCount?:number}} [busy] 生活流信息
 * @returns {number} 0~1
 */
export function focusOf(axes, busy = {}) {
  const energy = clamp01(axes?.energy);
  const cnt = Number(busy?.todayLifeCount);
  // 今日 0~5 条 → 忙度 0~1（5 条以上都算很忙）；**无数据 = 未知 = 中性 0.5**
  const busyness = Number.isFinite(cnt) ? Math.max(0, Math.min(1, cnt / 5)) : 0.5;
  // ★ 2026-11-21 与 mood-axis.refreshDerived 保持同一公式（两处必须一致）：
  //   围绕中性值做加权偏移，否则中性态会算出 0.7 的虚假偏离。
  //   focus = 0.5 + (energy-0.5)*0.6 + (0.5-忙度)*0.4
  return clamp01(0.5 + (energy - 0.5) * 0.6 + (0.5 - busyness) * 0.4);
}

/* ──────────────────────────────────────────────────────────────
 * 三、一次取全：给驱动层用的便捷入口
 * ────────────────────────────────────────────────────────────── */

/**
 * 从官方数据算出关系层三维。
 *
 * @param {string} qqbotDataRoot
 * @param {string} openid 群友 openid（查表用）
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.todayLifeCount]
 * @param {number} [opts.energy] 当前精力（算 focus 用）
 * @returns {{closeness:number, patience:number, confidence:number, focus:number, tier:string, hasData:boolean}}
 */
export function readRelationLayer(qqbotDataRoot, openid, opts = {}) {
  const now = Number(opts.now) || Date.now();
  try {
    const attMap = readOfficialAttitude(qqbotDataRoot, now);
    const affMap = readOfficialAffinity(qqbotDataRoot, now);

    // ★ 2026-11-21 修（真 bug）：**openid 为空时按「最近互动的人」聚合**。
    //
    //   背景：outbound 扩展的 ctx 只有 target（群），**拿不到发言人 openid**
    //   （读官方 makeOutboundCtx 确认：字段只有 text/segments/kind/source/target/
    //    turnId/chunkIndex/isLastChunk/phase/sender/dataRoot/owners…，没有 user）。
    //   而官方 attitude.json 是按 `person:<openid>` 存的**全局人名表**（不含群信息）。
    //   ⇒ 不兜底的话关系层三维永远查不到人 = 永远 0.5（等于白算）。
    //   兜底策略：取 `lastAt` 最新的那条 —— 即「最近在跟她互动的人」，
    //   这正是当前这轮对话最合理的对象。
    let targetKey = String(openid ?? '').trim();
    if (!targetKey) {
      let bestAt = -1;
      for (const [k, v] of Object.entries(attMap)) {
        const at = Number(v?.lastAt) || 0;
        if (at > bestAt) { bestAt = at; targetKey = k.replace(/^person:/, ''); }
      }
    }

    const att = entryOf(attMap, targetKey);
    const aff = entryOf(affMap, targetKey);
    const hasData = Boolean(att || aff);
    return {
      closeness: closenessOf(att, aff),
      patience: patienceOf(att),
      confidence: confidenceOf(att),
      focus: focusOf({ energy: opts.energy }, { todayLifeCount: opts.todayLifeCount }),
      tier: attitudeTierOf(Number(att?.a) || 0, clamp01(aff?.strength ?? 0)),
      hasData,
    };
  } catch {
    // 任何异常 → 全部中性（调用方不用 try-catch）
    return {
      closeness: NEUTRAL, patience: NEUTRAL, confidence: NEUTRAL,
      focus: focusOf({ energy: opts.energy }, {}),
      tier: '中立', hasData: false,
    };
  }
}

export default {
  readOfficialAttitude,
  readOfficialAffinity,
  entryOf,
  attitudeRange,
  attitudeTierOf,
  closenessOf,
  confidenceOf,
  patienceOf,
  focusOf,
  readRelationLayer,
  __clearOfficialCache,
};
