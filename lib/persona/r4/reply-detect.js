/**
 * R4.0 模块二 · 「有人回复」判定（图纸 2.2，逐字实现）。
 *
 * ```text
 * 有人回复 = A 或 B 或 C：
 * A. 消息 @bot；
 * B. 消息引用 bot 消息；
 * C. bot 最后一条消息后 window_minutes（10 分钟）内的【首条非 bot 消息】，且满足任一：
 *    - 命中 reply_detection.keywords；
 *    - 命中 reply_detection.question_regex（默认 /([?？]|[吗呢][?？])$/）。
 *
 * 边界：
 * - 只取 bot 最后消息后的首条非 bot 消息，只判一次；
 * - 单字“吗/呢/吧”结尾不算疑问标记；
 * - 任意群消息、非首条消息、超窗消息都不算“有人理”。
 * ```
 *
 * 纪律：纯函数、无 IO、永不抛错（正则/输入坏 → 按「不算」处理）。
 */
/** 定位 bot 最后一条消息的下标（没有则 -1）。 */
export function indexOfLastSelf(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (m && m.self === true)
            return i;
    }
    return -1;
}
/** 取 bot 最后一条消息之后的第一条非 bot 消息（只取一条，不再往后找）。 */
export function firstNonSelfAfter(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const idx = indexOfLastSelf(list);
    if (idx < 0)
        return { message: undefined, deltaMs: -1 };
    const last = list[idx];
    const lastAt = Number(last?.at ?? 0);
    for (let i = idx + 1; i < list.length; i += 1) {
        const m = list[i];
        if (!m || m.self === true)
            continue;
        // 只取首条：命中即返回（图纸「只判一次」）
        return { message: m, deltaMs: Number(m.at ?? 0) - lastAt };
    }
    return { message: undefined, deltaMs: -1 };
}
/**
 * ★ 2026-11-05 修复（P1：C 条件恒 false）：不依赖 `messages` 里的 self 消息，
 * 按**时间基准** `sinceAt` 取「之后的第一条非 bot 消息」。
 *
 * 为什么需要新函数：采样层装了全量台账后直接返回台账（`sample.ts` 台账只写入站
 * `me:false`，**没有 bot 自己的消息**）→ `indexOfLastSelf` 恒 -1 →
 * 原来的 `firstNonSelfAfter` 永远拿不到候选 ⇒ C 条件恒 false。
 * 时间基准改由心跳状态 `state.lastBotMessageAt` 提供后，这里只按时间扫描。
 *
 * - `sinceAt <= 0`（未知）→ 返回 undefined（无基准 = 不判定，保守）；
 * - 只取时间上**最早**的一条非 bot 消息（乱序入参也稳，不依赖数组有序）；
 * - 消息 `at` 非正/非法 → 跳过；永不抛错。
 */
export function firstNonSelfAtOrAfter(messages, sinceAt) {
    try {
        const list = Array.isArray(messages) ? messages : [];
        const since = Number(sinceAt) || 0;
        if (since <= 0)
            return undefined;
        let best;
        let bestAt = Number.POSITIVE_INFINITY;
        for (const m of list) {
            if (!m || m.self === true)
                continue;
            const at = Number(m.at ?? 0);
            if (!Number.isFinite(at) || at <= 0)
                continue;
            if (at < since)
                continue;
            if (at < bestAt) {
                best = m;
                bestAt = at;
            }
        }
        return best;
    }
    catch {
        return undefined;
    }
}
/** 单字结尾（吗/呢/吧）不算疑问标记（图纸边界）。 */
const SINGLE_PARTICLE_RE = /^[吗呢吧]\s*$/u;
/** 关键词命中。 */
export function hitKeyword(text, keywords) {
    const t = String(text ?? '');
    if (!t)
        return null;
    for (const word of Array.isArray(keywords) ? keywords : []) {
        const k = String(word ?? '');
        if (k && t.includes(k))
            return k;
    }
    return null;
}
/** 疑问正则命中（正则编译失败 → 视为不命中，不抛）。 */
export function hitQuestionRegex(text, source) {
    const t = String(text ?? '').trim();
    if (!t)
        return false;
    if (SINGLE_PARTICLE_RE.test(t))
        return false;
    try {
        const re = new RegExp(String(source ?? ''), 'u');
        return re.test(t);
    }
    catch {
        return false;
    }
}
/**
 * C 条件是否成立（对**首条非 bot 消息**做关键词/疑问判定）。
 * @returns 命中原因（诊断用）；null = 不成立。
 */
export function matchesC(text, replyDetection) {
    const keyword = hitKeyword(text, replyDetection?.keywords ?? []);
    if (keyword)
        return `关键词「${keyword}」`;
    if (hitQuestionRegex(text, replyDetection?.question_regex ?? ''))
        return '疑问句';
    return null;
}
/**
 * 完整判定（A 或 B 或 C）。
 *
 * **2026-11-03 修复（R4 体检 P1-1 / P1-2）**：A/B 原先扫「全部 messages」（实际 30 分钟），
 * 与 waiting 的 15 分钟窗口错配 → 心跳前 25 分钟有人 @、之后 15 分钟无人理，
 * 仍会被判「有人回复」，导致 waiting 提前解除、下一 tick 重复发送。
 * 现在 A/B/C **统一以 `sinceAt` 为下界**（调用方传 waiting 起点，即 `waitingUntil - 15min`）：
 *  - A @bot：文本里出现 `<@botId>`（采样层保留的 `mentioned` 原话）或 `mentionedBot === true`；
 *  - B 引用 bot：`quoteOfSelf === true`；
 *  - C 首条非 bot 消息 + 关键词/疑问，且落在 bot 最后消息后 `window_minutes` 内。
 * 只判一次（首条非 bot），不因为后续消息改变结论。
 *
 * **2026-11-05 修复（P1：C 条件恒 false）**：C 的「bot 上次说话时间」不再**依赖**
 * `messages` 里的 `self` 消息 —— 采样层装了全量台账后直接返回台账（只写入站
 * `me:false`，没有 bot 自己的消息），`indexOfLastSelf` 恒 -1 ⇒ C 恒不成立。
 * 现在基准 = `max(state.lastBotMessageAt, messages 里最后一条 self 的 at)`：
 *  - `state.lastBotMessageAt` 由心跳状态机在**发送时**写入，不依赖采样层 → 主路径；
 *  - messages 里有 self 时仍参与取较晚者 → 向后兼容（旧测试/旧数据行为不变）。
 * 之后取该时间点之后的**首条**非 bot 消息做关键词/疑问判定（窗口仍按 `window_minutes`）。
 *
 * @param input.state     心跳状态（`lastBotMessageAt` = bot 上次说话时间的主依据）
 * @param input.messages  已按时间正序的消息（`self=true` = bot 自己；可为空/无 self）
 * @param input.botId     bot 的 openid（A 判定用；空则只看 `mentionedBot` 标记）
 * @param input.sinceAt   下界时间戳（**可选**，缺省 = bot 最后一条消息时间；0 = 不限）
 * @param input.now       当前时间
 */
export function hasSomeoneReplied(input) {
    try {
        const list = (Array.isArray(input.messages) ? input.messages : []);
        const detection = input.replyDetection ?? { window_minutes: 10, keywords: [], question_regex: '' };
        const botId = String(input.botId ?? '').trim();
        const now = Number(input.now) || 0;
        // 下界：显式 sinceAt 优先；否则用 bot 最后一条消息的时间（0 = 不限）。
        const idxLast = indexOfLastSelf(list);
        const lastSelfAt = idxLast >= 0 ? Number(list[idxLast]?.at ?? 0) : 0;
        const explicitSince = Number(input.sinceAt);
        const sinceAt = Number.isFinite(explicitSince) && explicitSince > 0
            ? explicitSince
            : (lastSelfAt > 0 ? lastSelfAt : 0);
        const inScope = (m) => {
            if (!m || m.self === true)
                return false;
            const at = Number(m.at ?? 0);
            if (sinceAt > 0 && at < sinceAt)
                return false;
            if (now > 0 && at > now)
                return false; // 未来时间戳一律不算
            return true;
        };
        // ── A：消息 @bot ──
        if (botId) {
            for (const m of list) {
                if (!inScope(m))
                    continue;
                // ① 采样层保留的原始 @ 列表（最可靠）
                if (Array.isArray(m.mentioned) && m.mentioned.includes(botId))
                    return true;
                // ② 原始文本里直接出现 `<@botId>`（上游可能没走采样层）
                if (String(m.text ?? '').includes(`<@${botId}>`))
                    return true;
                // ③ 调用方已算好的标记
                if (m.mentionedBot === true)
                    return true;
            }
        }
        else {
            for (const m of list) {
                if (inScope(m) && m.mentionedBot === true)
                    return true;
            }
        }
        // ── B：消息引用 bot 消息 ──
        for (const m of list) {
            if (inScope(m) && m.quoteOfSelf === true)
                return true;
        }
        // ── C：bot 上次说话之后的【首条非 bot 消息】，窗口内且命中关键词/疑问 ──
        //
        // ★ 2026-11-05 修复（P1）：基准优先用 `state.lastBotMessageAt`。
        //   旧实现写成 `if (idxLast < 0) return false` —— 全量台账里没有 bot 消息时
        //   这一行直接让 C 恒 false，普通接话（"哈哈""真的吗"）永远不算「有人回复」。
        //   现在：
        //     · state.lastBotMessageAt —— 心跳发送时写入，**不依赖采样台账**（主路径）；
        //     · messages 里最后一条 self 的 at —— 有就取较晚者（补充证据，向后兼容）；
        //     · 两者都为 0 = 从没说过话 → C 不成立（保守）。
        const stateBotAt = Number(input.state?.lastBotMessageAt) || 0;
        const baseAt = Math.max(stateBotAt > 0 ? stateBotAt : 0, lastSelfAt > 0 ? lastSelfAt : 0);
        if (!(baseAt > 0))
            return false; // 从没发过 → C 不成立
        const windowMs = Math.max(0, Number(detection.window_minutes) || 10) * 60 * 1000;
        const candidate = firstNonSelfAtOrAfter(list, baseAt);
        if (!candidate)
            return false;
        const at = Number(candidate.at ?? 0);
        if (!at)
            return false;
        if (now > 0 && at > now)
            return false; // 未来时间戳不算
        if (at - baseAt > windowMs)
            return false; // 超窗不算
        if (matchesC(String(candidate.text ?? ''), detection))
            return true;
        // 首条不命中 → 后面的消息也不算（图纸：任意群消息、非首条消息都不算“有人理”）
        return false;
    }
    catch {
        return false;
    }
}
/** 诊断：C 候选的定位情况（测试/日志用）。 */
export function describeReplyCandidate(messages, replyDetection) {
    try {
        const list = (Array.isArray(messages) ? messages : []);
        const found = firstNonSelfAfter(list);
        const windowMs = Math.max(0, Number(replyDetection?.window_minutes) || 10) * 60 * 1000;
        if (!found.message)
            return { deltaMs: found.deltaMs, inWindow: false };
        const deltaMs = found.deltaMs;
        return { message: found.message, deltaMs, inWindow: deltaMs <= windowMs };
    }
    catch {
        return { deltaMs: -1, inWindow: false };
    }
}
/** 时间字段更新语义（图纸 2.3）：返回「是否该更新 lastNonBotMessageAt」。 */
export function shouldUpdateLastNonBot(input) {
    // 收到任意非 bot 消息 → 更新；凌晨被丢弃的消息**仍然更新**（由调用方在执行丢弃前调用本函数）
    return Boolean(input.message) && input.message.self !== true;
}
