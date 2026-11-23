/**
 * profile-utils — 人物画像的内部纯工具函数
 *
 * 从 `r4/profile.ts` 拆出（重构阶段 2 / 批次 B）。
 * 只被 `profile-extract.ts` / `profile-view.ts` 使用，**不对外导出**（门面不 re-export 本文件）。
 *
 * 纪律：全部是纯函数，不做 IO、不用 `Date.now()`、不用随机数。
 */
/** 字符数（按 Unicode 码点计，绕开 UTF-16 代理对误差）。 */
export function charLength(text) {
    return [...text].length;
}
/** 安全求最大值（**不用 spread**：timestamps 无上限，`Math.max(...arr)` 在大数组会爆栈）。 */
export function maxOf(values) {
    let max = 0;
    for (const v of values) {
        const n = Number(v);
        if (Number.isFinite(n) && n > max)
            max = n;
    }
    return max;
}
/**
 * 全角 ASCII（`\uFF01-\uFF5E`）→ 半角（`\u0021-\u007E`）；全角空格 `\u3000` → 半角空格。
 * 其余字符原样保留（中文汉字、全角标点外的符号不受影响）。
 */
export function toHalfWidth(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code >= 0xff01 && code <= 0xff5e) {
            out += String.fromCodePoint(code - 0xfee0);
        }
        else if (code === 0x3000) {
            out += ' ';
        }
        else {
            out += ch;
        }
    }
    return out;
}
/** 深拷贝画像事件文件（不原地改入参；逐字段原值搬移，不做类型转换）。 */
export function cloneEventsFile(events) {
    const source = events && Array.isArray(events.events) ? events.events : [];
    return {
        events: source.map((event) => ({
            tag: event.tag,
            category: event.category,
            timestamps: Array.isArray(event.timestamps) ? event.timestamps.slice() : [],
            // ★ 2026-11-04：permanent 必须参与深拷贝，否则写入盘会丢成 undefined。
            permanent: event.permanent === true,
        })),
    };
}
/** 深拷贝画像索引。 */
export function cloneIndex(index) {
    const out = {};
    if (!index || typeof index !== 'object')
        return out;
    for (const [userId, entry] of Object.entries(index)) {
        out[userId] = {
            lastMentionedTags: { ...(entry?.lastMentionedTags ?? {}) },
            coldStartUntil: Number(entry?.coldStartUntil ?? 0),
        };
    }
    return out;
}
/** 同义词回退：先精确查；未命中再按 `toLowerCase()` 遍历键做大小写不敏感命中。 */
export function lookupSynonym(normalized, synonyms) {
    const table = synonyms && typeof synonyms === 'object' ? synonyms : {};
    if (Object.prototype.hasOwnProperty.call(table, normalized)) {
        const mapped = table[normalized];
        if (typeof mapped === 'string')
            return mapped;
    }
    const target = normalized.toLowerCase();
    for (const key of Object.keys(table)) {
        if (key.toLowerCase() !== target)
            continue;
        const mapped = table[key];
        return typeof mapped === 'string' ? mapped : normalized;
    }
    return normalized;
}
/** 本地敏感词命中（等价于 dicts.ts 的 `hitWord`；值导入该模块在 Node 直跑 .ts 下不可解析）。 */
export function hitSensitiveWord(text, words) {
    const haystack = String(text ?? '');
    if (!haystack)
        return null;
    for (const word of words) {
        if (!word)
            continue;
        if (haystack.includes(word))
            return word;
    }
    return null;
}
