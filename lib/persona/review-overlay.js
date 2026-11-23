/**
 * review-overlay — 复盘结果 → 行为禁忌（overlay）的合并、落盘与备份列表
 *
 * 从 `review.ts` 拆出（重构阶段 2 / 批次 A）。
 * 职责单一：把模型给的「避坑指南」去重、排优先级、限字数，再写成 overlay 文件。
 *
 * 三条硬约束（来自《审查标准》二.3 熔断 + 主人要求）：
 *   · 每条最多 50 字，按标点截断，绝不从句子中间砍；
 *   · 最多 6 条，优先保留严重度高、较新的；
 *   · 全文最多 400 字。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome, readOverlayExactSync, writeOverlaySync } from './store.js';
import { parseReviewOutput } from './review-llm.js';
const OVERLAY_MAX_CHARS = 400;
const OVERLAY_MAX_RULES = 6;
const OVERLAY_MAX_RULE_CHARS = 50;
const SENTENCE_PUNCT = new Set(['。', '！', '？', '；', '，', '、', ',', '.', '!', '?', ';']);
/**
 * 超过 50 字时按标点截断；截断点必须落在标点后，绝不从句子中间砍。
 * 找不到 50 字内的标点时，宁可保留整句，也不制造半句话。
 */
export function truncateOverlayRule(input, max = OVERLAY_MAX_RULE_CHARS) {
    const text = String(input || '').replace(/\s+/gu, ' ').trim();
    const chars = [...text];
    if (chars.length <= max)
        return text;
    for (let i = max - 1; i >= 0; i -= 1) {
        if (SENTENCE_PUNCT.has(chars[i]))
            return chars.slice(0, i + 1).join('').trim();
    }
    // 50 字内没有标点：允许取第一句（可能略超 50），但不从中间砍断。
    for (let i = max; i < chars.length; i += 1) {
        if (SENTENCE_PUNCT.has(chars[i]))
            return chars.slice(0, i + 1).join('').trim();
    }
    return text;
}
function cleanOverlayRule(input) {
    const text = String(input || '')
        .replace(/^\s*(?:[-*•]|\d+[.、)])\s*/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
    return truncateOverlayRule(text);
}
function parseOverlayRules(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*[-*•]\s+(.+?)\s*$/u.exec(line);
        if (!m)
            continue;
        const rule = cleanOverlayRule(m[1] || '');
        if (rule)
            out.push(rule);
    }
    return out;
}
const OVERLAY_SYNONYMS = [
    [/长篇大论|小作文|长文|长回复|啰嗦|分步推导|多步解释/gu, '长'],
    [/列表排版|数字列表|无序列表|列1234|分点/gu, '列表'],
    [/客服腔|客服口吻|知心大姐|说教|讲道理|讲大道理/gu, '说教'],
    [/像\s*ai|ai味|机器味|机器人味/giu, 'AI'],
    [/ooc|串台|性格突变|崩人设/giu, 'OOC'],
];
function overlayRuleKey(text) {
    let t = String(text || '').toLowerCase();
    for (const [re, replacement] of OVERLAY_SYNONYMS)
        t = t.replace(re, replacement);
    t = t.replace(/[^\p{Script=Han}a-z0-9]/gu, '');
    t = t.replace(/不要|别用|别|避免|绝对禁止|严禁|必须|不准|禁止|切勿|不能|少|尽量|用|写|说|的|了|吧|呢|要|把|让|给/gu, '');
    return t;
}
function bigrams(text) {
    const chars = [...text];
    const out = new Set();
    if (chars.length === 1)
        out.add(chars[0]);
    for (let i = 0; i + 1 < chars.length; i += 1)
        out.add(chars[i] + chars[i + 1]);
    return out;
}
function similarRule(a, b) {
    const ka = overlayRuleKey(a);
    const kb = overlayRuleKey(b);
    if (!ka || !kb)
        return false;
    if (ka === kb)
        return true;
    if ((ka.length <= 2 && kb.includes(ka)) || (kb.length <= 2 && ka.includes(kb)))
        return true;
    const A = bigrams(ka);
    const B = bigrams(kb);
    if (A.size === 0 || B.size === 0)
        return false;
    let hit = 0;
    for (const x of A)
        if (B.has(x))
            hit += 1;
    return hit / (A.size + B.size - hit) >= 0.6;
}
function severityOf(text) {
    return /绝对禁止|严禁|必须|不准|禁止|绝不要|永远不要/gu.test(text) ? 2 : 1;
}
function formatOverlay(rules, day) {
    return [
        `## 最近复盘（${day}）`,
        ...rules.map((r) => `- ${r.text}`),
    ].join('\n');
}
/**
 * 按字符数硬截断 overlay 全文。
 *
 * ⚠️ 2026-11-05（重构阶段 2-A）发现：**当前调用方没有一处引用本函数**，
 *   属于历史遗留的未使用代码。按「搬代码不动逻辑」的原则原样保留，
 *   是否删除等主人决定（删除零风险，因为它不参与任何路径）。
 */
function compactOverlayText(text) {
    return [...String(text || '')].length <= OVERLAY_MAX_CHARS
        ? String(text || '')
        : [...String(text || '')].slice(0, OVERLAY_MAX_CHARS).join('');
}
/**
 * 合并旧 overlay 与新生成的规则：
 * - 相似规则合并，优先保留带“绝对禁止/禁止/必须”的版本；
 * - 最多 6 条，优先严重度高、较新的规则，超出时淘汰最旧的低优先级规则；
 * - 全文最多 400 字。
 */
export function mergeOverlayRules(existingText, newRules, day = new Date().toISOString().slice(0, 10)) {
    const entries = [];
    let order = 0;
    for (const rule of parseOverlayRules(existingText)) {
        entries.push({ text: rule, severity: severityOf(rule), order });
        order += 1;
    }
    for (const rule of newRules.map(cleanOverlayRule).filter(Boolean).slice(0, 3)) {
        entries.push({ text: rule, severity: severityOf(rule), order });
        order += 1;
    }
    const merged = [];
    for (const entry of entries) {
        const idx = merged.findIndex((old) => similarRule(old.text, entry.text));
        if (idx === -1) {
            merged.push(entry);
        }
        else if (entry.severity > merged[idx].severity || (entry.severity === merged[idx].severity && entry.order > merged[idx].order)) {
            merged[idx] = entry;
        }
    }
    const picked = merged
        .slice()
        .sort((a, b) => b.severity - a.severity || b.order - a.order)
        .slice(0, OVERLAY_MAX_RULES);
    let display = picked.sort((a, b) => a.order - b.order);
    while (display.length > 1) {
        const text = formatOverlay(display, day);
        if ([...text].length <= OVERLAY_MAX_CHARS)
            return display.map((r) => r.text);
        // 淘汰优先级最低的一条：severity 低、order 旧。
        display = display
            .slice()
            .sort((a, b) => a.severity - b.severity || a.order - b.order)
            .slice(1);
    }
    if (display.length === 1) {
        const only = display[0];
        const header = `## 最近复盘（${day}）\n- `;
        const budget = Math.max(1, OVERLAY_MAX_CHARS - [...header].length);
        return [[...only.text].slice(0, budget).join('')];
    }
    return [];
}
/** 落盘复盘结果；合并旧 overlay 后返回实际保留的规则。 */
export function saveReviewOverlay(output, groupId = '', persona = '') {
    const bullets = parseReviewOutput(output);
    if (bullets.length === 0)
        return [];
    const day = new Date().toISOString().slice(0, 10);
    const existing = readOverlayExactSync(groupId, persona);
    const merged = mergeOverlayRules(existing, bullets, day);
    if (merged.length === 0)
        return [];
    writeOverlaySync(formatOverlay(merged.map((text, order) => ({ text, severity: severityOf(text), order })), day), groupId, persona);
    return merged;
}
export function listOverlayBackups() {
    try {
        return readdirSync(join(dshHome(), 'data', 'dsh-anti-ai-persona', 'overlay-history'))
            .filter((f) => f.endsWith('.md'))
            .sort();
    }
    catch {
        return [];
    }
}
