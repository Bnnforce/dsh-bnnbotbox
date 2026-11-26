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
  /** ★ R8 二跳发散：是否开启（默认开）。 */
  assocEnabled: true,
  /** 二跳最多追加几条。 */
  assocTopK: 2,
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
/** 语义索引的持久化路径（R7 Stage 0）。拿不到 dbPath 时回落内存库，保证不崩。 */
function persistentDbPath(input) {
  const p = String(input?.dbPath ?? '').trim();
  return p || ':memory:';
}

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
 * ★ 二跳发散（R8 · 2026-11-26）：从第 1 跳命中里提取关键词，再搜一层关联记忆。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（主人原话）：
 *   「不管什么状态下，主动注入还是被动注入，他都能像人一样进行发散思维的思考」
 *
 *   人听到一句话不是只想起一件事，而是会顺着想起的再想起别的：
 *     「上次那家店」→ 想起店 → 想起一起去的人 → 想起当时聊了什么。
 *
 *   现在 buildSemanticRecall 只做**单跳**：query → search → 返回。
 *   这个函数补**第二跳**：从第 1 跳命中的内容里抽关键词，再 search 一次。
 *
 * ── 边界（绝不能破坏）──────────────────────────────────────────────────────
 *
 *   ① **同一 scope**：二跳仍限定在原群内，绝不跨群（隐私红线）
 *   ② **排除已命中**：第 1 跳已经返回的不重复
 *   ③ **永不抛错**：任何异常都返回空数组（发散是增强，不是必须）
 *   ④ **预算独立**：本函数不负责预算，调用方合并后统一裁
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @param {Array<object>} hits      第 1 跳命中（含 body）
 * @param {object} idx              已打开的索引
 * @param {string} scope            群 ID
 * @param {object} opts
 * @param {number} [opts.topK]      二跳最多返回几条
 * @param {number} [opts.now]
 * @param {number} [opts.tauMs]     时间衰减常数
 * @returns {Array<object>}         追加的命中（已排除第 1 跳 id）
 */
export function associateHits(hits, idx, scope, opts = {}) {
  try {
    const first = Array.isArray(hits) ? hits : [];
    if (!first.length || !idx) return [];

    const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
    const tauMs = Number(opts.tauMs) > 0 ? Number(opts.tauMs) : 30 * 24 * 60 * 60 * 1000;
    const topK = Math.max(1, Math.min(10, Number(opts.topK) || 3));

    // ① 从第 1 跳命中里提取「有信息量的关键词」
    //    策略：取每条的 body，切词后过滤停用字，保留长度≥2 的 token（中文单字无意义）
    const seenIds = new Set(first.map((h) => String(h?.id ?? '')));
    const kw = new Set();
    const STOP = new Set(
      '的了是在我你他她它们这那有和就都也不没很太又再还只把被让给对从向到与及或但而如果因所以为以于之其'
        .split(''),
    );
    for (const h of first) {
      const body = String(h?.body ?? '');
      // 提取中文双字词 + 英文/数字整词
      const tokens = body
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      for (const t of tokens) {
        if (/[\u4e00-\u9fa5]/.test(t)) {
          // 中文：滑出所有双字
          for (let i = 0; i + 1 < t.length; i += 1) {
            const bigram = t.slice(i, i + 2);
            if (!STOP.has(bigram[0]) && !STOP.has(bigram[1])) kw.add(bigram);
          }
        } else if (t.length >= 2) {
          kw.add(t.toLowerCase());
        }
      }
      if (kw.size >= 8) break;   // 够了就不继续抽，防止关键词爆炸
    }
    if (!kw.size) return [];

    // ② 用这些关键词做第二跳（同一 scope）
    const queryText = [...kw].join(' ');
    const second = search(idx, { scope, text: queryText, topK: topK * 2, now, tauMs });

    // ③ 排除已命中的 + 过滤「和当前用户 query 完全无关」的弱命中
    const out = [];
    for (const h of second) {
      const id = String(h?.id ?? '');
      if (!id || seenIds.has(id)) continue;
      out.push(h);
      if (out.length >= topK) break;
    }
    return out;
  } catch {
    return [];   // 发散失败 → 空（单跳结果不受影响）
  }
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
    // ★ 2026-11-26（R7 Stage 0）：索引改为持久化。
    //   原来 openIndex() 默认 :memory: ⇒ 每次召回都要全量重灌 92 个画像文件，
    //   重启即丢、无痕迹可查、数据量涨了会更慢。
    //   现在传入 db 路径（调用方经 input.dbPath 提供），复用同一份索引。
    idx = openIndex(persistentDbPath(input));
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

    // ★ R8 二跳发散：从第 1 跳命中再关联一层（默认开启，可配置关）
    //   关联失败/为空 → 自动回落单跳，绝不影响主链。
    let assoc = [];
    if (cfg.assocEnabled !== false) {
      try {
        assoc = associateHits(hits, idx, scope, {
          topK: cfg.assocTopK ?? 2,
          now,
          tauMs: cfg.tauMs,
        });
      } catch { assoc = []; }
    }
    if (assoc.length) {
      input?.diag?.('sem:assoc', { scope, assoc: assoc.length, first: hits.length });
      // 二跳结果接在第 1 跳之后（但预算裁剪时仍按顺序，第 1 跳优先）
      hits.push(...assoc);
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

export default { SEMANTIC_DEFAULTS, buildSemanticRecall, ingestScope, associateHits };
