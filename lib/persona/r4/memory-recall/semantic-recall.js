/**
 * semantic-recall — 语义召回编排（把索引结果拼成注入文本）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 定位
 *
 *   `semantic-index.js`  管索引（建库/写入/查询）
 *   `decay.js`           管衰退（只作用事件层）
 *   **本文件**           管"从索引查到东西 → 拼成一句能注入的记忆"
 *
 * ── 输出契约（**绝不能改**）───────────────────────────────────────────────
 *
 *   必须与旧实现 `memory-recall/index.js` 的 `buildMemoryRecall()` 完全一致：
 *
 *     { text: string, used: number, present: { person: bool, group: bool, events: number } }
 *
 *   因为调用方 `memory-recall-host.js:158` 直接用它，改了就要连着改调用方。
 *   保持契约有两层好处：
 *     ① 接线只改 1 处
 *     ② 回滚只需关配置，新旧实现对调用方完全透明
 *
 * ── 设计原则（照抄旧实现的价值观）─────────────────────────────────────────
 *
 *   · **永不抛错**：任何异常都返回空结果，绝不影响主链
 *   · **字符预算**：budgetChars 是硬上限，超了就截断
 *   · **可观测**：每次召回都报 diag（哪几条、为什么选中）
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { openIndex, put, search, count, TIER } from './semantic-index.js';
import { runDecay, buildReport } from './decay.js';

/** 与旧实现保持一致的默认值（字段名也必须一致）。 */
export const SEMANTIC_DEFAULTS = Object.freeze({
  enabled: true,
  topK: 5,
  budgetChars: 280,
  /** 时间衰减常数：30 天。 */
  tauMs: 30 * 24 * 60 * 60 * 1000,
  /** 是否启用衰退。 */
  decayEnabled: true,
});

/** 空结果（与旧实现同形）。 */
function empty() {
  return { text: '', used: 0, present: { person: false, group: false, events: 0 } };
}

/**
 * 从 memory service 把某个 scope 的事件扫进索引。
 *
 * ⚠️ 只扫 events/（见 decay.js 头部：人物卡/群卡不参与衰退，索引也不该混进来）。
 *    但**人物/群卡的存在性**要记在 present 里，所以单独探测。
 *
 * @param {object} idx
 * @param {object} service  memory service（有 list/read）
 * @param {string} scope
 * @param {object} [opts]
 * @returns {{ indexed: number, people: boolean, group: boolean }}
 */
export function ingestScope(idx, service, scope, opts = {}) {
  const out = { indexed: 0, people: false, group: false };
  if (!service || typeof service.list !== 'function' || typeof service.read !== 'function') return out;

  const maxFiles = Math.max(1, Math.min(500, Number(opts.maxFiles) || 300));

  // ① 事件层 → 建索引
  try {
    const listed = service.list(scope, 'events');
    const files = listed?.ok && Array.isArray(listed.files) ? listed.files : [];
    for (const f of files.slice(0, maxFiles)) {
      const rel = typeof f === 'string' ? f : String(f?.path ?? f?.name ?? '');
      if (!rel || !/\.md$/i.test(rel)) continue;
      let body = '';
      try {
        const r = service.read(scope, `events/${rel}`.replace(/\/+/g, '/'));
        body = r?.ok ? String(r.text ?? r.body ?? '') : '';
      } catch { continue; }
      if (!body.trim()) continue;
      const stat = (() => { try { return service.stat?.(scope, `events/${rel}`) } catch { return undefined } })();
      const mentionedAt = Number(stat?.mtimeMs) || Date.now();
      const ok = put(idx, {
        id: `${scope}:event:${rel}`,
        scope,
        kind: 'event',
        body,
        mentionedAt,
        src: `events/${rel}`,
      });
      if (ok) out.indexed += 1;
    }
  } catch { /* 事件层失败不影响其它 */ }

  // ② 人物卡 / 群卡：只探测存在性（不索引、不衰退）
  try {
    const p = service.list(scope, 'entities/people');
    out.people = !!(p?.ok && Array.isArray(p.files) && p.files.length);
  } catch { /* ignore */ }
  try {
    const g = service.list(scope, 'entities/groups');
    out.group = !!(g?.ok && Array.isArray(g.files) && g.files.length);
  } catch { /* ignore */ }

  return out;
}

/**
 * 语义召回主入口。
 *
 * @param {object} input
 * @param {object} input.service   memory service
 * @param {string} input.scope     群 ID（**必填**，跨群隔离）
 * @param {string} [input.query]   当前用户说了什么（用于语义匹配）
 * @param {object} [input.config]  覆盖 SEMANTIC_DEFAULTS
 * @param {number} [input.now]
 * @param {(e: string, d?: object) => void} [input.diag]
 * @returns {{ text: string, used: number, present: { person: boolean, group: boolean, events: number } }}
 */
export function buildSemanticRecall(input) {
  const cfg = { ...SEMANTIC_DEFAULTS, ...(input?.config ?? {}) };
  if (cfg.enabled === false) {
    input?.diag?.('sem:skip', { reason: 'disabled' });
    return empty();
  }
  const scope = String(input?.scope ?? '').trim();
  if (!scope) {
    input?.diag?.('sem:skip', { reason: 'no-scope' });   // 跨群红线：没 scope 不查
    return empty();
  }
  const service = input?.service;
  if (!service || typeof service.list !== 'function') {
    input?.diag?.('sem:skip', { reason: 'no-service' });
    return empty();
  }

  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();
  let idx;
  try {
    idx = openIndex();
  } catch (e) {
    input?.diag?.('sem:fail', { reason: 'open-index', err: String(e?.message ?? e).slice(0, 80) });
    return empty();
  }

  try {
    // ① 灌数据
    const ing = ingestScope(idx, service, scope, { maxFiles: cfg.maxFiles });
    input?.diag?.('sem:ingest', { scope, indexed: ing.indexed, people: ing.people, group: ing.group });

    // ② 衰退（只影响 strength，不改 md）
    if (cfg.decayEnabled) {
      const decayed = runDecay(idx, scope, now);
      if (decayed.changed.length) {
        const rep = buildReport(decayed, scope, now);
        input?.diag?.('sem:decay', { changed: rep.changedCount, zeroed: rep.zeroedCount });
        try { input?.onDecayReport?.(rep); } catch { /* ignore */ }
      }
    }

    // ③ 查询
    const query = String(input?.query ?? '').trim();
    if (!query) {
      // 没有查询词 → 不退化成"按时间取最新"，直接空（避免噪音）
      input?.diag?.('sem:skip', { reason: 'no-query', indexed: count(idx, scope) });
      return { text: '', used: 0, present: { person: ing.people, group: ing.group, events: 0 } };
    }

    const hits = search(idx, { scope, text: query, topK: cfg.topK, now, tauMs: cfg.tauMs });
    if (!hits.length) {
      input?.diag?.('sem:miss', { scope, query: query.slice(0, 30) });
      return { text: '', used: 0, present: { person: ing.people, group: ing.group, events: 0 } };
    }

    // ④ 拼文本（受 budgetChars 硬约束）
    //
    // ⚠️ 必须清洗：真实记忆 md 里混着大量**内部字段**，直接注入会让模型
    //    把她自己的档案当成"事实"复述出来（实测：注入后她会说 openid）。
    //    这里只保留"人话"部分。
    const INTERNAL = /^(openid|来源|提醒|related|见|群：|人物：|说明：|群事件-|生日-)/i;
    const lines = [];
    const seen = new Set();          // 去重：同一句不重复注入
    let used = 0;
    for (const h of hits) {
      const parts = String(h.body ?? '')
        .split('\n')
        .map((x) => x.replace(/^[-*\s>#]+/, '').trim())
        .filter((x) => {
          if (!x) return false;
          if (/^Current$|^History$|^Related$/i.test(x)) return false;
          if (INTERNAL.test(x)) return false;     // ← 内部字段不注入
          if (x.length < 4) return false;         // 太短的碎片没意义
          // ★ 路径/文件名行（Related 段常见）：entities/xxx.md、groups/yyy.md
          if (/^(entities|groups|events|people|\S+\/[\w.-]+\.md)\b/.test(x)) return false;
          if (/\.md\s*$/i.test(x) && !/[，。；！？]/.test(x)) return false;
          return true;
        });
      // 取这段里**信息量最大**的第一条（通常是「生日：每年11月11日」这类）
      const one = parts.join('；').slice(0, 90);
      if (!one) continue;
      const dedupeKey = one.slice(0, 24);
      if (seen.has(dedupeKey)) continue;          // ← 去重
      seen.add(dedupeKey);
      if (used + one.length > cfg.budgetChars) break;
      lines.push(`· ${one}`);
      used += one.length;
    }

    if (!lines.length) return { text: '', used: 0, present: { person: ing.people, group: ing.group, events: 0 } };

    const text = lines.join('\n');
    input?.diag?.('sem:hit', { scope, hits: hits.length, used: lines.length, chars: text.length });
    return {
      text,
      used: lines.length,
      present: { person: ing.people, group: ing.group, events: lines.length },
    };
  } catch (e) {
    // ★ 永不抛错：任何失败都退化成空召回
    input?.diag?.('sem:fail', { reason: 'internal', err: String(e?.message ?? e).slice(0, 80) });
    return empty();
  } finally {
    try { idx?.close?.(); } catch { /* ignore */ }
  }
}

export default { SEMANTIC_DEFAULTS, buildSemanticRecall, ingestScope };
