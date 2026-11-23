import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
// ★ 2026-11-05 批次 D：与 r4/sample.ts 共用同一个注入块正则（见 src/patterns.ts）。
import { INJECTED_TAIL_MARKER } from './patterns.js';
const MAX_MESSAGE_LENGTH = 120;
const PUNCT_END = /[。！？!?…~～]$/u;
const URL_RE = /https?:\/\/|mqqapi:\/\/|www\./iu;
/** 主人身份标记（扩展包 owner-tag 写在正文最前）——主人消息不进「群友语感」语料。 */
const OWNER_TAG = /^★主人/u;
/**
 * **清洗之后**仍残留的注入块标记。cleanText() 会剥掉 `<@…>`、`【…】`、`[rf:…]` 和前导 `[…]`，
 * 这里兜住位置/形态漏网的注入提示（例如正文尾部残留的 `[附近图片…]`）。
 */
const INJECTED_RESIDUE = /【[^】]*】|\[附近图片/u;
/**
 * 插件注入的**提示块**：标记只占一对【】，真正的长段提示正文跟在其后（没有括号包裹），
 * 例如 `<@all> 黑潮爆破一缺4 【心情·只读】本群当前心情：平静（0/100）。本轮请先在内心…`。
 * 这类块都是**追加在用户正文之后**的，所以从标记出现处直接截到结尾。
 * 2026-11-01 第二次修（实测 collectGroupMessages groups:0）：第一版只判标记、没剥尾部正文，
 * 剥掉【心情·只读】后仍剩下 100+ 字提示词 → 被 MAX_MESSAGE_LENGTH/长度过滤整条丢弃。
 *
 * ★ 2026-11-05 批次 D：正则本体已移到 `src/patterns.ts`（与 r4/sample.ts 共用），
 *   本文件只从那里 import，不再自己保留一份拷贝。
 */
const PURE_NON_TEXT = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\p{N}\s]+$/u;
/** 常见语气词；V2 用于密度与常见语气词统计。 */
const FILLER_WORDS = [
    '啊', '呢', '吧', '嘛', '捏', '呀', '哦', '喔', '诶', '哎', '唉', '哈', '嘿', '哼',
    '嗯', '啦', '咯', '嘞', '嗷', '呜', '喵',
];
/**
 * 本地停用词库：代词、泛化动词、聊天套话、常见指令词。
 * 高频词提纯时先剔掉这些，避免生成“这个、那个、就是”这种没有语感的词。
 */
const STOP_WORDS = new Set([
    '这个', '那个', '什么', '就是', '不是', '可以', '一个', '没有', '我们', '你们',
    '他们', '现在', '还是', '真的', '然后', '因为', '所以', '如果', '但是', '已经',
    '自己', '知道', '觉得', '今天', '明天', '昨天', '时候', '东西', '事情', '问题',
    '感觉', '有点', '应该', '可能', '怎么', '为什么', '怎么样', '是不是', '有没有',
    '好吧', '好的', '行吧', '谢谢', '大家', '有人', '没人', '一下', '一直', '一起',
    '这里', '那里', '上面', '下面', '出来', '进去', '过来', '回去', '开始', '结束',
]);
/** 常见指令词：来自 QQ 群活动/机器人命令，不应被当成“群友口癖”。 */
const COMMAND_WORDS = [
    '接龙', '打卡', '签到', '报名', '抽奖', '投票', '提醒', '查询', '来张图',
    '今日', '生日', '群主', '管理', '机器人', '公告', '群规', '禁言', '踢人',
];
/** 只用于过滤高频词；不输出、不记录原文。 */
const DIRTY_WORDS = [
    '傻逼', '傻b', '煞笔', '沙比', '草泥马', '操你妈', '操你', '他妈的',
    '妈的', '你妈', '尼玛', '卧槽', '我操', '滚蛋', '去死', '死全家',
    'sb', 'cnm', 'nmsl',
];
export function expandHome(input) {
    const s = String(input || '').trim();
    if (s === '~')
        return homedir();
    if (s.startsWith('~/'))
        return join(homedir(), s.slice(2));
    return s;
}
/** 把用户配置的 dataRoot 统一成“包含 group_* 的 msg-history 目录”。 */
export function historyRootsOf(input) {
    const p = expandHome(input);
    if (!p)
        return [];
    if (p.endsWith('.qqbot/msg-history') || p.endsWith('msg-history'))
        return [p];
    if (p.endsWith('.qqbot'))
        return [join(p, 'msg-history')];
    return [join(p, '.qqbot', 'msg-history')];
}
/** 从 DSH 的 qqbot-settings 文件里发现 dataRoot；不写死任何设备路径。 */
export function discoverQqbotDataRoots() {
    const out = new Set();
    const settingsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qqbot-settings');
    try {
        for (const ns of readdirSync(settingsRoot, { withFileTypes: true })) {
            if (!ns.isDirectory())
                continue;
            const dir = join(settingsRoot, ns.name);
            let files = [];
            try {
                files = readdirSync(dir).filter((f) => f.endsWith('.json'));
            }
            catch {
                continue;
            }
            for (const f of files) {
                try {
                    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
                    if (typeof j.dataRoot === 'string' && j.dataRoot.trim())
                        out.add(j.dataRoot.trim());
                }
                catch { /* skip bad settings */ }
            }
        }
    }
    catch { /* no settings dir */ }
    return [...out];
}
function cleanText(input) {
    let text = String(input ?? '');
    text = text
        .replace(/^★主人\s*/u, '')
        .replace(/<@[^>]+>/gu, '')
        .replace(/^\[[^\]]+\]\s*/u, '')
        .replace(/^\[[^\]]*\([^)]*\)[^\]]*\]\s*/u, '')
        .replace(/【[^】]*】/gu, '')
        .replace(/\[rf:[^\]]+\]/giu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    return text;
}
/**
 * 砍掉插件追加的提示块正文（见 INJECTED_TAIL_MARKER 注释）：从第一个已知注入标记截到结尾。
 * 用户正文里如果自己打了同名标记（anti-spoof 会把它们改写成「（群友自填）…」），不匹配本正则。
 */
function stripInjectedTail(input) {
    const m = INJECTED_TAIL_MARKER.exec(input);
    return m ? input.slice(0, m.index) : input;
}
function acceptable(text) {
    if (!text)
        return false;
    if (text.length >= MAX_MESSAGE_LENGTH)
        return false;
    if (URL_RE.test(text))
        return false;
    // QQ 群里的系统指令/接龙，不是真人聊天语料。
    if (text.startsWith('/') || text.startsWith('／') || text.startsWith('#'))
        return false;
    if (PURE_NON_TEXT.test(text))
        return false;
    return /[\u4e00-\u9fa5A-Za-z0-9]/u.test(text);
}
const STOP_SUBSTRINGS = [...STOP_WORDS].filter((word) => word.length >= 2);
function forbiddenPhrase(text) {
    if (STOP_WORDS.has(text))
        return true;
    // 2~3 字 n-gram 可能只包含停用词的一部分，例如“这个周末”；这类也剔掉。
    if (STOP_SUBSTRINGS.some((word) => text.includes(word)))
        return true;
    if (COMMAND_WORDS.some((word) => text.includes(word)))
        return true;
    if (DIRTY_WORDS.some((word) => text.includes(word)))
        return true;
    return false;
}
function phrasesOf(text) {
    const han = text.replace(/[^\u4e00-\u9fa5]/gu, '');
    const out = [];
    for (let n = 2; n <= 3; n += 1) {
        for (let i = 0; i + n <= han.length; i += 1)
            out.push(han.slice(i, i + n));
    }
    return out;
}
function countOf(haystack, needle) {
    if (!needle)
        return 0;
    let count = 0;
    let from = 0;
    while (true) {
        const at = haystack.indexOf(needle, from);
        if (at === -1)
            return count;
        count += 1;
        from = at + needle.length;
    }
}
/**
 * 只分析**一个群**的消息。V2 的采集层按群隔离，调用方不要把多个群混在一起传进来。
 */
export function analyzeMessages(messages) {
    const texts = messages.map((m) => m.text).filter(acceptable);
    const count = texts.length;
    if (count === 0) {
        return {
            count: 0,
            avgLength: 0,
            shortRate: 0,
            punctuationRate: 0,
            exclamationRate: 0,
            questionRate: 0,
            fillerDensity: 0,
            topFillers: [],
            topPhrases: [],
            guideline: '',
        };
    }
    const total = texts.reduce((n, t) => n + [...t].length, 0);
    const short = texts.filter((t) => [...t].length <= 5).length;
    const punct = texts.filter((t) => PUNCT_END.test(t)).length;
    const exclaim = texts.filter((t) => /[!！]/u.test(t)).length;
    const question = texts.filter((t) => /[?？]/u.test(t)).length;
    const fillerCounts = new Map();
    let fillerTotal = 0;
    for (const text of texts) {
        for (const filler of FILLER_WORDS) {
            const n = countOf(text, filler);
            if (n <= 0)
                continue;
            fillerTotal += n;
            fillerCounts.set(filler, (fillerCounts.get(filler) ?? 0) + n);
        }
    }
    const topFillers = [...fillerCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .slice(0, 3)
        .map(([word]) => word);
    const freq = new Map();
    for (const text of texts) {
        for (const p of phrasesOf(text)) {
            if (forbiddenPhrase(p))
                continue;
            freq.set(p, (freq.get(p) ?? 0) + 1);
        }
    }
    // 只保留出现 >= 2 次的真实重复词，取前 3；不强制模型照搬。
    const topPhrases = [...freq.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .slice(0, 3)
        .map(([p]) => p);
    const avgLength = Math.round(total / count);
    const shortRate = Math.round((short / count) * 100);
    const punctuationRate = Math.round((punct / count) * 100);
    const exclamationRate = Math.round((exclaim / count) * 100);
    const questionRate = Math.round((question / count) * 100);
    const fillerDensity = Math.round((fillerTotal / Math.max(1, total)) * 100 * 10) / 10;
    const fillerLine = topFillers.length
        ? `常见语气词：${topFillers.map((w) => `“${w}”`).join('、')}。`
        : '没有特别明显的语气词。';
    const phraseLine = topPhrases.length
        ? `可以参考群友常用词：${topPhrases.map((p) => `“${p}”`).join('、')}（仅供参考，不必硬套）。`
        : '没有明显高频词，按自然口语回复就好。';
    const guideline = [
        '【本群语感参考】',
        `本群平均发言约 ${avgLength} 字，5 字以内短句约占 ${shortRate}%。`,
        `句末带标点约 ${punctuationRate}%，叹号出现约 ${exclamationRate}%，问号约 ${questionRate}%。`,
        `语气词密度约 ${fillerDensity.toFixed(1)} 个/百字，${fillerLine}`,
        phraseLine,
    ].join('\n');
    return {
        count,
        avgLength,
        shortRate,
        punctuationRate,
        exclamationRate,
        questionRate,
        fillerDensity,
        topFillers,
        topPhrases,
        guideline,
    };
}
function recentDateFile(name, maxDays) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/u.exec(name);
    if (!m)
        return false;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return day >= today.getTime() - (maxDays - 1) * 86400000;
}
/**
 * V2：按群采集。返回的每个 GroupSamples 只包含该群自己的消息；
 * 不把 group_* 混成一个大池子。
 */
export async function collectGroupMessages(dataRoot, maxDays, options = {}) {
    const configured = historyRootsOf(dataRoot);
    const discovered = discoverQqbotDataRoots().flatMap(historyRootsOf);
    const roots = [...new Set([...configured, ...discovered])];
    const byGroup = new Map();
    const seen = new Set();
    let scannedFiles = 0;
    for (const root of roots) {
        let dirs = [];
        try {
            dirs = (await readdir(root, { withFileTypes: true }))
                .filter((d) => d.isDirectory() && d.name.startsWith('group_'))
                .map((d) => join(root, d.name));
        }
        catch {
            continue;
        }
        for (const dir of dirs) {
            const dirName = basename(dir);
            const groupId = dirName.replace(/^group_/u, '');
            if (!groupId)
                continue;
            if (options.onlyGroupId && groupId !== options.onlyGroupId)
                continue;
            let files = [];
            try {
                files = (await readdir(dir)).filter((f) => recentDateFile(f, maxDays));
            }
            catch {
                continue;
            }
            for (const file of files) {
                scannedFiles += 1;
                let raw = '';
                try {
                    raw = await readFile(join(dir, file), 'utf8');
                }
                catch {
                    continue;
                }
                for (const line of raw.split('\n')) {
                    if (!line.trim())
                        continue;
                    let o;
                    try {
                        o = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    const rawText = String(o.x ?? '');
                    if (o.me === true || o.s === 'self' || o.n === '机器人')
                        continue;
                    // 2026-11-01 修（guideline 零产出）：旧实现拿**原始文本**判注入标记，而 QQBot 落盘的历史
                    // 正文里已经拼进了【心情·只读】【识图】等注入块 ⇒ 每条真人消息都被整条丢弃，
                    // `guidelines/` 目录永远不会生成。正确顺序：
                    //   ① 主人标记判原文前缀（★主人 在正文最前，cleanText 会剥掉它）；
                    //   ② 注入块交给 cleanText() 剥除，剥完还有残留标记才丢弃。
                    if (OWNER_TAG.test(rawText))
                        continue;
                    const text = cleanText(stripInjectedTail(rawText));
                    if (INJECTED_RESIDUE.test(text))
                        continue;
                    if (!acceptable(text))
                        continue;
                    const id = String(o.id || `${dir}:${file}:${text}`);
                    const dedupeKey = `${groupId}:${id}`;
                    if (seen.has(dedupeKey))
                        continue;
                    seen.add(dedupeKey);
                    const bucket = byGroup.get(groupId) ?? [];
                    bucket.push({ id, text });
                    byGroup.set(groupId, bucket);
                }
            }
        }
    }
    const groups = [...byGroup.entries()]
        .map(([groupId, messages]) => ({ groupId, messages }))
        .sort((a, b) => a.groupId.localeCompare(b.groupId));
    return { groups, roots, scannedFiles };
}
export function debugRoots() {
    return [...historyRootsOf('~/.dsh-qqbot'), ...discoverQqbotDataRoots().flatMap(historyRootsOf)]
        .filter((r, i, a) => a.indexOf(r) === i && existsSync(r));
}
