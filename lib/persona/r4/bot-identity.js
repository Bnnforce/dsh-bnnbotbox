/**
 * R4.0 · bot 自身身份解析（A 判定 `@bot` 需要 bot openid）。
 *
 * 问题（mod-heartbeat 提醒）：`hasSomeoneReplied` 的 A 条件需要 `<@botId>` 精确匹配；
 * `botId` 为空时它退化成「文本含 `<@`」，在真实群里会**偏松**（任何 @ 都算有人理）。
 *
 * 来源优先级：
 *   ① `{qqbotDataRoot}/.qqbot/bot-self.json` 的 `openid`（qqbot 自己缓存，最权威）；
 *   ② 从 msg-history 里「被 @ 次数最多、且从没以该 id 发过言」的 id 推断（启发式，带明显风险声明）。
 *
 * 纪律：只读、缓存 mtime、失败返回空串（调用方降级，绝不抛）。
 */
import { readFileSync, statSync } from 'node:fs';
import { writeTextAtomic } from '../../shared/atomic.js';
import { join } from 'node:path';
import { listHistorySessions, dayKeyOf } from './sample.js';
import { logInfo, logWarn } from './logger.js';
// ★ 2026-11-05 批次 D：一天毫秒数统一取 time.ts 的定义（原来这里内联 86_400_000）。
import { DAY_MS } from './time.js';
/** 推断用的「最近几天」文件数（2026-11-03 修复 P1-11：不再硬编码日期）。 */
const HISTORY_LOOKBACK_DAYS = 3;
/** 历史启发式的最低置信门槛（被 @ 次数）；与日志文案保持一致。 */
const MIN_MENTION_COUNT = 10;
/** 从 `bot-self.json` 读 bot openid（最权威来源）。 */
export function readBotSelfOpenid(qqbotDataRoot, logger) {
    try {
        const file = join(String(qqbotDataRoot ?? '').trim(), '.qqbot', 'bot-self.json');
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const openid = String(parsed?.openid ?? '').trim();
        if (openid && /^[0-9A-Za-z_-]{16,}$/u.test(openid))
            return openid;
    }
    catch { /* 缺失/损坏都正常 */ }
    return '';
}
/**
 * 从消息历史启发式推断 bot openid。
 *
 * 判据：在最近 N 天的历史里被 `@` 次数最多的 id，且**该 id 从未作为发送者出现**
 * （bot 自己发的消息 `s` 是 `self`，所以真人 id 若从没发过言就高度可疑……但反之亦然）。
 * 因此这个方法**只是尽力而为**，拿不准就返回空串（宁可不判，也不误判）。
 */
export function inferBotOpenidFromHistory(qqbotDataRoot, maxGroups = 3, logger) {
    try {
        const now = Date.now();
        // 2026-11-03 修复 P1-11：按**今天**倒推最近 N 天，不再硬编码 '2026-11-03.jsonl'。
        const days = [];
        for (let i = 0; i < HISTORY_LOOKBACK_DAYS; i += 1) {
            days.push(dayKeyOf(now - i * DAY_MS));
        }
        const groups = listHistorySessions(qqbotDataRoot, logger)
            .filter((s) => s.scope === 'group')
            .slice(0, maxGroups);
        const mentions = new Map();
        const senders = new Set();
        for (const g of groups) {
            const dir = join(String(qqbotDataRoot ?? '').trim(), '.qqbot', 'msg-history', `group_${g.peerId}`);
            let files = [];
            try {
                files = days.filter((f) => {
                    try {
                        return statSync(join(dir, `${f}.jsonl`)).isFile();
                    }
                    catch {
                        return false;
                    }
                });
            }
            catch {
                continue;
            }
            for (const f of files) {
                let raw = '';
                try {
                    raw = readFileSync(join(dir, `${f}.jsonl`), 'utf8');
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
                    const s = String(o.s ?? '').trim();
                    if (s && s !== 'self' && o.me !== true)
                        senders.add(s);
                    const text = String(o.x ?? '');
                    for (const m of text.matchAll(/<@([0-9A-Za-z_-]{16,})>/gu)) {
                        const id = m[1];
                        if (id && id !== 'all')
                            mentions.set(id, (mentions.get(id) ?? 0) + 1);
                    }
                }
            }
        }
        // 候选 = 被 @ 最多 且 从没发过言（bot 从不以自己的 id 出现在 `s`）
        const ranked = [...mentions.entries()]
            .filter(([id]) => !senders.has(id))
            .sort((a, b) => b[1] - a[1]);
        const best = ranked[0];
        if (!best)
            return '';
        // 置信度门槛（与日志/注释统一为一个常量）：至少要出现 MIN_MENTION_COUNT 次。
        if (best[1] < MIN_MENTION_COUNT)
            return '';
        logInfo(logger, `[r4] bot openid 由历史推断：…${best[0].slice(-6)}（被 @ ${best[1]} 次）`);
        return best[0];
    }
    catch (error) {
        logWarn(logger, `[r4] bot openid 推断失败（已忽略）：${error instanceof Error ? error.message : String(error)}`);
        return '';
    }
}
/** 综合解析：先权威文件，再启发式。带短缓存（避免每次 tick 都扫盘）。 */
export function resolveBotOpenid(qqbotDataRoot, logger) {
    const fromFile = readBotSelfOpenid(qqbotDataRoot, logger);
    if (fromFile)
        return fromFile;
    return inferBotOpenidFromHistory(qqbotDataRoot, 3, logger);
}
/**
 * 带持久缓存的解析：把结果写进 `{PERSONA_DATA_ROOT}/state/bot-identity.json`，
 * 避免每次心跳都扫盘；也允许**人工修正**（写入该文件的 `openid` 字段即生效，优先级最高）。
 */
export function resolveBotOpenidCached(input) {
    const { qqbotDataRoot, root, logger } = input;
    const cachePath = join(root, 'state', 'bot-identity.json');
    // ① 人工修正优先
    try {
        const manual = JSON.parse(readFileSync(cachePath, 'utf8'));
        const id = String(manual?.openid ?? '').trim();
        if (manual?.manual === true && id)
            return id;
    }
    catch { /* 不存在就继续 */ }
    // ② bot-self.json（qqbot 权威，但当前版本不写 openid）
    const fromFile = readBotSelfOpenid(qqbotDataRoot, logger);
    if (fromFile)
        return fromFile;
    // ③ 历史启发式 + 落缓存
    const inferred = inferBotOpenidFromHistory(qqbotDataRoot, 3, logger);
    if (inferred) {
        try {
            writeTextAtomic(cachePath, `${JSON.stringify({ openid: inferred, inferredAt: Date.now(), manual: false }, null, 2)}\n`, logger);
        }
        catch { /* ignore */ }
        return inferred;
    }
    try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        return String(cached?.openid ?? '').trim();
    }
    catch {
        return '';
    }
}
