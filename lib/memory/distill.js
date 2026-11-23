/**
 * distill — 记忆沉淀链路（2026-11-15，方案 A-Phase 3）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要这个（实测依据）
 *
 *   审计发现记忆卡「只建骨架、不沉淀」：
 *     · `buildPersonCardText()` 是纯模板拼装，History 段只有一行自动生成的建档记录
 *     · 90 张卡里 18 张 History 完全为空，其余多为 1-3 行
 *     · 记忆注入平均只占预算 36%（101/280 字）—— 不是预算不够，是**没有内容可填**
 *
 *   对比 mem0 等主流方案：它们的记忆是「从对话里长出来的」（LLM 抽取事实 → 增量入库），
 *   我们的是「建出来的」（建档一次，之后永不变）。这是唯一的本质差距。
 *
 * ── 设计约束（每条都是踩坑换来的） ──────────────────────────────────────────
 *   ① **默认关闭**（config.distillEnabled = false）：新能力先观察再放开
 *   ② **单群试点**（config.distillGroupIds 白名单）：避免一次开全群成本失控
 *   ③ **只追加，不改已有行**：追加到 `## History`，绝不重写 `## Current`
 *   ④ **每人卡 History ≤ 上限**：超了删最旧（默认 20 条），防止无限膨胀
 *   ⑤ **单次单群处理消息数上限**：默认 50 条，成本可预测
 *   ⑥ **提炼失败绝不写盘**：宁可这张卡不长，也不要写进幻觉
 *
 * ── 与 auto-card 的关系 ────────────────────────────────────────────────────
 *   `auto-card` 负责「**有没有**这张卡」（一次性建档）
 *   `distill`  负责「卡里**写什么**」（持续沉淀）
 *   两者不冲突，也不互相覆盖：auto-card 只在卡不存在时创建；distill 只在卡有 History 段时追加。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** History 段上限的硬保护（配置再大也不超过这个）。 */
const HARD_MAX_HISTORY = 100;
/** 单条事实最大字符（防模型输出超长）。 */
const MAX_FACT_CHARS = 200;
/** 单次最多处理的消息条数硬上限。 */
const HARD_MAX_MESSAGES = 200;
/**
 * 读最近消息（从 qqbot 的 msg-history JSONL）。
 *
 * 数据格式（实测 2026-11-04）：每行 `{"id","s","n","t","k","x","me"}`
 *   s=senderId, n=senderName, t=text, k=kind, at 缺失时用文件 mtime 兜底
 */
export function readRecentMessages(qqbotRoot, gid, limit) {
    const out = [];
    const dir = join(qqbotRoot, '.qqbot', 'msg-history', `group_${gid}`);
    if (!existsSync(dir))
        return out;
    let files = [];
    try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    }
    catch {
        return out;
    }
    for (const f of files) {
        if (out.length >= limit)
            break;
        const p = join(dir, f);
        let lines = [];
        try {
            lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
        }
        catch {
            continue;
        }
        let fallbackAt = Date.now();
        try {
            fallbackAt = statSync(p).mtimeMs;
        }
        catch { /* ignore */ }
        // 从后往前取（最新优先）
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            try {
                const j = JSON.parse(lines[i]);
                const text = String(j.t ?? '').trim();
                if (!text)
                    continue; // 跳过纯图片/表情
                if (String(j.k ?? '') !== 'text')
                    continue; // 只沉淀文字
                const name = String(j.n ?? '').trim();
                if (!name)
                    continue;
                out.push({ name, text, at: Number(j.at ?? fallbackAt) });
            }
            catch { /* 坏行跳过 */ }
        }
    }
    return out.reverse(); // 恢复时间正序，便于提炼时理解上下文
}
/** 读一个人物卡的正文（用于判断卡是否存在 + 取 History 段）。 */
export function readPersonCard(memoryRoot, gid, name) {
    const dir = join(memoryRoot, 'groups', gid, 'entities', 'people');
    const path = join(dir, `${sanitizeName(name)}.md`);
    if (!existsSync(path))
        return null;
    try {
        return { path, text: readFileSync(path, 'utf8') };
    }
    catch {
        return null;
    }
}
/** 文件名净化（与 auto-card 的 sanitizeCardName 同口径的最小版）。 */
export function sanitizeName(raw) {
    return String(raw ?? '')
        .replace(/[\u200b-\u200f\u2060\ufeff]/gu, '')
        .replace(/[\\/:*?"<>|]/gu, '_')
        .replace(/\.\./gu, '_')
        .trim()
        .slice(0, 60) || 'unknown';
}
/** 从卡片正文里数 History 条目数（`- ` 开头的行）。 */
function countHistoryItems(text) {
    const idx = text.search(/^##\s*History\s*$/imu);
    if (idx < 0)
        return { count: 0, dates: [] };
    const rest = text.slice(idx);
    const next = rest.slice(1).search(/^##\s+/mu);
    const seg = next < 0 ? rest : rest.slice(0, next + 1);
    const items = seg.split('\n').filter((l) => /^\s*[-*]\s+/.test(l));
    const dates = [];
    for (const l of items) {
        const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(l);
        if (m) {
            const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
            if (Number.isFinite(t))
                dates.push(t);
        }
    }
    return { count: items.length, dates };
}
/** 把一条事实追加进卡片的 History 段（只追加，绝不改其他内容）。 */
export function appendFactToCard(cardText, fact, dateKey, maxHistory) {
    const clean = String(fact ?? '').replace(/\s+/gu, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (!clean)
        return { text: cardText, added: false, dropped: 0 };
    const idx = cardText.search(/^##\s*History\s*$/imu);
    if (idx < 0)
        return { text: cardText, added: false, dropped: 0 }; // 没有 History 段就不动（不擅自加结构）
    const lineEnd = cardText.indexOf('\n', idx);
    const head = lineEnd < 0 ? cardText : cardText.slice(0, lineEnd + 1);
    const rest = lineEnd < 0 ? '' : cardText.slice(lineEnd + 1);
    // rest 里找到下一个 ## 段的位置
    const nextIdx = rest.search(/^##\s+/mu);
    const historyBody = nextIdx < 0 ? rest : rest.slice(0, nextIdx);
    const tail = nextIdx < 0 ? '' : rest.slice(nextIdx);
    const lines = historyBody.split('\n').filter((l) => l.trim() !== '');
    // 去重：同样的事实（忽略日期前缀）已存在则不重复写
    const factCore = clean;
    if (lines.some((l) => l.replace(/^\s*[-*]\s*(\d{4}-\d{2}-\d{2}[：:]\s*)?/u, '').trim() === factCore)) {
        return { text: cardText, added: false, dropped: 0 };
    }
    lines.push(`- ${dateKey}: ${clean}`);
    // 上限保护：超出则删最旧（按出现顺序，最早的在前）
    let dropped = 0;
    const cap = Math.min(HARD_MAX_HISTORY, Math.max(1, Math.floor(maxHistory)));
    while (lines.length > cap) {
        lines.shift();
        dropped++;
    }
    const rebuilt = `${head}${lines.join('\n')}\n${tail}`;
    return { text: rebuilt, added: true, dropped };
}
/** 原子写文件。 */
function atomicWrite(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}
/**
 * 执行一次沉淀。
 *
 * @param deps 数据根、配置、提炼器（LLM 由调用方注入，本模块不直接调模型）
 * @returns 结果（**永不抛**）
 */
export async function runDistill(deps) {
    const empty = { ok: false, messages: 0, facts: 0, cards: 0 };
    try {
        const cfg = deps.config;
        if (!cfg?.enabled)
            return { ...empty, skipped: 'disabled' };
        if (typeof deps.extractor !== 'function')
            return { ...empty, skipped: 'no-extractor' };
        const root = String(deps.qqbotRoot ?? '').trim();
        const memRoot = String(deps.memoryRoot ?? '').trim();
        if (!root || !memRoot)
            return { ...empty, skipped: 'no-root' };
        // 决定处理哪些群
        const groupsRoot = join(memRoot, 'groups');
        if (!existsSync(groupsRoot))
            return { ...empty, skipped: 'no-groups' };
        let gids = [];
        try {
            gids = readdirSync(groupsRoot).filter((d) => {
                try {
                    return statSync(join(groupsRoot, d)).isDirectory();
                }
                catch {
                    return false;
                }
            });
        }
        catch {
            return { ...empty, skipped: 'no-groups' };
        }
        const whitelist = Array.isArray(cfg.groupIds) ? cfg.groupIds.filter(Boolean) : [];
        if (whitelist.length > 0)
            gids = gids.filter((g) => whitelist.includes(g));
        const now = Number(deps.now ?? Date.now());
        const tz = deps.timeZone ?? 'Asia/Shanghai';
        const dateKey = new Date(now + 8 * 3600_000).toISOString().slice(0, 10); // 固定 +08
        const maxMsgs = Math.min(HARD_MAX_MESSAGES, Math.max(1, Math.floor(cfg.maxMessagesPerRun || 50)));
        const maxHist = Math.min(HARD_MAX_HISTORY, Math.max(1, Math.floor(cfg.maxHistoryPerPerson || 20)));
        let totalMsgs = 0, totalFacts = 0, totalCards = 0;
        const detail = [];
        for (const gid of gids) {
            const msgs = readRecentMessages(root, gid, maxMsgs);
            if (msgs.length === 0)
                continue;
            totalMsgs += msgs.length;
            // 提炼（失败即跳过该群，绝不写盘）
            let facts = [];
            try {
                facts = await deps.extractor({ messages: msgs, groupName: gid });
            }
            catch (err) {
                deps.logger?.warn?.(`[distill] 提炼失败（群 ${gid.slice(0, 8)}…，本次跳过）：${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            if (!Array.isArray(facts) || facts.length === 0)
                continue;
            totalFacts += facts.length;
            // 按人聚合后写入
            const byName = new Map();
            for (const f of facts) {
                const n = String(f?.name ?? '').trim();
                const fact = String(f?.fact ?? '').trim();
                if (!n || !fact)
                    continue;
                if (!byName.has(n))
                    byName.set(n, []);
                byName.get(n).push(fact);
            }
            for (const [name, list] of byName) {
                const card = readPersonCard(memRoot, gid, name);
                if (!card)
                    continue; // 没卡不建（建档是 auto-card 的职责）
                let text = card.text;
                let added = 0, dropped = 0;
                for (const fact of list) {
                    const r = appendFactToCard(text, fact, dateKey, maxHist);
                    if (r.added) {
                        text = r.text;
                        added++;
                        dropped += r.dropped;
                    }
                }
                if (added > 0) {
                    try {
                        atomicWrite(card.path, text);
                        totalCards++;
                        detail.push({ name, added, dropped });
                    }
                    catch (err) {
                        deps.logger?.warn?.(`[distill] 写卡失败（${name}）：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
        }
        return { ok: true, messages: totalMsgs, facts: totalFacts, cards: totalCards, detail };
    }
    catch (err) {
        return { ...empty, error: err instanceof Error ? err.message : String(err) };
    }
}
//# sourceMappingURL=distill.js.map