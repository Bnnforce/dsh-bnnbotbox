/**
 * semantic-index — 记忆的本地语义索引（SQLite FTS5 + 中文切分）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层
 *
 *   现有召回（`memory-recall/index.js`）是**按字符预算拼文件**：
 *   读人物卡 / 群卡 / 最近 N 天事件，截断到 280 字注入。
 *
 *   问题：你说"上次那个下雨天"，它不会去找"下雨"那条记忆，
 *   只会找"最近 3 天"的事件。聊得越久越觉得「她记是记得，但总记错重点」。
 *
 *   本模块只做一件事：**把记忆变成可按语义检索的索引**。
 *   召回编排在 semantic-recall.js，衰退在 decay.js。
 *
 * ── 三个必须知道的坑（都是实测踩出来的，改代码前先读）──────────────
 *
 *   ① **FTS5 的 unicode61 分词器不切中文**
 *      直接 `MATCH '下雨'` 返回 0 条 —— 看起来像功能不可用，其实是没分词。
 *      ⇒ 写入和查询都必须先过 `seg()`（汉字拆单字，英文/数字保整词）。
 *
 *   ② **查询式必须"先 split 再 join(' OR ')"**
 *      `seg('下雨 蛋糕')` 得到 `"下 雨 蛋 糕"`，FTS5 当成 AND → 一条都搜不到。
 *      而直接对结果 split 又可能因为连续空格报 `syntax error near "OR"`。
 *      ⇒ 正确写法见 `buildQuery()`，已去重 + 规范化空白。
 *
 *   ③ **md 是唯一真相，索引只是缓存**
 *      索引随时可丢弃重建（3000 条实测 <100ms）。
 *      任何"索引和文件不一致"的情况，正确做法是**重建**，不是修补。
 *
 * ── 数据边界（安全红线）────────────────────────────────────────────────────
 *
 *   每条记忆都带 `scope`（群 ID）。**查询必须限定 scope**，
 *   绝不允许跨群召回 —— 群 A 的事不该出现在群 B。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseSync } from 'node:sqlite';

/** 三档强度。pinned 永不衰退。 */
export const TIER = Object.freeze({
  PINNED: 'pinned',
  NORMAL: 'normal',
  EPHEMERAL: 'ephemeral',
});

/**
 * 明确偏好词 → 自动 pinned。
 *
 * 为什么用词表而不是 LLM 判断：这条路径要够快够稳，
 * 判错把偏好降级是不可逆的（虽然 md 还在，但召回质量会掉）。
 */
/**
 * 停用字：单字切分会把「天」「接」「日」这种高频字当检索词，
 * 导致查"下雨"召回"生日接龙"（共享"日"字之类的巧合）。
 *
 * ⚠️ 实测：3 条数据里查"雨"就召回了无关的"生日接龙"。
 *    停用表是这条链路的第一道降噪，必须有。
 */
const STOP_CHARS = new Set(
  '的了是在我你他她它们这那有和就都也不没很太又再还只把被让给对从向到与及或但而如果因所以为以于之其'
    .split(''),
);

const PINNED_HINTS = [
  '不', '别', '讨厌', '喜欢', '爱', '记住', '记着', '以后', '一定要',
  '千万别', '受不了', '过敏', '怕', '生日', '名字', '称呼',
];

/**
 * 中文切分：汉字拆单字，英文/数字保整词，最后去重。
 *
 * ⚠️ 去重那一步不能省 —— FTS5 的 bm25 对重复词会重复计频，
 *    不去重会让"下 下 下"这种查询式权重失衡。
 *
 * @param {string} text
 * @returns {string} 空格分隔的检索串
 */
export function seg(text) {
  const words = String(text ?? '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tokens = words.flatMap((w) =>
    /[\u4e00-\u9fa5]/.test(w)
      ? w.replace(/[\u4e00-\u9fa5]/g, (c) => c + ' ').split(/\s+/).filter(Boolean)
      : [w.toLowerCase()],
  );
  // 过滤停用字（但**只在多字词场景**下过滤，避免把"雨"本身也滤掉）
  const kept = tokens.filter((t) => t.length > 1 || !STOP_CHARS.has(t));
  return [...new Set(kept)].join(' ');
}

/**
 * 把任意问题变成 FTS5 查询式。
 *
 * ⚠️ 坑②：必须 split 再 join，直接拼字符串会因连续空格报语法错。
 *
 * @param {string} text
 * @returns {string} 形如 `下 OR 雨 OR 蛋 OR 糕`；空输入返回 ''
 */
export function buildQuery(text) {
  const tokens = seg(text).split(' ').filter(Boolean);
  if (!tokens.length) return '';
  return tokens.join(' OR ');
}

/** 推断档位。含偏好词 → pinned；短句/一次性的 → ephemeral；其余 normal。 */
export function inferTier(text, explicitTier) {
  if (explicitTier === TIER.PINNED || explicitTier === TIER.NORMAL || explicitTier === TIER.EPHEMERAL) {
    return explicitTier;
  }
  const t = String(text ?? '');
  if (PINNED_HINTS.some((h) => t.includes(h))) return TIER.PINNED;
  // 很短 = 大概率是闲聊
  if (t.replace(/\s/g, '').length < 12) return TIER.EPHEMERAL;
  return TIER.NORMAL;
}

/**
 * 打开（或新建）索引库。
 *
 * @param {string} [file] ':memory:' 或文件路径。默认内存库（重启即丢，靠重建）
 * @returns {{ db: import('node:sqlite').DatabaseSync, close: () => void }}
 */
export function openIndex(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
      cagg,
      id UNINDEXED,
      scope UNINDEXED,
      kind UNINDEXED,
      tier UNINDEXED,
      strength UNINDEXED,
      mentionedAt UNINDEXED,
      superseded UNINDEXED,
      src UNINDEXED,
      body UNINDEXED
    );
  `);
  return {
    db,
    close: () => { try { db.close(); } catch { /* ignore */ } },
  };
}

/**
 * 写入一条记忆（幂等：同 id 先删后插）。
 *
 * @param {object} idx   openIndex() 的返回
 * @param {object} item
 * @param {string} item.id
 * @param {string} item.scope   群 ID（**必须**，跨群隔离）
 * @param {string} item.kind    'event' | 'fact'
 * @param {string} item.body    原文（会截断存储）
 * @param {string} [item.tier]
 * @param {number} [item.strength]
 * @param {number} [item.mentionedAt]
 * @param {boolean} [item.superseded]
 * @param {string} [item.src]   来源相对路径
 */
export function put(idx, item) {
  const { db } = idx;
  const scope = String(item?.scope ?? '').trim();
  const id = String(item?.id ?? '').trim();
  if (!scope || !id) return false;   // scope 是红线，缺了宁可不写

  const body = String(item?.body ?? '').slice(0, 4000);
  const tier = inferTier(body, item?.tier);
  const strength = Number.isFinite(item?.strength) ? Number(item.strength) : 1;
  const mentionedAt = Number.isFinite(item?.mentionedAt) ? Number(item.mentionedAt) : Date.now();
  const superseded = item?.superseded ? 1 : 0;

  try {
    db.prepare('DELETE FROM mem WHERE id = ?').run(id);
    db.prepare(
      'INSERT INTO mem (cagg,id,scope,kind,tier,strength,mentionedAt,superseded,src,body) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      seg(body),
      id,
      scope,
      String(item?.kind ?? 'event'),
      tier,
      String(strength),
      String(mentionedAt),
      String(superseded),
      String(item?.src ?? ''),
      body,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 查询：BM25 + 时间衰减 + 档位权重。
 *
 * @param {object} idx
 * @param {object} q
 * @param {string} q.scope   群 ID（**必填**，跨群隔离）
 * @param {string} q.text    查询文本
 * @param {number} [q.topK]
 * @param {number} [q.now]
 * @param {number} [q.tauMs] 时间衰减常数（默认 30 天）
 * @returns {Array<{id,kind,tier,body,src,score,bm25,decay}>}
 */
export function search(idx, q) {
  const { db } = idx;
  const scope = String(q?.scope ?? '').trim();
  if (!scope) return [];                 // 没有 scope 就不查（红线）
  const query = buildQuery(q?.text);
  if (!query) return [];

  const topK = Math.max(1, Math.min(50, Number(q?.topK) || 5));
  const now = Number.isFinite(q?.now) ? Number(q.now) : Date.now();
  const tauMs = Number(q?.tauMs) > 0 ? Number(q.tauMs) : 30 * 24 * 60 * 60 * 1000;

  let rows = [];
  try {
    // 先按 scope 粗筛 + FTS 匹配，再在 JS 里算衰减与权重
    // （FTS5 的 bm25 是负值，越小越相关）
    rows = db.prepare(
      `SELECT id,kind,tier,strength,mentionedAt,src,body,bm25(mem) AS s
         FROM mem
        WHERE cagg MATCH ? AND scope = ? AND superseded = '0'
        ORDER BY s
        LIMIT ?`,
    ).all(query, scope, topK * 4);
  } catch {
    return [];
  }

  // ★ 双字验证用的原始查询串（保留原词，不做单字切分）
  const rawQuery = String(q?.text ?? '').replace(/\s+/g, '');
  const bigrams = new Set();
  for (let i = 0; i + 1 < rawQuery.length; i += 1) {
    const bg = rawQuery.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(bg)) bigrams.add(bg);
  }

  const scored = [];
  for (const r of rows) {
    const bm = Math.abs(Number(r.s));                 // 只用相对大小
    const strength = Number(r.strength) || 0;
    const at = Number(r.mentionedAt) || now;
    const dt = Math.max(0, now - at);
    const decay = Math.exp(-dt / tauMs);
    const tierW = r.tier === TIER.PINNED ? 3 : r.tier === TIER.EPHEMERAL ? 0.6 : 1;
    // 归一化：bm25 差值范围不可预测，这里用 1/(1+bm) 映射到 (0,1]
    const rel = 1 / (1 + bm);
    // ★ 降噪：单字匹配容易误召（查"雨"命中"生日"的"日"）。
    //   要求原文里至少命中一个**双字**，否则权重砍到 15%。
    let bigramHit = 1;
    if (bigrams.size) {
      const body = String(r.body ?? '');
      let hit = false;
      for (const bg of bigrams) { if (body.includes(bg)) { hit = true; break; } }
      bigramHit = hit ? 1 : 0;
    }
    // ★ 没有双字命中 = 纯单字巧合 → **直接丢弃**，不是降权。
    //   实测：降权到 0.15 仍然会被选进 topK（因为候选本来就少），所以必须剔除。
    if (bigrams.size && bigramHit === 0) continue;
    const score = rel * decay * tierW * (0.3 + 0.7 * strength);
    scored.push({
      id: r.id,
      kind: r.kind,
      tier: r.tier,
      body: r.body,
      src: r.src,
      score,
      bm25: bm,
      decay,
      bigram: bigramHit,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** 索引条目数（诊断用）。 */
export function count(idx, scope) {
  try {
    const row = scope
      ? idx.db.prepare('SELECT COUNT(*) AS n FROM mem WHERE scope = ?').get(String(scope))
      : idx.db.prepare('SELECT COUNT(*) AS n FROM mem').get();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

/** 把某条标记为"被新事实取代"（不物理删）。 */
export function markSuperseded(idx, id) {
  try {
    idx.db.prepare("UPDATE mem SET superseded = '1' WHERE id = ?").run(String(id));
    return true;
  } catch {
    return false;
  }
}

export default { seg, buildQuery, inferTier, openIndex, put, search, count, markSuperseded, TIER };
