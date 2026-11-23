/**
 * R4.0 采样层（阶段一基建）：把 QQBot 的落盘台账读成各模块能吃的 `RecentlyMessage[]`。
 *
 * 数据源（只读，不改 qqbot 任何文件）：
 *   `{QQBOT_DATA_ROOT}/.qqbot/msg-history/{group_|c2c_}<peer>/YYYY-MM-DD.jsonl`
 *   一行一条：`{"id","s","n","t","k","x","me"?}`
 *     · `s` = 发送者 openid（机器人自己 = "self"）、`n` 昵称、`t` 毫秒、`x` 正文、`me`=机器人自己
 *
 * 纪律：
 *  - 只读；任何读失败都降级为空数组 + warn，**绝不抛顶层**；
 *  - **不读图片**（图纸 3.1：画像提取「不读图片、不读视觉内容」）—— 非 text 类型（k≠'text'）整条跳过；
 *  - 正文剥离插件注入块（`【…】` 与 `[rf:…]`），并剔除 `★主人` 前缀的**保留价值判断交给调用方**
 *    （这里只做清洗，不做画像/心跳的业务过滤）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logWarn } from './logger.js';
import { sanitizeId } from './paths.js';
import { resolveTimeZone, dayKeyOf as timeDayKeyOf } from './time.js';
// ★ 2026-11-05 批次 D：与 analyzer.ts 共用同一个注入块正则（见 src/patterns.ts）。
import { INJECTED_TAIL_MARKER as INJECTED_TAIL_RE } from '../patterns.js';
/** 清洗：去掉主人标记、@ 前缀、注入块标记，并**从第一个已知注入标记截到结尾**（那一段是插件写的提示词）。 */
export function cleanMessageText(input) {
    let text = String(input ?? '')
        .replace(/^★主人\s*/u, '')
        .replace(/<@[^>]+>/gu, '')
        .replace(/\[rf:[^\]]+\]/giu, '');
    const at = INJECTED_TAIL_RE.exec(text);
    if (at)
        text = text.slice(0, at.index);
    return text
        .replace(/【[^】]*】/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
/** 单条原始行 → RecentlyMessage；无法识别返回 null。 */
export function toMessage(raw) {
    if (typeof raw !== 'object' || raw === null)
        return null;
    const o = raw;
    const kind = String(o.k ?? 'text');
    if (kind !== 'text')
        return null; // 不读图片/语音/文件
    const at = Number(o.t);
    if (!Number.isFinite(at) || at <= 0)
        return null;
    const rawText = String(o.x ?? '');
    const text = cleanMessageText(rawText);
    if (!text)
        return null;
    const senderId = String(o.s ?? '').trim();
    if (!senderId)
        return null;
    const self = o.me === true || senderId === 'self';
    // @ 标记必须在清洗前从原文里取（`cleanMessageText` 会剥掉 `<@…>`）。
    const mentioned = extractMentions(rawText);
    return {
        senderId,
        senderName: String(o.n ?? '').trim(),
        text,
        at,
        self,
        msgId: o.id === undefined || o.id === null ? undefined : String(o.id),
        mentioned: mentioned.ids,
        mentionAll: mentioned.all,
        mentionedBot: false,
        quoteOfSelf: false,
    };
}
/** 从**原始**正文里抽出 `<@openid>` 列表与是否 `@all`（不抛）。 */
export function extractMentions(rawText) {
    const s = String(rawText ?? '');
    const ids = [];
    let all = false;
    try {
        for (const m of s.matchAll(/<@([^>\s]+)>/gu)) {
            const id = String(m[1] ?? '').trim();
            if (!id)
                continue;
            if (id === 'all' || id === 'everyone') {
                all = true;
                continue;
            }
            if (ids.includes(id))
                continue;
            ids.push(id);
        }
    }
    catch {
        return { ids: [], all: false };
    }
    return { ids, all };
}
/**
 * 按毫秒时间戳解析「本地自然日」（默认 Asia/Shanghai）。
 *
 * 2026-11-03 修复（R4 体检 P1-4）：**永不抛错**。
 * 非法时区 / 非法时间戳 → 回退 `Asia/Shanghai` 再算，仍失败则回退 UTC 分解。
 *
 * ★ 2026-11-05（重构任务 A）：**实现改为复用 `time.ts` 的共享缓存**，
 *   不再自己 `new Intl.DateTimeFormat('en-CA')`。
 *   刻意保留一个**旧行为**：`ms` 非法时原实现回退 `Date.now()`（不是 0），
 *   否则「传了个坏时间戳」会突然变成 1970 —— 这是可观测的行为变化。
 */
export function dayKeyOf(ms, timeZone = 'Asia/Shanghai') {
    const raw = Number(ms);
    const at = Number.isFinite(raw) ? raw : Date.now();
    if (Number.isNaN(new Date(at).getTime()))
        return '1970-01-01';
    return timeDayKeyOf(at, resolveTimeZone(timeZone));
}
/** 某会话目录的历史根：`{qqbotDataRoot}/.qqbot/msg-history`。 */
export function historyRootOf(qqbotDataRoot) {
    return join(String(qqbotDataRoot ?? '').trim(), '.qqbot', 'msg-history');
}
/**
 * R4 **全量群消息台账**目录：`{PERSONA_DATA_ROOT}/state/r4-group-history/`。
 *
 * 2026-11-04 新增：QQBot 的 msg-history 只记「走到 handleInbound 的消息」，
 * 而 debounce 会把「没 @她、也没叫名字」的群消息攒在窗口里不派发
 * （`gateway/debounce.js:364`）→ 这些消息**永不入台账**。
 * 后果：R4 用 msg-history 做死群判定，群里明明在聊却读到空 → 误判死群 → 跳过心跳。
 *
 * 扩展包 `inbound/r4-full-history.mjs` 挂在 debounce **之前**的 onInbound 扩展点，
 * 把每条群消息都追加到这里。本模块**优先读这个台账**，读不到再回落 msg-history。
 */
export function fullHistoryDir(root) {
    return join(String(root ?? '').trim(), 'state', 'r4-group-history');
}
/** 会话目录名：`group_<gid>` / `c2c_<openid>`。 */
export function sessionDirName(scope, peerId) {
    return `${scope}_${peerId}`;
}
/**
 * 从「全量台账」读某群最近 N 分钟的消息（正序）。
 * 台账结构与 msg-history 的 jsonl 行兼容（`{t,s,n,x,k,me}`），另带 `v:` 版本标记。
 * @returns 正序数组；台账目录不存在 → 空数组（由调用方回落 msg-history）
 */
function readFullHistory(peerId, root, cutoff, now, maxFiles) {
    const dir = join(fullHistoryDir(root), peerId);
    let files = [];
    try {
        files = readdirSync(dir)
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(f))
            .sort()
            .slice(-maxFiles);
    }
    catch {
        return { messages: [], found: false }; // 目录不存在 = 该扩展没装/还没产生消息
    }
    const out = [];
    for (const file of files) {
        const path = join(dir, file);
        let raw = '';
        try {
            if (statSync(path).size > 8 * 1024 * 1024)
                continue;
            raw = readFileSync(path, 'utf8');
        }
        catch {
            continue;
        }
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const msg = toMessage(parsed);
            if (!msg)
                continue;
            if (msg.at < cutoff || msg.at > now)
                continue;
            out.push(msg);
        }
    }
    // 同一秒内可能重复（扩展与 msg-history 双写时）；按 at+发送者+正文去重
    const seen = new Set();
    const deduped = out.filter((m) => {
        const k = `${m.at}|${m.senderId}|${m.text}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
    deduped.sort((a, b) => a.at - b.at);
    return { messages: deduped, found: files.length > 0 };
}
/**
 * 读某个群/私聊「最近 N 分钟」的消息（正序返回）。
 *
 * **数据源优先级（2026-11-04 新增）**：
 *   ① `{PERSONA_DATA_ROOT}/state/r4-group-history/<gid>/`（全量台账，扩展包写入，**群消息全覆盖**）
 *   ② `{qqbotDataRoot}/.qqbot/msg-history/group_<gid>/`（QQBot 原生台账，仅"触发类"消息）
 * 优先①能拿到群里所有闲聊；①不可用时自动回落②，行为与旧版一致。
 *
 * @param scope      通道（c2c 不走全量台账，保持原行为）
 * @param peerId     群 openid / 用户 openid（会被 sanitize；非法返回空数组）
 * @param opts.qqbotDataRoot 数据根
 * @param opts.root           PERSONA_DATA_ROOT（全量台账位置；缺省不启用①）
 * @param opts.withinMs      时间窗（默认 30 分钟）
 * @param opts.now           当前时间（测试注入）
 * @param opts.maxFiles      最多扫几个日期文件（默认 2，够覆盖跨 0 点的 30 分钟窗）
 * @returns 正序消息数组（`at` 升序、同 ts 保持文件内顺序）
 */
export function readRecentMessages(scope, peerId, opts) {
    const id = sanitizeId(peerId);
    if (!id) {
        logWarn(opts.logger, `[r4] 采样：peerId 非法（${String(peerId ?? '').slice(0, 20)}）→ 返回空`);
        return [];
    }
    const now = opts.now ?? Date.now();
    const withinMs = Math.max(1, opts.withinMs ?? 30 * 60 * 1000);
    const cutoff = now - withinMs;
    const maxFiles = Math.max(1, opts.maxFiles ?? 2);
    // ① 全量台账（群消息全覆盖）——仅在群会话且给了 root 时尝试
    if (scope === 'group' && opts.root) {
        const full = readFullHistory(id, opts.root, cutoff, now, maxFiles);
        if (full.found && full.messages.length > 0)
            return full.messages;
        // found 但窗口内为空 → 说明确实没消息，直接返回空（不必再看②）
        if (full.found)
            return [];
    }
    const root = historyRootOf(opts.qqbotDataRoot);
    const dir = join(root, sessionDirName(scope, id));
    let files = [];
    try {
        files = readdirSync(dir)
            .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(f))
            .sort()
            .slice(-maxFiles);
    }
    catch {
        // 会话目录不存在 = 该群还没产生过消息：安静返回（不 warn，避免刷屏）
        return [];
    }
    const out = [];
    for (const file of files) {
        const path = join(dir, file);
        let raw = '';
        try {
            // 防单日文件过大：先看大小，超过 8MB 只 warn 并跳过（正常一天远小于此）
            if (statSync(path).size > 8 * 1024 * 1024) {
                logWarn(opts.logger, `[r4] 采样：${file} 超过 8MB，跳过（避免拖慢主链）`);
                continue;
            }
            raw = readFileSync(path, 'utf8');
        }
        catch (error) {
            logWarn(opts.logger, `[r4] 采样：读 ${file} 失败（已跳过）：${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const msg = toMessage(parsed);
            if (!msg)
                continue;
            if (msg.at < cutoff || msg.at > now)
                continue;
            out.push(msg);
        }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
}
/** 列出全部有历史的会话（group 优先）。**只用于诊断/批量遍历**（例如按群跑心跳）。 */
export function listHistorySessions(qqbotDataRoot, logger) {
    const root = historyRootOf(qqbotDataRoot);
    let names = [];
    try {
        names = readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (name.startsWith('group_')) {
            const peerId = sanitizeId(name.slice('group_'.length));
            if (peerId)
                out.push({ scope: 'group', peerId });
        }
        else if (name.startsWith('c2c_')) {
            const peerId = sanitizeId(name.slice('c2c_'.length));
            if (peerId)
                out.push({ scope: 'c2c', peerId });
        }
    }
    return out.sort((a, b) => (a.scope === b.scope ? a.peerId.localeCompare(b.peerId) : a.scope === 'group' ? -1 : 1));
}
/** 最近的 bots 自己消息（`self=true`），供「有人回复」判定用。 */
export function lastSelfMessageAt(messages) {
    let at = 0;
    for (const m of messages)
        if (m.self && m.at > at)
            at = m.at;
    return at;
}
