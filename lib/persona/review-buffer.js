/**
 * review-buffer — 错题本文件读写（按人格隔离 + 原子写）
 *
 * 从 `review.ts` 拆出（重构阶段 2 / 批次 A）。
 * 职责单一：**只管文件**——写一条、读出来、裁剪、列出有哪些本子。
 * 不含任何判定逻辑、不含模型调用。
 *
 * 数据布局（`~/.dsh/data/dsh-anti-ai-persona/`）：
 *   · `review-buffer.jsonl`               无人格信息时的主本
 *   · `review-buffer-<人格名>.jsonl`       有具名人格时按人格分流
 *   · `review-buffer-biananan.jsonl`      比安安的历史文件名（兼容老数据）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './store.js';
import { collectGroupMessages } from './analyzer.js';
import { LEGACY_REVIEW_BUFFER_FILES, MAIN_REVIEW_BUFFER, } from './review-types.js';
/** 人格 → 本子文件名。 */
export function reviewBufferName(persona = '') {
    const name = String(persona || '').trim();
    if (!name)
        return MAIN_REVIEW_BUFFER;
    // 兼容历史文件名（比安安的本子是 2026-10-30 就定下的，别让老数据失联）
    if (name.includes('比安安'))
        return 'review-buffer-biananan.jsonl';
    const safe = name.replace(/[^0-9A-Za-z_\u4e00-\u9fa5-]/gu, '_').slice(0, 40);
    return `review-buffer-${safe || 'unknown'}.jsonl`;
}
export function reviewBufferPath(persona = '') {
    return join(dshHome(), 'data', 'dsh-anti-ai-persona', reviewBufferName(persona));
}
/** 列出所有存在的错题本文件名（主本 + 各人格本）。 */
export function listReviewBufferFiles() {
    const dir = join(dshHome(), 'data', 'dsh-anti-ai-persona');
    const found = new Set();
    try {
        for (const f of readdirSync(dir)) {
            if (/^review-buffer.*\.jsonl$/u.test(f))
                found.add(f);
        }
    }
    catch { /* 目录不存在 */ }
    // 即使文件还没生成，也把历史两个本子算进来（调用方更关心「该读哪些」）
    for (const f of LEGACY_REVIEW_BUFFER_FILES)
        found.add(f);
    return [...found].sort();
}
export function appendReviewRecord(record) {
    const file = reviewBufferPath(record.persona);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}
/**
 * 读取错题本。
 * 2026-11-01 修：原来只读 `review-buffer.jsonl` ⇒ 比安安的错题永远进不了复盘。
 * 2026-11-02：改为按人格分流写入 + **扫目录读全部本子**（不再写死文件名列表）。
 */
export function readReviewRecords(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
    const rows = [];
    const dir = join(dshHome(), 'data', 'dsh-anti-ai-persona');
    for (const name of listReviewBufferFiles()) {
        let raw = '';
        try {
            raw = readFileSync(join(dir, name), 'utf8');
        }
        catch {
            continue;
        }
        collectRecords(raw, rows, maxAgeMs, now);
    }
    return rows.sort((a, b) => a.at - b.at).slice(-50);
}
function collectRecords(raw, rows, maxAgeMs, now) {
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const o = JSON.parse(line);
            if (typeof o.at !== 'number' || !Number.isFinite(o.at))
                continue;
            if (now - o.at > maxAgeMs || o.at > now + 60_000)
                continue;
            const userText = String(o.userText || '').trim();
            const assistantText = String(o.assistantText || '').trim();
            if (!userText || !assistantText)
                continue;
            rows.push({
                at: o.at,
                sessionId: String(o.sessionId || ''),
                groupId: o.groupId ? String(o.groupId) : undefined,
                persona: o.persona ? String(o.persona) : undefined,
                source: o.source === 'judge' ? 'judge' : (o.source === 'correction' ? 'correction' : undefined),
                userText,
                assistantText,
            });
        }
        catch { /* skip bad line */ }
    }
}
/**
 * 裁剪错题本：只保留 `retainMs` 内的记录，防止文件无限增长。
 * 复盘成功后调用（失败就保留，不丢证据）。
 *
 * 原子写：临时文件 + rename（《开发规则》四.3）。
 */
export function pruneReviewBuffers(retainMs = 72 * 60 * 60 * 1000, now = Date.now()) {
    const out = [];
    for (const name of listReviewBufferFiles()) {
        const file = join(dshHome(), 'data', 'dsh-anti-ai-persona', name);
        let raw = '';
        try {
            raw = readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        const keep = [];
        let removed = 0;
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            let at = Number.NaN;
            try {
                at = Number(JSON.parse(line).at);
            }
            catch {
                removed += 1;
                continue;
            }
            if (!Number.isFinite(at) || now - at > retainMs || at > now + 60_000) {
                removed += 1;
                continue;
            }
            keep.push(line);
        }
        if (removed > 0) {
            const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
            renameSync(tmp, file);
        }
        out.push({ file: name, kept: keep.length, removed });
    }
    return out;
}
/** 读取普通群聊作为复盘上下文（不当作反面教材）。 */
export async function readRecentChatTexts(dataRoot, limit = 30) {
    try {
        const collected = await collectGroupMessages(dataRoot, 1);
        const texts = collected.groups.flatMap((g) => g.messages.map((m) => m.text));
        return texts.slice(-Math.max(1, limit));
    }
    catch {
        return [];
    }
}
export function reviewBufferExists() {
    return existsSync(reviewBufferPath());
}
