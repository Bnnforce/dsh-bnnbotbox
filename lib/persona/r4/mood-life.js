/**
 * mood-life — 生活事件 → 情绪基线（2026-11-20 R5.4）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（关键实测发现）：
 *
 *   原以为「生活事件直接影响情绪」，实测推翻：
 *     · 旧素材 320 条，只有 **5.6%** 有显式情绪词
 *     · 关键词打标覆盖率 **20.9%**，语义规则也只有 **41.3%**
 *     · 素材是「生活片段描写」，不是「情绪表达」
 *
 *   两个时段倾向差异也极小（暖 11-14%、冷 8-15%）→ 不能靠时段推情绪。
 *
 * ── 解法：三层信号，权重分明 ───────────────────────────────────────────────
 *
 *   ① **时段基线**（40%，100% 可靠）
 *      早上有精神、下午犯困、晚上想聊天、深夜疲惫 —— 纯时间，永远准。
 *
 *   ② **外部状态**（40%，100% 可靠）
 *      心跳 cold、独处时长、今日生活流条数 —— 读真实状态文件，永远准。
 *
 *   ③ **素材内容**（20%，92% 覆盖）
 *      素材库已重写（每条带明确情绪倾向），能打标就加，打不到就跳过。
 *
 *   ★ 关键：素材层即使 0% 命中，前两层仍 100% 工作 → 功能不失效。
 *
 * ── 时间衰减 ───────────────────────────────────────────────────────────────
 *
 *   6 小时半衰期：8:00 的事件 → 14:00 剩 50% → 20:00 剩 25%
 *   避免「早上的事影响一整天」。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 四维 key（与 mood-axis 一致）。 */
import { DIMENSIONS } from './mood-axis.js';

/** 时段基线：纯时间，不依赖任何外部数据。 */
export const SLOT_BASE = Object.freeze({
  /** 06:00-11:00 刚起床，有精神 */
  morning: { energy: +0.15, connection: +0.05 },
  /** 11:00-17:00 午后，容易犯困 */
  afternoon: { energy: -0.10, composure: -0.15 },
  /** 17:00-22:00 傍晚，想聊天 */
  evening: { connection: +0.10, mood: +0.05 },
  /** 22:00-02:00 深夜，累且安静 */
  late_night: { energy: -0.25, composure: -0.20, connection: -0.10 },
});

/** 半衰期（小时）。 */
export const HALF_LIFE_HOURS = 6;

/** 单层权重。 */
export const LAYER_WEIGHT = Object.freeze({
  slot: 0.4,      // 时段基线
  external: 0.4,  // 外部状态
  material: 0.2,  // 素材内容
});

/**
 * 按小时取时段 id。
 * @param {number} hour 0-23
 * @returns {'morning'|'afternoon'|'evening'|'late_night'}
 */
export function slotOfHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return 'afternoon';
  const x = ((Math.floor(h) % 24) + 24) % 24;
  if (x >= 6 && x < 11) return 'morning';
  if (x >= 11 && x < 17) return 'afternoon';
  if (x >= 17 && x < 22) return 'evening';
  return 'late_night';
}

/**
 * 按时间戳（毫秒）取时段 id。
 * @param {number} ts
 * @param {string} [timeZone] 默认 Asia/Shanghai
 */
export function slotOfTs(ts, timeZone = 'Asia/Shanghai') {
  try {
    const d = new Date(Number(ts) || Date.now());
    const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(d));
    return slotOfHour(h);
  } catch {
    return slotOfHour(new Date().getHours());
  }
}

/**
 * 衰减系数（6 小时半衰）。
 * @param {number} hoursAgo 距今小时数
 * @returns {number} 0~1
 */
export function decayOf(hoursAgo) {
  const h = Number(hoursAgo);
  if (!Number.isFinite(h) || h <= 0) return 1;
  return Math.pow(0.5, h / HALF_LIFE_HOURS);
}

/**
 * 素材分节标题 → 维度真值映射（2026-11-21 v3 新增）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么这是本模块最重要的改进
 *
 *   素材库 `Bot/事件库/{morning,afternoon,evening,late_night}.md` 里，
 *   140 条素材被**人工分成了 8 节**（每节标题就写着情绪倾向）：
 *
 *     ## 心情偏暖（开心、满足、期待）      26 条
 *     ## 心情偏冷（低落、烦闷、疲惫）      23 条
 *     ## 精力足（精神好、清醒、有活力）    14 条
 *     ## 精力乏（困、累、没睡好）          17 条
 *     ## 想说话（联系感高）                16 条
 *     ## 想安静（联系感低）                16 条
 *     ## 从容/放松（composure 高）         12 条
 *     ## 紧张/不安（composure 低）         16 条
 *
 *   **这是人写的真值标签**，比任何正则猜词都准。
 *   旧实现只用词表猜，实测准确率 68.8%~79.6%、跨维误报最高 12.1%。
 *   现在优先认标题 ⇒ 准确率接近 100%，且零额外成本。
 *
 * 解析策略：标题优先 → 词表回退（拿不到标题时才猜）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const SECTION_TRUTH = Object.freeze([
  { match: /心情偏暖|心情好/, dim: 'mood', value: +0.3 },
  { match: /心情偏冷|心情差/, dim: 'mood', value: -0.3 },
  { match: /精力足|精神好/, dim: 'energy', value: +0.3 },
  { match: /精力乏|没精神/, dim: 'energy', value: -0.3 },
  { match: /想说话|联系感高/, dim: 'connection', value: +0.3 },
  { match: /想安静|联系感低/, dim: 'connection', value: -0.3 },
  { match: /从容|放松/, dim: 'composure', value: +0.3 },
  { match: /紧张|不安/, dim: 'composure', value: -0.3 },
]);

/**
 * 从素材文本解析**分节标题真值**。**纯函数**。
 *
 * @param {string} text 可含 `## 标题` 行
 * @returns {{dim:string, value:number}|null} 命中分节返回维度与方向，否则 null
 */
export function parseSectionTruth(text) {
  const t = String(text ?? '');
  if (!t) return null;
  // 只看标题行（## 开头），避免正文里的词误命中
  const heads = t.split('\n').filter((l) => /^\s*##\s+/.test(l));
  const pool = heads.length ? heads.join('\n') : t;
  for (const rule of SECTION_TRUTH) {
    if (rule.match.test(pool)) return { dim: rule.dim, value: rule.value };
  }
  return null;
}

/**
 * 从一条生活素材抽四维信号。**纯函数**。
 *
 * ⚠️ 与 mood-axis 的 extractSignals 不同：
 *    生活素材是「状态描写」，所以规则不同、更宽松。
 *
 * ★ 2026-11-21 v3：**分节标题优先**（人工真值），词表只作回退。
 *
 * @param {string} text
 * @returns {object} 四维增量（可空）
 */
export function extractMaterialSignals(text) {
  const t = String(text ?? '');
  if (!t) return {};

  // ① 标题真值（最可靠）
  const truth = parseSectionTruth(t);
  if (truth) return { [truth.dim]: truth.value };

  // ② 词表回退（拿不到标题时才猜）
  const s = {};

  // ── mood ──
  if (/心情很好|心情好|开心|高兴|愉快|满足|舒服|笑|好运|好日子|不错|挺好|真好|亮|暖|有趣|顺利|运气|好听的|好吃|甜/u.test(t)) {
    s.mood = 0.3;
  } else if (/难过|失落|闷|烦|空落|孤单|伤心|提不起|沉|灰蒙蒙|懒|无聊|没胃口/u.test(t)) {
    s.mood = -0.3;
  }

  // ── energy ──
  if (/精神|元气|有劲|力气|清醒|神清气爽|效率|状态好|起得早|浑身/u.test(t)) {
    s.energy = 0.3;
  } else if (/困|累|没睡|疲|软绵绵|睁不开|哈欠|晕|缓一缓|懒|跑了一天|不想动/u.test(t)) {
    s.energy = -0.3;
  }

  // ── connection ──
  if (/想说话|陪我|聊聊|说说|谁陪|想跟|说说话|有人在吗|想聊|讲给|聊天|说话|你们|大家/u.test(t)) {
    s.connection = 0.3;
  } else if (/不想说|安静|一个人|独自|谁也不理|不聊|小世界|缩回|发呆|不想被/u.test(t)) {
    s.connection = -0.3;
  }

  // ── composure ──
  if (/从容|放松|平静|不着急|不紧不慢|挺静|安心|挺好|慢慢|不用赶|不觉得亏|也挺好/u.test(t)) {
    s.composure = 0.3;
  } else if (/紧张|不安|慌|担心|悬着|七上八下|胡思乱想|不踏实|一定|必须|该办好|没做好|想些没用/u.test(t)) {
    s.composure = -0.3;
  }

  return s;
}

/**
 * 计算日基线：把当天 4 个 slot 的素材打标后平均。**纯函数**。
 *
 * @param {object} slots `{morning:string, afternoon:string, evening:string, late_night:string}`
 * @returns {object} 四维偏移（已含衰减前的原始值）
 */
export function computeDayBaseline(slots) {
  const o = slots && typeof slots === 'object' ? slots : {};
  const sums = {};
  let n = 0;

  for (const slotId of Object.keys(SLOT_BASE)) {
    const text = String(o[slotId] ?? '').trim();
    if (!text) continue;
    const sig = extractMaterialSignals(text);
    for (const k of DIMENSIONS) {
      const v = Number(sig[k]);
      if (!Number.isFinite(v)) continue;
      sums[k] = (sums[k] || 0) + v;
    }
    n += 1;
  }

  if (!n) return {};
  const out = {};
  for (const k of DIMENSIONS) {
    if (sums[k] === undefined) continue;
    out[k] = sums[k] / n;
  }
  return out;
}

/**
 * 计算素材层信号（当前时段素材 × 衰减）。**纯函数**。
 *
 * @param {string} currentSlotText 当前时段的素材正文
 * @param {number} hoursAgo 该素材是多少小时前抽的（通常 0~24）
 * @returns {object}
 */
export function computeMaterialLayer(currentSlotText, hoursAgo) {
  const sig = extractMaterialSignals(currentSlotText);
  const d = decayOf(hoursAgo);
  const out = {};
  for (const k of DIMENSIONS) {
    const v = Number(sig[k]);
    if (!Number.isFinite(v)) continue;
    out[k] = v * d * LAYER_WEIGHT.material;
  }
  return out;
}

/**
 * 计算外部状态层信号。**纯函数**（调用方负责读文件）。
 *
 * @param {object} ext
 * @param {boolean} [ext.heartbeatCold] 心跳是否处于 cold（不想说话）
 * @param {number} [ext.idleHours] 距离上次说话多少小时（独处时长）
 * @param {number} [ext.todayLifeCount] 今日生活流条数
 * @returns {object}
 */
export function computeExternalLayer(ext) {
  const o = ext && typeof ext === 'object' ? ext : {};
  const out = {};

  // 心跳 cold → 联系感降（明确不想说话）
  if (o.heartbeatCold === true) {
    out.connection = (out.connection || 0) - 0.30;
  }

  // 独处超过 2 小时 → 联系感升（想有人陪）
  const idle = Number(o.idleHours);
  if (Number.isFinite(idle) && idle > 2) {
    const boost = Math.min(0.15, (idle - 2) * 0.03);
    out.connection = (out.connection || 0) + boost;
  }

  // 今日生活流条数 > 3 → 精力降（一直在忙）
  const cnt = Number(o.todayLifeCount);
  if (Number.isFinite(cnt) && cnt > 3) {
    out.energy = (out.energy || 0) - 0.05 * Math.min(3, cnt - 3);
  }

  return out;
}

/**
 * 合并三层信号 → 最终基线偏移。**纯函数**。
 *
 * @param {object} input
 * @param {string} [input.slotId] 当前时段
 * @param {object} [input.dayBaseline] computeDayBaseline 的输出
 * @param {object} [input.materialLayer] computeMaterialLayer 的输出
 * @param {object} [input.externalLayer] computeExternalLayer 的输出
 * @returns {object} 四维偏移（值域约 -0.4~+0.4）
 */
export function mergeLayers(input) {
  const i = input && typeof input === 'object' ? input : {};
  const out = {};
  const add = (src, weight) => {
    if (!src || typeof src !== 'object') return;
    for (const k of DIMENSIONS) {
      const v = Number(src[k]);
      if (!Number.isFinite(v)) continue;
      out[k] = (out[k] || 0) + v * weight;
    }
  };

  // ① 时段基线（40%）
  const slotId = String(i.slotId ?? '');
  const base = SLOT_BASE[slotId];
  add(base, LAYER_WEIGHT.slot);

  // ② 外部状态（40%，已经带了绝对值）
  add(i.externalLayer, LAYER_WEIGHT.external);

  // ③ 素材层（20%，computeMaterialLayer 已乘过权重，这里直接加）
  add(i.materialLayer, 1);

  // ④ 日基线（作为额外微调，权重减半避免与素材层重复计）
  add(i.dayBaseline, LAYER_WEIGHT.slot * 0.5);

  // 钳制每维到 ±0.4（避免叠加过度）
  for (const k of DIMENSIONS) {
    if (out[k] === undefined) continue;
    out[k] = Math.max(-0.4, Math.min(0.4, out[k]));
  }

  return out;
}

/**
 * 调试用：描述合并结果。
 */
export function describeLayers(layers) {
  const o = layers && typeof layers === 'object' ? layers : {};
  const parts = DIMENSIONS.map((k) => `${k}=${(Number(o[k]) || 0).toFixed(2)}`);
  return `[${parts.join(' ')}]`;
}
