/**
 * highlights.ts — 「高光时刻」记忆库
 *
 * 主人要求（2026-11-02）：
 *   「当主人或群友发出『这句绝了』『真像爱莉』『满分』等夸赞词汇时，
 *     把 Bot 刚才的回复存进 highlights.md。」
 *
 * 为什么要它：
 *   - 错题本（review-buffer）只记**反面教材**，复盘产出的是「避坑指南」；
 *   - 但被夸的那几句恰恰是**当前人格最像、最对味**的表达，是正向锚点；
 *   - 把它们在 system prompt 末尾作为锚点重新注入，能显著压低「长会话上下文压缩后
 *     人设返祖」的概率（配 guideline + overlay 形成三层锚点）。
 *
 * 判定口径（本地正则，不调模型、不花钱）：
 *   · 只认**明确的夸赞**：「这句绝了」「真像爱莉」「满分」「太像了」「本人」「破防了」
 *     「这就是她」「味儿对了」「好会」「神回复」…；
 *   · 排除**骂/纠偏**：「像 AI」「太长了」「说人话」「串台」；
 *   · 排除**反问/否定**：「这也叫满分？」「不像」。
 *
 * 存储：`{DSH_HOME}/data/dsh-anti-ai-persona/highlights.md`
 *   —— 与 guideline/overlay 同目录，但**不是**按群按人格分文件：
 *   它是**跨群共享的正向锚点池**（同一人格在不同群说出的好句子都算这个人格的高光）。
 *   每行一条：`- [群 gid｜人格 name｜YYYY-MM-DD] 正文`
 *
 * 容量与去重：
 *   · 最多保留 `HIGHLIGHT_MAX_RECORDS`（默认 60）条，按时间新→旧，超出淘汰最旧；
 *   · 同一条回复（归一化后）只记一次；
 *   · 单条正文超过 `HIGHLIGHT_MAX_CHARS` 时按标点截断，不从句子中间砍。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome, safeGroupId, safePersonaName } from './store.js';

/** 明确的夸赞词。命中任意一条即视为「高光」。 */
export const PRAISE_TRIGGERS = [
  '这句绝了', '这句绝', '绝了', '真像', '满分', '太像了', '好像本人', '就是本人',
  '味对了', '味儿对了', '好会', '神回复', '这就是她', '破防了', '笑死我了',
  '太对味', '这个对', '学到了', '好可爱', '爱了', '這句絕了', '太好笑',
] as const;

/** 追加强调式夸赞（要求同时出现正向语气词，避免「绝了」单字误判太宽）。 */
const PRAISE_RE = new RegExp(
  PRAISE_TRIGGERS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'),
  'iu',
);
/** 否定/纠偏语境：命中即**不算**高光（避免「这也叫满分？」被当夸赞）。 */
const NEGATIVE_RE = /像\s*AI|像ai|太长了|太长不看|说人话|太啰嗦|串台|重说|不像|差点意思|这也叫|算了吧|不好笑|尬/iu;

export const HIGHLIGHT_MAX_RECORDS = 60;
export const HIGHLIGHT_MAX_CHARS = 200;

export interface HighlightRecord {
  at: number;
  groupId: string;
  persona: string;
  note: string;   // 触发的那句夸赞（截断）
  text: string;   // 被夸的 Bot 回复正文
}

export function highlightsPath(): string {
  return join(dshHome(), 'data', 'dsh-anti-ai-persona', 'highlights.md');
}

/** 判断一条用户消息是否为「夸赞」。 */
export function isPraiseText(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  if (NEGATIVE_RE.test(s)) return false;
  return PRAISE_RE.test(s);
}

/** 按标点截断到 max 字符内（不从句子中间砍）。 */
export function clipForHighlight(input: string, max = HIGHLIGHT_MAX_CHARS): string {
  const text = String(input || '').replace(/\s+/gu, ' ').trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  const PUNCT = new Set(['。', '！', '？', '；', '，', '、', ',', '.', '!', '?', ';', '…']);
  for (let i = max - 1; i >= 0; i -= 1) {
    if (PUNCT.has(chars[i]!)) return chars.slice(0, i + 1).join('').trim();
  }
  return chars.slice(0, max).join('').trim();
}

/** 归一化（去空白/标点），用于同句去重。 */
function normalizeForDedupe(text: string): string {
  return String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/** 读回全部高光（解析失败的行直接跳过，不抛错）。 */
export function readHighlights(): HighlightRecord[] {
  try {
    const raw = readFileSync(highlightsPath(), 'utf8');
    const rows: HighlightRecord[] = [];
    for (const line of raw.split('\n')) {
      const m = /^- \[群 ([^｜\]]+)｜人格 ([^｜\]]+)｜([^\]]+)\] (.+)$/u.exec(line.trim());
      if (!m) continue;
      rows.push({
        at: Date.parse(m[3]!) || 0,
        groupId: m[1] === 'global' ? '' : m[1]!,
        persona: m[2] === 'default' ? '' : m[2]!,
        note: '',
        text: m[4]!,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * 最近 N 条高光（用于 system prompt 锚点）。
 *
 * 🔴 2026-11-06 修（P1-2，真机审查发现）：此前**不按群过滤** ——
 *   `guideline` 与 `overlay` 都按 groupId 隔离，唯独高光把**所有群**的夸赞混在一起注入。
 *   后果：A 群夸她的话会出现在 B 群的 prompt 里（跨群串味）。
 *
 * @param limit   最多取几条
 * @param groupId 只取该群的高光；**不传 = 全部（保持旧行为，供测试/诊断用）**
 *
 * ⚠️ 向后兼容：旧记录可能没 `groupId` → 视为 global，指定 groupId 时**不会**被选中
 *   （宁可少几条也不串群）。
 */
export function readRecentHighlights(limit = 2, groupId?: string): HighlightRecord[] {
  const all = readHighlights();
  const gid = String(groupId ?? '').trim();
  const filtered = gid ? all.filter((r) => String(r.groupId ?? '').trim() === gid) : all;
  return filtered.slice(-Math.max(1, limit)).reverse(); // 新的排前面
}

function formatLine(record: HighlightRecord): string {
  const gid = record.groupId ? safeGroupId(record.groupId) : 'global';
  const persona = record.persona ? safePersonaName(record.persona) : 'default';
  const day = new Date(record.at).toISOString().slice(0, 10);
  return `- [群 ${gid}｜人格 ${persona}｜${day}] ${record.text}`;
}

function header(): string {
  return [
    '# 高光时刻（被夸的 Bot 回复）',
    '',
    '> 本文件由 dsh-anti-ai-persona 自动维护：群友/主人发出明确夸赞时，记下 Bot 刚才那条回复。',
    '> 最近 2 条会作为「正向锚点」注入 system prompt 末尾，防止长会话压缩后人设返祖。',
    '> 手动删掉某行即等于让它不再被注入；整份删除等于清空锚点池。',
    '',
    '',
  ].join('\n');
}

/**
 * 追加一条高光。
 * @returns true = 真的写进去了；false = 判重命中或写入失败。
 */
export function appendHighlight(record: {
  at?: number; groupId?: string; persona?: string; note?: string; text: string;
}): boolean {
  const text = clipForHighlight(record.text);
  if (!text) return false;
  const rows = readHighlights();
  const key = normalizeForDedupe(text);
  if (key && rows.some((r) => normalizeForDedupe(r.text) === key)) return false;

  rows.push({
    at: Number(record.at) || Date.now(),
    groupId: String(record.groupId || ''),
    persona: String(record.persona || ''),
    note: clipForHighlight(record.note || '', 40),
    text,
  });
  // 只保留最近 N 条（按写入顺序，超出淘汰最旧）
  const kept = rows.slice(-HIGHLIGHT_MAX_RECORDS);
  const path = highlightsPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = kept.map(formatLine).join('\n');
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${header()}${body}\n`, 'utf8');
  renameSync(tmp, path);
  return true;
}

/** 诊断用：当前条数。 */
export function highlightCount(): number {
  return readHighlights().length;
}

/** 诊断用：文件是否存在。 */
export function highlightsExist(): boolean {
  return existsSync(highlightsPath());
}

export default {
  PRAISE_TRIGGERS,
  HIGHLIGHT_MAX_RECORDS,
  HIGHLIGHT_MAX_CHARS,
  highlightsPath,
  isPraiseText,
  clipForHighlight,
  readHighlights,
  readRecentHighlights,
  appendHighlight,
  highlightCount,
  highlightsExist,
};
