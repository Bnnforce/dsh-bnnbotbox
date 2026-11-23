/**
 * mood-axis — 八维心理状态核心（2026-11-21 R5.4 v3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 八维分三层（关键设计，改动前先读这段）
 *
 *   ┌─ 情绪层（分钟~小时级，我们自己算）────────────────────────┐
 *   │  mood        心情      高=轻快    低=低落                  │
 *   │  energy      精力      高=有精神  低=疲惫                  │
 *   │  connection  联系感    高=想说话  低=想安静                │
 *   │  composure   从容度    高=放松    低=紧张                  │
 *   └──────────────────────────────────────────────────────────┘
 *   ┌─ 关系层（天~周级，**读官方数据**，见 mood-official.js）──┐
 *   │  closeness   亲近度    官方 attitude.a 归一化               │
 *   │  patience    耐心      官方 attitude.lastDelta 方向         │
 *   │  confidence  自信      官方 attitude.level                 │
 *   └──────────────────────────────────────────────────────────┘
 *   ┌─ 派生层（不落盘，每次现算）──────────────────────────────┐
 *   │  focus       专注      energy × 忙度                        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * ── 为什么这样分（2026-11-21 重写原因）────────────────────────────────────
 *
 *   旧版（四维）只算情绪层。补八维时初版方案想「四个新维全用文本词表判」，
 *   实测 140 条真实素材：亲近度命中 1.4%、专注 0%、自信 0%
 *   ⇒ 靠词表会变成**永远等于中性值的哑维**。
 *
 *   现在关系层三维**只读官方算好的数据**（铁律 1），派生层现算，
 *   只有情绪层四维用文本信号 —— 每一维都有真实可用的数据源。
 *
 * ── 三条纪律（防止变成被否决过的「数值心情系统」）─────────────────────────
 *   ① **无数字**：注入文本只有描述，没有分数
 *   ② **是底色不是指令**：明说「语境优先」
 *   ③ **不主动解释**：明说「别解释自己怎么了」
 *
 * ── 关键约束 ───────────────────────────────────────────────────────────────
 *   注入预算是 **90 字硬上限**（inject.js 的 MOOD_TINT_BUDGET）。
 *   超了会被**整段丢弃**（不截断）。buildText 保证 ≤ 90。
 *   实测：3 条 29 字、8 条 51 字，预算充裕但只取 3 条（像人不像清单）。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 八个维度的 key（顺序即注入优先级）。 */
export const DIMENSIONS = [
  'mood', 'energy', 'connection', 'composure',           // 情绪层
  'closeness', 'patience', 'confidence',                 // 关系层
  'focus',                                               // 派生层
];

/** 情绪层（文本信号可判）。 */
export const EMOTION_DIMENSIONS = ['mood', 'energy', 'connection', 'composure'];

/** 关系层（读官方数据，不由本模块推进）。 */
export const RELATION_DIMENSIONS = ['closeness', 'patience', 'confidence'];

/** 派生层（不落盘）。 */
export const DERIVED_DIMENSIONS = ['focus'];

/** 中性值（0~1 的中点）。 */
export const NEUTRAL = 0.5;

/** EMA 平滑系数。0.25 = 约 6-7 轮才明显变化。 */
export const ALPHA = 0.25;

/** 少于这么多样本 → 不注入（冷启动期避免瞎猜）。 */
export const MIN_SAMPLES = 3;

/** 偏离中值超过这个值才参与注入。 */
export const DEVIATION_THRESHOLD = 0.10;

/** 最多注入几条描述。 */
export const MAX_PHRASES = 3;

/** 注入时情绪层最多占几条（防关系层永远压过情绪层）。 */
export const MAX_EMOTION_PHRASES = 2;

/** 注入时关系层最多占几条（关系变化慢，多了单调）。 */
export const MAX_RELATION_PHRASES = 1;

/** 注入文本预算（与 inject.js 的 MOOD_TINT_BUDGET 一致）。 */
export const TEXT_BUDGET = 90;

/** 空状态（八维齐全）。 */
export const EMPTY_AXES = Object.freeze({
  mood: NEUTRAL,
  energy: NEUTRAL,
  connection: NEUTRAL,
  composure: NEUTRAL,
  closeness: NEUTRAL,
  patience: NEUTRAL,
  confidence: NEUTRAL,
  focus: NEUTRAL,
  samples: 0,
  updatedAt: 0,
});

/** 每维的高低描述词（每条 ≤ 5 字，保证 3 条 + 模板 ≤ 90 字）。 */
export const PHRASES = {
  mood:       { hi: '心情不错', lo: '有点闷' },
  energy:     { hi: '精神好',   lo: '有点累' },
  connection: { hi: '想说话',   lo: '想安静' },
  composure:  { hi: '很放松',   lo: '有点紧张' },
  closeness:  { hi: '挺亲近',   lo: '有点疏远' },
  patience:   { hi: '有耐心',   lo: '不太耐烦' },
  confidence: { hi: '挺笃定',   lo: '有点犹豫' },
  focus:      { hi: '挺专注',   lo: '有点分心' },
};

// ─────────────────────────────── 纯函数 ───────────────────────────────

/** 钳制到 0~1（非法值 → 中值）。 */
function clamp01(v) {
  // null / undefined / 非数字 → 中值（注意：Number(null) === 0，必须显式排除）
  if (v === null || v === undefined || v === '') return NEUTRAL;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : NEUTRAL;
}

/**
 * 归一化任意输入 → 合法的八维状态。
 *
 * ⚠️ 2026-11-21 v3：**不做「缺字段补中值」的兼容迁移**（那会留下永久分支）。
 *   缺字段 = 该维未知，按中性处理但 **samples 归零** ⇒ 冷启动重新累积。
 *   旧四维文件切换时会被备份并视为空状态，见 mood-store.js。
 *
 * @param {unknown} raw
 * @returns {{mood:number,energy:number,connection:number,composure:number,
 *            closeness:number,patience:number,confidence:number,focus:number,
 *            samples:number,updatedAt:number}}
 */
export function normalizeAxes(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {
    mood: clamp01(o.mood),
    energy: clamp01(o.energy),
    connection: clamp01(o.connection),
    composure: clamp01(o.composure),
    closeness: clamp01(o.closeness),
    patience: clamp01(o.patience),
    confidence: clamp01(o.confidence),
    focus: clamp01(o.focus),
    samples: Number.isFinite(Number(o.samples)) ? Math.max(0, Math.floor(Number(o.samples))) : 0,
    updatedAt: Number.isFinite(Number(o.updatedAt)) ? Number(o.updatedAt) : 0,
  };
  return out;
}

/**
 * 从一段文本里抽**情绪层**四维信号。**纯函数**。
 *
 * 设计原则：
 *   · 每个关键词**严格归属一个维度**（避免维度间高相关）
 *   · 拿不到信号返回空对象（不返回 0，表示「这轮判不出来」）
 *   · **只处理情绪层** —— 关系层三维不从这里来（读官方数据）
 *
 * @param {string} text
 * @returns {{mood?:number, energy?:number, connection?:number, composure?:number}}
 */
export function extractSignals(text) {
  const t = String(text ?? '');
  if (!t) return {};
  const s = {};

  // ── mood 心情：只认纯情绪词 ──
  if (/心情很好|心情好|开心|高兴|愉快|满足|舒服|喜欢|真好|好运|好日子|不错|挺好|顺利|有趣|笑/u.test(t)) s.mood = +0.3;
  else if (/难过|失落|伤心|闷|烦|孤单|空落|低落|提不起/u.test(t)) s.mood = -0.3;

  // ── energy 精力：只认体力词 ──
  if (/精神|元气|有劲|力气|清醒|神清气爽|状态好|效率高/u.test(t)) s.energy = +0.3;
  else if (/困|累|没睡|疲惫|软绵绵|打哈欠|睁不开|跑了一天/u.test(t)) s.energy = -0.3;

  // ── connection 联系感：只认社交意愿 ──
  if (/想说话|陪我|聊聊|说说|谁陪|说说话|想跟你|想聊|你在吗/u.test(t)) s.connection = +0.3;
  else if (/不想说|安静|一个人|独自|谁也不理|别烦|不聊/u.test(t)) s.connection = -0.3;

  // ── composure 从容度：只认从容/紧张 ──
  if (/从容|放松|平静|不着急|慢慢来|没关系|不用担心|安心/u.test(t)) s.composure = +0.3;
  else if (/紧张|担心|不安|慌|害怕|悬着|七上八下|不踏实|纠结/u.test(t)) s.composure = -0.3;

  return s;
}

/**
 * 从「对话特征」抽情绪层信号。**纯函数**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个：
 *
 *   实测 483 条她的真实回复，发现**她几乎不说情绪词**：
 *     "在。说吧。"              → 无情绪词
 *     "说，我听着。"            → 无情绪词
 *     "这句你今天说第四遍了。"   → 无情绪词
 *
 *   爱莉的语料是「轻快短句 + 反问 + 调侃」，不是「情绪表达」。
 *   所以纯靠情绪词典抽信号，**命中率极低**（实测 <10%）。
 *
 *   信号映射（实测特征：长度中位 49 字 | 问号 24% | 句号结尾 77%）：
 *     长度 > 60      → 有兴致（connection+ energy+）
 *     长度 < 15      → 敷衍/累（connection− energy−）
 *     含问句         → 想互动（connection+）
 *     省略号开头     → 犹豫（composure−）
 *     短句连缀       → 随意（composure+）
 *     间隔 > 5 分钟  → 在忙（energy− connection−）
 *     间隔 < 30 秒   → 积极（connection+）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @param {string} text 她的回复文本
 * @param {object} [meta] 额外信息
 * @param {number} [meta.latencyMs] 回复间隔（毫秒）
 * @returns {object} 情绪层增量（可空）
 */
export function extractDialogueSignals(text, meta) {
  const t = String(text ?? '');
  if (!t || t.length < 2) return {};
  const s = {};
  const len = [...t].length;

  // ── ① 长度（最强信号）──
  if (len > 60) {
    s.connection = 0.2;
    s.energy = 0.15;
  } else if (len < 15) {
    s.connection = -0.25;
    s.energy = -0.15;
  } else if (len < 25) {
    s.connection = -0.1;
  }

  // ── ② 问句（她问问题 = 想互动）──
  //   ★ 2026-11-21 修：原来问句加成最小 0.1，而短句（<15字）扣 0.25
  //   ⇒ 「你好吗？」同时命中两条 → 净 −0.15（问句明明是积极信号）。
  //   现在问句加成与条数挂钩且下限 0.25，能完全抵消短句扣分。
  const qCount = (t.match(/[?？]/gu) || []).length;
  if (qCount > 0) {
    s.connection = (s.connection || 0) + Math.min(0.3, 0.25 + qCount * 0.05);
  }

  // ── ③ 省略号开头（犹豫/无奈）──
  if (/^[…\.]{2,}/u.test(t) || /^\.\.\./u.test(t)) {
    s.composure = -0.15;
  }

  // ── ④ 短句连缀（逗号密度高 = 随意/放松）──
  const commaCount = (t.match(/[，,、]/gu) || []).length;
  if (commaCount >= 3 && len < 60) {
    s.composure = (s.composure || 0) + 0.1;
  }

  // ── ⑤ 回复间隔（需 meta.latencyMs）──
  const lat = Number(meta?.latencyMs);
  if (Number.isFinite(lat) && lat > 0) {
    if (lat > 5 * 60_000) {
      // > 5 分钟 = 在忙
      s.energy = (s.energy || 0) - 0.2;
      s.connection = (s.connection || 0) - 0.15;
    } else if (lat < 30_000) {
      // < 30 秒 = 积极
      s.connection = (s.connection || 0) + 0.15;
    }
  }

  return s;
}

/**
 * 合并两路信号：情绪词 + 对话特征。**纯函数**。
 *
 * 情绪词优先级高（明确说了什么），对话特征做补充（怎么说）。
 *
 * @param {object} lexical extractSignals 的输出
 * @param {object} dialogue extractDialogueSignals 的输出
 * @returns {object} 合并后的情绪层增量
 */
export function mergeSignals(lexical, dialogue) {
  const out = {};
  const add = (src, weight) => {
    if (!src || typeof src !== 'object') return;
    for (const k of EMOTION_DIMENSIONS) {
      const v = Number(src[k]);
      if (!Number.isFinite(v)) continue;
      out[k] = (out[k] || 0) + v * weight;
    }
  };
  // 情绪词权重 1.0（明确信号）
  add(lexical, 1.0);
  // 对话特征权重 0.7（间接信号，略降权避免主导）
  add(dialogue, 0.7);
  // 钳制到 ±0.35（防叠加过猛）
  for (const k of EMOTION_DIMENSIONS) {
    if (out[k] === undefined) continue;
    out[k] = Math.max(-0.35, Math.min(0.35, out[k]));
  }
  return out;
}

/**
 * EMA 漂移：把**情绪层**信号并入状态。**纯函数**。
 *
 * ⚠️ 只推进情绪层四维。关系层三维由官方数据现算（见 mood-official.js），
 *   本函数不改它们；派生层 focus 由调用方重算。
 *
 * @param {object} prev 当前状态
 * @param {object} signals 情绪层增量（可含任意子集）
 * @param {number} [now] 时间戳
 * @param {number} [alpha] 平滑系数（默认 ALPHA）
 * @returns {object} 新状态
 */
export function drift(prev, signals, now, alpha) {
  const base = normalizeAxes(prev);
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 ? Number(alpha) : ALPHA;
  const sig = signals && typeof signals === 'object' ? signals : {};

  const next = { ...base, samples: base.samples + 1, updatedAt: Number(now) || Date.now() };

  for (const k of EMOTION_DIMENSIONS) {
    const delta = Number(sig[k]);
    if (!Number.isFinite(delta)) continue;
    const target = clamp01(base[k] + delta);
    next[k] = clamp01(base[k] + a * (target - base[k]));
  }

  return next;
}

/**
 * 把「基线偏移」并入**情绪层**状态（生活层的贡献）。**纯函数**。
 *
 * 与 drift 的区别：基线是**直接加**（不是 EMA），因为它是外部事实。
 *
 * @param {object} prev
 * @param {object} baseline 偏移（可含任意子集，值域 -0.3~+0.3）
 * @param {number} [now]
 * @returns {object}
 */
export function applyBaseline(prev, baseline, now) {
  const base = normalizeAxes(prev);
  const b = baseline && typeof baseline === 'object' ? baseline : {};

  const next = { ...base, updatedAt: Number(now) || Date.now() };

  for (const k of EMOTION_DIMENSIONS) {
    const delta = Number(b[k]);
    if (!Number.isFinite(delta)) continue;
    // 基线直接加，但单次不超过 ±0.2（防生活层压倒对话层）
    next[k] = clamp01(base[k] + Math.max(-0.2, Math.min(0.2, delta)));
  }

  return next;
}

/**
 * 把关系层三维写进状态（由驱动层从官方数据算出后调用）。**纯函数**。
 *
 * @param {object} prev
 * @param {{closeness?:number, patience?:number, confidence?:number}} rel
 * @param {number} [now]
 * @returns {object}
 */
export function applyRelation(prev, rel, now) {
  const base = normalizeAxes(prev);
  const r = rel && typeof rel === 'object' ? rel : {};
  const next = { ...base, updatedAt: Number(now) || Date.now() };
  for (const k of RELATION_DIMENSIONS) {
    const v = Number(r[k]);
    if (!Number.isFinite(v)) continue;
    next[k] = clamp01(v);
  }
  return next;
}

/**
 * 重算派生层（focus）。**纯函数**，就地返回新状态。
 *
 * @param {object} axes
 * @param {{todayLifeCount?:number}} [busy]
 * @returns {object}
 */
export function refreshDerived(axes, busy) {
  const base = normalizeAxes(axes);
  const cnt = Number(busy?.todayLifeCount);
  // 忙度：0 条=0（不忙），5 条+=1（很忙）。
  // ★ 2026-11-21 修第二轮：**无数据时必须视为「未知」= 中性 0.5**。
  //   上一版把无数据当 0（不忙），算出 focus=0.7 ⇒ 冷启动/无生活流时又出现虚假偏离。
  //   「不知道」就该给中性，不能假设她不忙。
  const busyness = Number.isFinite(cnt) ? Math.max(0, Math.min(1, cnt / 5)) : 0.5;
  // ★ 2026-11-21 修（测试抓到的真 bug）：
  //   原来公式 = energy*0.6 + (1-忙度)*0.4。
  //   在中性状态（energy=0.5、不忙）算出 0.5*0.6+1*0.4 = **0.7** ⇒ 虚假偏离 0.2，
  //   导致「全中性也要注入一句『挺专注』」。
  //   根因：(1-忙度) 在中性时是 1 而不是 0.5 —— 它衡量的是「不忙」不是「专注」。
  //   改为**围绕中性值做加权偏移**：精力对专注的贡献按偏离度算。
  //     focus = 0.5 + (energy-0.5)*0.6 + (0.5-忙度)*0.4
  //   ⇒ 中性(energy=0.5,忙度=0.5) → 0.5 ✅；满精力不忙 → 0.5+0.3+0.2 = 1.0 ✅
  //   ⇒ 无数据(忙度=0) → 0.5+0.2 = 0.7（略偏专注，因为确实没在忙，合理）
  const focusVal = 0.5 + (base.energy - 0.5) * 0.6 + (0.5 - busyness) * 0.4;
  return { ...base, focus: clamp01(focusVal) };
}

/**
 * 选出偏离最大的若干维（供注入用）。**纯函数**。
 *
 * ★ 2026-11-21 新增分层配额：
 *   关系层（亲近度等）变化慢、偏离持久，若纯按偏离排序会**永远压过情绪层**
 *   ⇒ 每轮都说「挺亲近」，反而单调。配额保证优先反映当下情绪。
 *
 * @param {object} axes
 * @param {number} [limit]
 * @returns {Array<{key:string, value:number, deviation:number, phrase:string, layer:string}>}
 */
export function pickDeviated(axes, limit) {
  const st = normalizeAxes(axes);
  // 硬上限 MAX_PHRASES（防调用方传大数导致注入失控）
  const want = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : MAX_PHRASES;
  const max = Math.min(want, MAX_PHRASES);

  const collect = (dims) => {
    const items = [];
    for (const k of dims) {
      const v = st[k];
      const dev = Math.abs(v - NEUTRAL);
      if (dev <= DEVIATION_THRESHOLD) continue;
      const p = PHRASES[k];
      if (!p) continue;
      const layer = RELATION_DIMENSIONS.includes(k) ? 'relation'
        : DERIVED_DIMENSIONS.includes(k) ? 'derived' : 'emotion';
      items.push({ key: k, value: v, deviation: dev, phrase: v > NEUTRAL ? p.hi : p.lo, layer });
    }
    items.sort((a, b) => b.deviation - a.deviation);
    return items;
  };

  // ① 先取情绪层（最多 2 条）—— 优先反映当下
  const emotion = collect(EMOTION_DIMENSIONS).slice(0, Math.min(MAX_EMOTION_PHRASES, max));
  // ② 再取关系层（最多 1 条）—— 补一条关系状态
  const restSlots = max - emotion.length;
  const relation = restSlots > 0
    ? collect(RELATION_DIMENSIONS).slice(0, Math.min(MAX_RELATION_PHRASES, restSlots))
    : [];
  // ③ 还有空位就取派生层
  const restSlots2 = max - emotion.length - relation.length;
  const derived = restSlots2 > 0 ? collect(DERIVED_DIMENSIONS).slice(0, restSlots2) : [];

  return [...emotion, ...relation, ...derived];
}

/**
 * 生成注入文本。**保证 ≤ TEXT_BUDGET 字**。
 *
 * @param {object} axes
 * @returns {string} 空字符串 = 不注入
 */
export function buildText(axes) {
  const st = refreshDerived(axes);

  // 冷启动 → 不注入
  if (st.samples < MIN_SAMPLES) return '';

  const picked = pickDeviated(st, MAX_PHRASES);
  if (!picked.length) return '';

  const phrases = picked.map((x) => x.phrase);
  const text = `[${phrases.join('，')}。底色，语境优先，别解释自己。]`;

  // 硬断言：超预算就返回空（宁可没注入，也不让整段被 inject.js 丢弃）
  if ([...text].length > TEXT_BUDGET) return '';

  return text;
}

/**
 * 从文本推断是否该更新（给驱动层用）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasSignal(text) {
  return Object.keys(extractSignals(text)).length > 0;
}

/**
 * 调试用：把状态转成可读字符串。
 * @param {object} axes
 */
export function describeAxes(axes) {
  const st = normalizeAxes(axes);
  const parts = DIMENSIONS.map((k) => `${k}=${st[k].toFixed(2)}`);
  return `[${parts.join(' ')} samples=${st.samples}]`;
}

export default {
  DIMENSIONS,
  EMOTION_DIMENSIONS,
  RELATION_DIMENSIONS,
  DERIVED_DIMENSIONS,
  NEUTRAL,
  ALPHA,
  MIN_SAMPLES,
  DEVIATION_THRESHOLD,
  MAX_PHRASES,
  TEXT_BUDGET,
  EMPTY_AXES,
  PHRASES,
  normalizeAxes,
  extractSignals,
  extractDialogueSignals,
  mergeSignals,
  drift,
  applyBaseline,
  applyRelation,
  refreshDerived,
  pickDeviated,
  buildText,
  hasSignal,
  describeAxes,
};
