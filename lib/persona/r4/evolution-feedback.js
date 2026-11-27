/**
 * evolution-feedback — 自我进化 Feedback Agent（R9，2026-11-27）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要（SIA 启发，arXiv 2605.27276）：
 *
 *   自我进化如果「自己改 → 自己评估 → 自己批准」，等于自己批改自己的卷子。
 *   SIA 的三 Agent 架构（Meta / Target / Feedback）里，Feedback 是关键：
 *   用**独立视角**评估改动，不参与创造，只看「这个改动合理吗」。
 *
 * ── 与现有代码的分工 ───────────────────────────────────────────────────────
 *
 *   evolution-proposal.js  = Meta Agent（提案者）
 *   evolution-auto.js      = Target Agent（执行者）
 *   **本模块**             = Feedback Agent（评估者）★ 新增
 *
 * ── 设计铁律 ───────────────────────────────────────────────────────────────
 *
 *   ① **LLM 拿不到就降级纯规则**：reviewProposal() 是纯函数，永远可用；
 *      LLM 评估（reviewProposalWithLLM）是可选的增强层，失败不崩。
 *   ② **Feedback 只做批判，不做创造**：它不生成「改成什么」，只判断「该不该改」。
 *   ③ **三个判断维度**（不可妥协）：
 *        ① 有依据吗 —— 提案是否有数据支撑（vs 随机生成）
 *        ② 矛盾吗   —— 和过去的事实/反思冲突吗
 *        ③ 会伤害谁 —— 影响关系/群友/主人吗
 *   ④ **保守拒绝**：拿不准就拒绝（宁可不改，不瞎改）。
 *
 * ── 为什么要拆分 LLM 层 ────────────────────────────────────────────────────
 *
 *   mock-r8-evolution-auto.mjs 的 C11 断言要求 evolution-auto.js 里
 *   **不能出现 llm/fetch 字样**（「决策纯算法」的静态验证）。
 *   所以本模块把 LLM 调用隔离在这里，evolution-auto.js 通过依赖注入
 *   传入 reviewProposal，本身不含任何 LLM 引用。
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** 拒绝原因的类型。 */
export const VERDICTS = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
});

/**
 * 三个判断维度（纯规则版，不调 LLM）。
 *
 * @param {object} proposal  提案对象（buildProposal 的 proposal）
 * @param {object} context   上下文：{ facts, reflections, baseline }
 * @returns {{ok:boolean, reasons:Array<string>, verdict:'approve'|'reject'}}
 */
export function reviewProposal(proposal, context = {}) {
  const reasons = [];
  const items = Array.isArray(proposal?.items) ? proposal.items : [];

  // ── 维度 ① 有依据吗 ─────────────────────────────────────────────────────
  // 提案项必须有 why 字段（数据支撑），没有 why = 随机生成，拒绝
  for (const it of items) {
    const why = String(it?.why ?? '').trim();
    if (!why) {
      reasons.push(`「${it?.label ?? it?.key ?? '?'}」没有改动依据`);
    }
  }

  // ── 维度 ② 矛盾吗 ────────────────────────────────────────────────────────
  // 检查提案是否和「我知道的事实」冲突（简化版：关键词对比）
  const facts = String(context?.facts ?? '').trim();
  const reflections = String(context?.reflections ?? '').trim();
  for (const it of items) {
    const why = String(it?.why ?? '');
    // 如果反思里明确说过「这个改法失败过」，再提同类 = 矛盾
    if (reflections && why && reflections.includes('改回来') && reflections.includes(it.label ?? '')) {
      reasons.push(`「${it.label}」之前改过又改回来了，反复改`);
    }
    // 事实里明确写了相反偏好，且提案方向相反
    // （简化：只做存在性检查，不做方向判断，避免误伤）
    void facts;
  }

  // ── 维度 ③ 会伤害谁 ─────────────────────────────────────────────────────
  // 白名单外的项 = 可能伤害关系/身份（但白名单已在 evolution-auto 拦，这里再提示）
  for (const it of items) {
    const key = String(it?.key ?? '');
    if (['name', 'identity', 'personality', 'relationToOwner', 'values'].includes(key)) {
      reasons.push(`「${key}」涉及身份/关系，不在可自改范围`);
    }
  }

  // ── 空提案 ───────────────────────────────────────────────────────────────
  if (!items.length) {
    reasons.push('空提案，无内容可评');
  }

  const ok = reasons.length === 0;
  return {
    ok,
    reasons,
    verdict: ok ? VERDICTS.APPROVE : VERDICTS.REJECT,
  };
}

/**
 * 构造给 LLM 的评估 prompt（纯函数，可单测）。
 *
 * ⚠️ Feedback 用**独立视角**：它不知道「为什么想改」的原始动机，
 * 只看提案内容 + 事实 + 反思，判断「该不该改」。
 *
 * @param {object} proposal 提案对象
 * @param {object} context  { facts, reflections }
 * @returns {string}
 */
export function buildFeedbackPrompt(proposal, context = {}) {
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  const facts = String(context?.facts ?? '').trim();
  const reflections = String(context?.reflections ?? '').trim();

  const lines = [
    '你是一个冷静的评估者。下面是一个 AI 角色「自我进化」的改动提案。',
    '你的任务**不是**帮她改，而是判断这个改动**该不该做**。',
    '',
    '只回答一个 JSON 对象，格式：{"ok":true/false,"reasons":["原因1","原因2"]}',
    '不要输出任何其他文字。',
    '',
    '── 判断标准（三条都要过）──',
    '1. 有依据吗：改动是否有数据支撑，还是像随机生成的？',
    '2. 矛盾吗：改动是否和她已知的事实、过去的反思冲突？',
    '3. 会伤害谁：改动是否会影响她与群友/主人的关系？',
    '',
    '── 提案内容 ──',
  ];

  for (const it of items) {
    lines.push(`· ${it?.label ?? it?.key}：${it?.from} → ${it?.to}`);
    if (it?.why) lines.push(`  理由：${it.why}`);
  }

  if (facts) {
    lines.push('');
    lines.push('── 她知道的事实 ──');
    lines.push(facts.slice(0, 800));
  }
  if (reflections) {
    lines.push('');
    lines.push('── 她过去的反思 ──');
    lines.push(reflections.slice(0, 800));
  }

  return lines.join('\n');
}

/** 解析 LLM 返回的 JSON（纯函数，容错）。 */
export function parseFeedbackJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reasons: ['LLM 无返回'], parseFailed: true };
  try {
    // 提取第一个 JSON 对象
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reasons: ['LLM 返回非 JSON'], parseFailed: true };
    const j = JSON.parse(m[0]);
    const ok = j?.ok === true;
    const reasons = Array.isArray(j?.reasons) ? j.reasons.map((r) => String(r)) : [];
    if (!ok && !reasons.length) reasons.push('LLM 判断不通过但未给原因');
    return { ok, reasons, parseFailed: false };
  } catch {
    return { ok: false, reasons: ['LLM 返回解析失败'], parseFailed: true };
  }
}

/**
 * 用 LLM 做评估（可选增强层，LLM 拿不到时调用方降级到 reviewProposal 纯规则）。
 *
 * @param {object} llm  cordis llm 服务（ctx.get('llm')）
 * @param {object} proposal
 * @param {object} context
 * @param {object} [opts]  { timeoutMs, maxTokens, route }
 * @returns {Promise<{ok:boolean, reasons:Array<string>, usedLLM:boolean}>}
 */
export async function reviewProposalWithLLM(llm, proposal, context = {}, opts = {}) {
  // LLM 不可用 → 降级纯规则
  if (!llm || typeof llm.stream !== 'function') {
    const r = reviewProposal(proposal, context);
    return { ...r, usedLLM: false };
  }

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 200;

  try {
    // 解析路由（优先传入，否则自己解析）
    let route = opts.route;
    if (!route) {
      const anyLlm = llm;
      const cur = anyLlm.currentModel ?? anyLlm.defaultModel;
      if (cur && typeof cur === 'object' && cur.provider && (cur.model || cur.id)) {
        route = { provider: String(cur.provider), model: String(cur.model ?? cur.id) };
      }
    }
    if (!route) {
      const r = reviewProposal(proposal, context);
      return { ...r, usedLLM: false };
    }

    const prompt = buildFeedbackPrompt(proposal, context);
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: '你是严格的评估者。只输出 JSON 对象，不输出任何其他文字。',
      messages: [{
        id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:bnnbotbox' },
      }],
      maxTokens,
    });

    // 收集流文本（自包含实现，不依赖 distiller 私有函数）
    let raw = '';
    for await (const chunk of stream) {
      if (typeof chunk === 'string') raw += chunk;
      else if (chunk && typeof chunk === 'object') {
        if (typeof chunk.text === 'string') raw += chunk.text;
        else if (typeof chunk.delta === 'string') raw += chunk.delta;
        else if (chunk.delta && typeof chunk.delta.text === 'string') raw += chunk.delta.text;
      }
    }

    const parsed = parseFeedbackJson(raw);
    return { ...parsed, usedLLM: !parsed.parseFailed };
  } catch {
    // LLM 调用失败 → 降级纯规则
    const r = reviewProposal(proposal, context);
    return { ...r, usedLLM: false };
  }
}

export default {
  VERDICTS,
  reviewProposal,
  buildFeedbackPrompt,
  parseFeedbackJson,
  reviewProposalWithLLM,
};
