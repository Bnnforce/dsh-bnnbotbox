/**
 * mood-self-report — 状态自述（极端状态强化）（R8 S8 任务 1，2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 先读这段：为什么不重写注入
 *
 *   任务要求「把八维数值转成一句人话，只在显著偏离基线时注入」。
 *   实测发现 **mood-axis.js 的 buildText() 已经完整实现了这件事**：
 *     · DEVIATION_THRESHOLD = 0.10（偏离中值才参与）
 *     · MAX_PHRASES = 3 + 分层配额（情绪 2 + 关系 1）
 *     · PHRASES 八维措辞表（心情不错/有点累/想安静…）
 *     · TEXT_BUDGET = 90 硬约束，超了返回空
 *     · samples < 3 冷启动不注入
 *   实测：mood=0.35 就能注入「[有点闷。底色，语境优先，别解释自己。]」
 *
 *   ⇒ 再写一个 buildText 就是**重复造轮子**，还会产生两套措辞打架。
 *
 * ── 本模块补的是现有实现缺的那一块 ────────────────────────────────────────
 *
 *   现有 buildText 用「偏离中值 0.10」判断，**对所有偏离一视同仁**。
 *   但状态有轻重：mood=0.45 和 mood=0.08 都算「偏离」，前者轻轻带过即可，
 *   后者她真的很难受 —— 这两种情况不该用同样强度的自述。
 *
 *   所以本模块提供「**极端状态判定 + 强化措辞**」：
 *     · 正常偏离 → 交给 buildText（原样，不动）
 *     · 极端偏离 → 返回强化提示，可与 buildText 叠加
 *
 *   这是**增量增强**，不替换原有链路，原有行为完全不变。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 极端状态阈值（任务明确要求的绝对阈值）。 */
export const EXTREME = Object.freeze({
  moodLow: 0.3,       // 心情低于此值 = 明显低落
  moodHigh: 0.75,     // 心情高于此值 = 明显高兴
  energyLow: 0.25,    // 精力低于此值 = 明显疲惫
  energyHigh: 0.8,    // 精力高于此值 = 精神很好
  connectionLow: 0.2, // 联系感低于此值 = 想独处
  composureLow: 0.2,  // 从容度低于此值 = 紧绷
});

/** 极端状态的强化措辞。 */
export const EXTREME_PHRASES = Object.freeze({
  moodLow: '心情低',
  moodHigh: '心情很好',
  energyLow: '很累',
  energyHigh: '精神很好',
  connectionLow: '不太想说话',
  composureLow: '有点紧绷',
});

/**
 * 各维度的「原措辞」（与 mood-axis.js 的 PHRASES 保持一致）。
 *
 * ★ 用于跨措辞去重：base 说「有点紧张」，强化说「有点紧绷」，
 *   字面不同但都是 composure 维，不该说两遍。
 *
 * ⚠️ 若 mood-axis.js 改了措辞，这里要同步（有测试断言兜底）。
 */
export const DIM_PHRASES = Object.freeze({
  mood: { hi: '心情不错', lo: '有点闷' },
  energy: { hi: '精神好', lo: '有点累' },
  connection: { hi: '想说话', lo: '想安静' },
  composure: { hi: '很放松', lo: '有点紧张' },
});

/** 需要几条样本才敢判定（防冷启动误判）。 */
export const MIN_SAMPLES = 3;

/**
 * 判断是否有极端状态（纯函数）。
 *
 * @param {object} axes 八维状态
 * @returns {{extreme:boolean, hits:Array<{key:string, value:number, phrase:string}>, text:string}}
 */
export function detectExtreme(axes) {
  const a = axes && typeof axes === 'object' ? axes : {};
  const samples = Number(a.samples) || 0;

  // 冷启动 → 不判定（数据不足时的判断不可信）
  if (samples < MIN_SAMPLES) {
    return { extreme: false, hits: [], text: '' };
  }

  const hits = [];
  const num = (k) => (Number.isFinite(Number(a[k])) ? Number(a[k]) : 0.5);

  // 按「严重程度」排序后取前 2（避免一次说太多）
  const checks = [
    { key: 'moodLow', dim: 'mood', test: (v) => v < EXTREME.moodLow, severity: (v) => EXTREME.moodLow - v },
    { key: 'energyLow', dim: 'energy', test: (v) => v < EXTREME.energyLow, severity: (v) => EXTREME.energyLow - v },
    { key: 'composureLow', dim: 'composure', test: (v) => v < EXTREME.composureLow, severity: (v) => EXTREME.composureLow - v },
    { key: 'connectionLow', dim: 'connection', test: (v) => v < EXTREME.connectionLow, severity: (v) => EXTREME.connectionLow - v },
    { key: 'moodHigh', dim: 'mood', test: (v) => v > EXTREME.moodHigh, severity: (v) => v - EXTREME.moodHigh },
    { key: 'energyHigh', dim: 'energy', test: (v) => v > EXTREME.energyHigh, severity: (v) => v - EXTREME.energyHigh },
  ];

  for (const c of checks) {
    const v = num(c.dim);
    if (!c.test(v)) continue;
    hits.push({ key: c.key, dim: c.dim, value: v, phrase: EXTREME_PHRASES[c.key], severity: c.severity(v) });
  }

  if (!hits.length) return { extreme: false, hits: [], text: '' };

  hits.sort((x, y) => y.severity - x.severity);
  const top = hits.slice(0, 2);

  return {
    extreme: true,
    hits: top,
    text: buildExtremeText(top),
  };
}

/**
 * 按极端类型生成措辞（正向/负向分开）。
 *
 * ★ 2026-11-26 修：第一版统一说「可以少说点」，
 *   但 mood=0.8（心情很好）时说「少说点」是错的 —— 该多说才对。
 */
function buildExtremeText(hits) {
  const phrases = hits.map((h) => h.phrase).join('，');
  const positive = hits.every((h) => String(h.key).endsWith('High'));
  const tail = positive ? '，可以多说两句' : '，可以少说点或说慢点';
  return `（你此刻${phrases}${tail}）`;
}

/**
 * 生成自述文本（纯函数）。
 *
 * 与 buildText 的关系：**互补，不替换**
 *   · 无极端 → 返回空串（让 buildText 的原生措辞生效）
 *   · 有极端 → 返回强化提示（可叠加在 buildText 之后）
 *
 * @param {object} axes
 * @returns {string}
 */
export function renderSelfReport(axes) {
  const r = detectExtreme(axes);
  return r.extreme ? r.text : '';
}

/**
 * 组合：极端强化 + 原有 buildText 的结果（纯函数）。
 *
 * ★ 2026-11-26 修（实测发现）：
 *   第一版直接拼接，结果 base 说「有点紧张，想安静」，
 *   强化又说「有点紧绷」，同一件事说了两遍，读起来啰嗦。
 *
 *   现在做**语义去重**：如果 base 已经表达了某个维度，
 *   强化里就跳过它；全都被覆盖了就只返回 base。
 *
 * @param {object} axes
 * @param {string} baseText buildText 的返回值
 * @param {{budget?:number}} [opts]
 * @returns {string}
 */
export function composeTint(axes, baseText, opts = {}) {
  const budget = Number(opts.budget) > 0 ? Number(opts.budget) : 90;
  const base = String(baseText ?? '').trim();
  const r = detectExtreme(axes);

  if (!r.extreme) return base;

  // 语义去重：base 里已有的维度不再重复说
  //
  // ★ 2026-11-26：不能只做字符串匹配。
  //   base 说「有点紧张」（composure 维），强化说「有点紧绷」（同一个 composure 维），
  //   字面不同但语义重复。所以按**维度**去重，而不是按措辞。
  const fresh = r.hits.filter((h) => {
    // ① 措辞已出现 → 跳过
    if (base.includes(h.phrase)) return false;
    // ② 该维度的原措辞已在 base 里 → 跳过（跨措辞去重）
    const dimPhrase = DIM_PHRASES[h.dim];
    if (dimPhrase && (base.includes(dimPhrase.hi) || base.includes(dimPhrase.lo))) return false;
    return true;
  });
  if (!fresh.length) return base;   // 全被覆盖 → 只用 base

  const extra = `（你此刻${fresh.map((h) => h.phrase).join('，')}）`;
  if (!base) return [...extra].length <= budget ? extra : '';

  const merged = `${base}${extra}`;
  // 超预算 → 保留原文（宁可不要强化，也不让整段被丢弃）
  return [...merged].length <= budget ? merged : base;
}

export default {
  EXTREME, EXTREME_PHRASES, MIN_SAMPLES,
  detectExtreme, renderSelfReport, composeTint,
};
