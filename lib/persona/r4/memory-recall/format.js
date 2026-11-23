/**
 * 记忆联想 · 格式化层（**纯函数**）
 *
 * 纪律（`开发规则` 四.1 / `审查标准` 二）：
 *   · 无 IO、无 Date.now()、无随机源 → 全部入参
 *   · 无魔法数字 → 阈值全部来自 config
 *   · 便于单测：所有分支都能用纯输入触发
 */
/** 注入正文的标题行。 */
export const RECALL_HEADER = '[你记得的事（供参考，不要逐条复述）]';
/** 注入正文的约束行（与标题一起构成固定骨架）。 */
export const RECALL_FOOTER = '（只有当话题确实相关时才自然带出。不要念清单，不要说「我记得你说过」。）';
/** 标题、空行、约束之间的固定换行数（\n + \n + \n）。 */
const RECALL_JOIN_CHARS = 3;
/** 固定骨架占用的字符数（不计入正文预算）。 */
export const RECALL_SKELETON_CHARS = charLen(RECALL_HEADER) + charLen(RECALL_FOOTER) + RECALL_JOIN_CHARS;
/**
 * 按优先级裁剪并拼装。
 *
 * 优先级（`开发规则` 五.3 严格半开区间）：**人物 > 群 > 事件**
 * —— 说话人本人的档案永远最相关。
 *
 * ⚠️ 超预算时**整条丢弃**（不截半句）—— 与现有 `EXTRA_BUDGET` 的行为一致，
 *   避免出现「半句话」这种更糟的输出。
 */
export function formatRecall(items, budget) {
    const total = Math.max(0, Math.floor(Number(budget?.totalChars) || 0));
    const perItem = Math.max(0, Math.floor(Number(budget?.perItemChars) || 0));
    /**
     * ★ 2026-11-08（自检修正，第三次定稿）：
     *
     * `totalChars` 是**最终注入文本的硬上限（含标题/约束骨架）**。
     * 骨架固定占 `RECALL_SKELETON_CHARS`（58 字），正文只能吃剩下的。
     *
     * 为什么最终选这个语义（而不是「正文预算」）：
     *   外层 `r4/inject.ts` 还有一道 `MEMORY_RECALL_BUDGET` 兜底硬切
     *   （`if (charLen(raw) > budget) clipByLen(...)`）。
     *   如果本函数按「正文预算」输出 220 正文 + 58 骨架 = 278，
     *   外层就会把尾部（约束句）切掉 → 注入变成半句话，比少注入更糟。
     *   **所以本函数必须对总长负责**，让外层兜底永远不触发。
     *
     * 与之配套：配置默认 `budgetChars` 由 220 调至 **280**
     *   （= 正文 222 + 骨架 58），这样 人物100 + 群50 + 事件70 = 220 仍装得下，
     *   方案文档的分项设计不被破坏。改的是「总预算」而不是「分项」。
     */
    const bodyBudget = total - RECALL_SKELETON_CHARS;
    if (total <= 0 || bodyBudget <= 0 || !Array.isArray(items) || items.length === 0) {
        return { text: '', used: 0, dropped: [] };
    }
    // ① 按优先级稳定排序（同 kind 内保持原顺序）
    const ORDER = { person: 0, group: 1, event: 2 };
    const sorted = items
        .filter((it) => it && typeof it.text === 'string')
        .map((it, i) => ({ it, i, w: ORDER[it.kind] ?? 9 }))
        .sort((a, b) => (a.w !== b.w ? a.w - b.w : a.i - b.i))
        .map((x) => x.it);
    // ② 逐条尝试加入（超 perItem 或 total 就丢）
    const kept = [];
    const dropped = [];
    let used = 0;
    for (const it of sorted) {
        const line = `· ${String(it.text ?? '').trim()}`;
        if (!line || line === '· ')
            continue;
        const lineLen = charLen(line);
        // 单条超限 → 丢（调用方应先截断；这里兜底）
        if (perItem > 0 && charLen(String(it.text ?? '').trim()) > perItem) {
            dropped.push(it);
            continue;
        }
        // 加换行后的总长
        const addLen = lineLen + (kept.length > 0 ? 1 : 0);
        if (used + addLen > bodyBudget) {
            dropped.push(it);
            continue;
        }
        kept.push(line);
        used += addLen;
    }
    if (!kept.length)
        return { text: '', used: 0, dropped };
    // ③ 加标题与约束（固定骨架，已在预算里扣掉）
    const body = kept.join('\n');
    const text = [RECALL_HEADER, body, '', RECALL_FOOTER].join('\n');
    return { text, used: charLen(text), dropped };
}
/** 字符长度：按码点数，避免 emoji 被算成 2。 */
export function charLen(input) {
    const s = String(input ?? '');
    if (!s)
        return 0;
    let n = 0;
    for (const _ of s)
        n += 1; // eslint-disable-line @typescript-eslint/no-unused-vars
    return n;
}
/**
 * 截断到 `max` 字符（按码点，不切半个 emoji）。
 * 返回的字符串**不含省略号**（由调用方决定是否加）。
 */
export function clipText(input, max) {
    const s = String(input ?? '').replace(/\s+/gu, ' ').trim();
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (!s || limit <= 0)
        return '';
    if (charLen(s) <= limit)
        return s;
    let out = '';
    let n = 0;
    for (const ch of s) {
        if (n >= limit)
            break;
        out += ch;
        n += 1;
    }
    return out;
}
/**
 * 按**分号/句号**整段截断（避免切在句子中间）。
 *
 * 为什么需要它（2026-11-08 实测）：
 *   直接 `clipText` 会在 50 字处硬切，把「已知成员：a、b、c、三...」切成半个名字，
 *   注入后读起来像断句错误。按分隔符截断则保证**不出现半句**。
 *
 * @returns 截断后的文本；若第一段就超限 → 返回该段但不切（宁可略超也不切半句）
 */
export function clipBySegment(input, max, sep = '；') {
    const s0 = String(input ?? '').replace(/\s+/gu, ' ').trim();
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (!s0 || limit <= 0)
        return '';
    if (charLen(s0) <= limit)
        return s0;
    const parts = s0.split(sep);
    let out = '';
    for (const part of parts) {
        const next = out ? `${out}${sep}${part}` : part;
        if (charLen(next) > limit)
            break;
        out = next;
    }
    // 一段都放不下 → 保守截断（不能返回空）
    return out || clipText(parts[0] ?? '', limit);
}
/**
 * 从一份 markdown 档案里抽取「Current」段落作为可注入摘要。
 *
 * 记忆文件格式（实测）：
 * ```
 * # 群成员-群友A
 *
 * ## Current
 * - 群成员：群友A；openid：xxx。
 * - 备注：会直接调侃 bot。
 *
 * ## History
 * ## Related
 * ```
 *
 * 只取 `## Current` 到下一个 `## ` 之间的内容 —— History 段太长且价值低。
 *
 * @returns 摘要文本（可能含多行 `- `，调用方自行 clip）；无 Current 段 → 空串
 */
export function extractCurrentSection(markdown) {
    const md = String(markdown ?? '');
    if (!md)
        return '';
    // 定位 `## Current`（大小写不敏感，允许前后空白）
    const startMatch = /^\s*##\s*Current\s*$/imu.exec(md);
    if (!startMatch)
        return '';
    const from = startMatch.index + startMatch[0].length;
    // 找下一个 `## `
    const nextMatch = /\n##\s+/u.exec(md.slice(from));
    const seg = (nextMatch ? md.slice(from, from + nextMatch.index) : md.slice(from)).trim();
    if (!seg)
        return '';
    // 去掉每条前面的 `- `，用「；」连起来（更紧凑）
    //
    // ⚠️ 2026-11-08 实测发现：直接拼会给注入文本带进**机械噪音**：
    //   `群成员：群友A；openid：FADE0001...；群：示例群（FADE0002...）；生日见 events/birthdays/...`
    //   这些「openid / 群号全称 / 文件路径 / 生日见 xxx」对说话毫无用处，只是占预算。
    //   所以在抽取阶段就**逐条清洗**：命中噪音模式的整条丢弃，其余去前缀。
    const NOISE_PATTERNS = [
        /^(?:群\s*)?(?:group\s+)?openid\s*[：:]/iu, // 「openid：xxx」/「group openid：xxx」/「群 openid：xxx」
        /^群\s*[：:].*[（(][A-Za-z0-9]{8,}[）)]/u, // 「群：xxx（群号）」
        /^生日见\s+/u, // 「生日见 events/...」
        /^\s*events\//iu, // 裸路径
        /^[A-Za-z0-9_-]{16,}\s*$/u, // 裸 openid（无前缀）
    ];
    const lines = seg
        .split(/\r?\n/u)
        .map((l) => l.replace(/^\s*[-*+]\s+/u, '').trim())
        // ★ 2026-11-08：正文里可能二次转义了 markdown 结构（实测 events/group/ 的事件文件）
        //   形如 `# 群事件-生日接龙`、`## Current`、`## History` —— 对注入毫无价值，只占预算。
        .filter((l) => !/^#{1,6}\s*/u.test(l))
        .filter((l) => !/^Current$/iu.test(l))
        // 二次转义：正文本身是 markdown 列表时，剥完结构标记还会剩一层 「- 」
        .map((l) => l.replace(/^\s*[-*+]\s+/u, '').trim())
        .filter(Boolean)
        // ① 整条噪声 → 丢
        .filter((l) => !NOISE_PATTERNS.some((re) => re.test(l)))
        // ② 行内夹带噪声时做局部剔除（如「群成员：群友A；openid：xxx。」→「群成员：群友A」）
        .map((l) => l
        .replace(/[；;]\s*(?:群\s*)?(?:group\s+)?openid\s*[：:]\s*[A-Za-z0-9_-]{8,}/giu, '')
        .replace(/[；;]\s*群\s*[：:][^；;]*[（(][A-Za-z0-9]{8,}[）)]/gu, '')
        .replace(/[；;]\s*生日见\s+events\/[^；;]*/giu, '')
        .replace(/[；;]\s*$/u, '')
        .trim())
        // ③ 行尾标点归一：去掉「。」这类句末标点，避免拼出「群友A。；备注」
        .map((l) => l.replace(/[。，,、]+$/u, '').trim())
        .filter(Boolean);
    return lines.join('；');
}
/**
 * 从档案正文里抽取 openid（用于「userId → 档案」的匹配）。
 *
 * 实测格式：`- 群成员：<昵称>；openid：<32位openid>。`
 *
 * @returns 大写的 openid；匹配不到 → 空串（调用方据此跳过，绝不猜）
 */
export function extractOpenid(markdown) {
    const md = String(markdown ?? '');
    if (!md)
        return '';
    // 允许全角/半角冒号，允许 openid 与值之间有空格
    const m = /openid\s*[：:]\s*([A-Za-z0-9_-]{8,64})/iu.exec(md);
    return m && typeof m[1] === 'string' ? m[1].toUpperCase() : '';
}
