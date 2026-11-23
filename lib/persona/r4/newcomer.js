/**
 * R4.1 · 新人识别（2026-11-09 新增）
 *
 * ── 解决什么问题 ─────────────────────────────────────────────────────────────
 * 群里来了个只说过两句话的人，她的表现和老熟人一模一样：
 * 直接叫名字、接旧梗、用亲昵语气 —— 一眼假。
 * 数据层其实一直知道「这个人第一次出现是什么时候」（`firstMetAt`），
 * 只是**没有任何代码用它来调整语气**。
 *
 * ── 判据（全部本地、零 LLM、零新增 IO）───────────────────────────────────────
 * 命中新人 ⟺ 同时满足：
 *   ① `firstMetAt` 有值（真的观测过，不是"不知道"）
 *   ② 认识时长 < `NEWCOMER_DAYS`（默认 3 天）
 *   ③ 累计发言 < `NEWCOMER_MSGS`（默认 6 条）
 *
 * ③ 这条是关键兜底：老用户第一次上线时 `firstMetAt` 会被补成"首次观测时间"，
 * 导致**老用户被误判为新人**（`milestones.ts` 里已注明这个已知限制）。
 * 用「发言数」做双判据，老用户一说话就远超 6 条，立刻脱离新人态。
 *
 * ── 纪律（`开发规则`）────────────────────────────────────────────────────────
 *   · **纯函数**：无 IO、无 Date.now()、无随机源（`now` 一律入参）→ 可单测
 *   · **无魔法数字**：阈值全部来自 config
 *   · 任何异常/非法输入 → 返回 null（绝不抛、绝不误判）
 *   · 不做「欢迎新人」这种仪式（那是主动打扰）；只调整**语气分寸**
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 时间戳上限（ms）：约 2100 年，超出视为脏数据（与 `state.ts` 口径一致）。 */
const MAX_TS = 4_102_444_800_000;
function toTs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_TS)
        return 0;
    return Math.round(n);
}
function toCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return 0;
    return Math.floor(n);
}
/**
 * 判定是否新人（**纯函数**）。
 *
 * @returns 命中 → `{ daysKnown, messageCount }`；否则 `null`
 */
export function detectNewcomer(facts, cfg) {
    try {
        if (!cfg || cfg.enabled === false)
            return null;
        if (!facts || typeof facts !== 'object')
            return null;
        const now = toTs(facts.now);
        const firstMetAt = toTs(facts.firstMetAt);
        if (now <= 0 || firstMetAt <= 0)
            return null; // 不知道首次时间 → 绝不猜
        if (firstMetAt > now)
            return null; // 脏数据（未来时间）→ 不判
        const messageCount = toCount(facts.messageCount);
        const daysKnown = Math.floor((now - firstMetAt) / DAY_MS);
        const daysLimit = Math.max(1, Math.floor(Number(cfg.newcomerDays) || 3));
        const msgLimit = Math.max(1, Math.floor(Number(cfg.newcomerMaxMessages) || 6));
        // ① 认识太久 → 不是新人
        if (daysKnown >= daysLimit)
            return null;
        // ② 说得太多了 → 不是新人（老用户 firstMetAt 被补成"首次观测"时的兜底）
        if (messageCount >= msgLimit)
            return null;
        return { daysKnown, messageCount };
    }
    catch {
        return null; // 红线：绝不抛到调用方
    }
}
/**
 * 拼注入提示（**纯函数**）。
 *
 * 为什么是这个措辞：
 *   · 明确写「别装熟」是本条的唯一目的 —— 模型最容易犯的错是对谁都像老朋友
 *   · 不写「欢迎他」：那是主动开口，本模块的职责只是**给语气定分寸**，
 *     要不要打招呼由模型按当下语境自己决定（`milestones`/`inject` 的同类设计）
 *   · 提示里**不出现具体数字**（「认识 2 天」「说了 3 句」），
 *     否则模型可能把这些数字念出来变成播报（`milestones` 明确禁止等级播报）
 *
 * @returns 提示文本；不是新人 → 空串
 */
export function newcomerHintText(verdict) {
    if (!verdict)
        return '';
    return '[这个人刚到群里不久，别装熟]\n'
        + '他还没在这儿说过几句话。别用老熟人的口吻、不要叫亲昵称呼、'
        + '别提「上次」「之前说过的」，也不要主动播报「你才来几天」。'
        + '如果他主动聊起来，按普通群友的礼貌程度正常回应就行。';
}
/**
 * 新人识别诊断落盘（**节流**：同一人 5 分钟内只记一次，否则每条消息写一行会刷爆）。
 *
 * 为什么必须有：这条功能的价值在于「命中 vs 不命中」，而两者都是**静默的** ——
 * 不落盘就又一次分不清「功能没生效」和「今天确实没新人」。
 *
 * 纪律：诊断失败绝不影响主链（全包 try/catch）。
 */
const DIAG_LOG = 'newcomer.log';
const DIAG_ROTATE_BYTES = 256 * 1024;
const DIAG_THROTTLE_MS = 5 * 60 * 1000;
export function makeNewcomerDiag(deps) {
    const last = new Map();
    return (event, data) => {
        try {
            const key = String(data?.uid ?? '') || event;
            const sentinel = `${event}|${JSON.stringify(data)}`;
            const at = deps.now();
            const prev = last.get(key);
            if (prev && prev.sentinel === sentinel && at - prev.at < DIAG_THROTTLE_MS)
                return;
            if (last.size > 200) {
                let drop = Math.floor(last.size / 2);
                for (const k of last.keys()) {
                    if (drop-- <= 0)
                        break;
                    last.delete(k);
                }
            }
            last.set(key, { at, sentinel });
            mkdirSync(deps.dir, { recursive: true });
            const file = join(deps.dir, DIAG_LOG);
            try {
                if (statSync(file).size > DIAG_ROTATE_BYTES) {
                    try {
                        renameSync(file, `${file}.1`);
                    }
                    catch { /* ignore */ }
                }
            }
            catch { /* 文件不存在 → 不轮转 */ }
            appendFileSync(file, `${JSON.stringify({ at: new Date(at).toISOString(), event, ...data })}\n`, 'utf8');
        }
        catch { /* 诊断失败绝不影响主链 */ }
    };
}
