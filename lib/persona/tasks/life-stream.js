/**
 * tasks/life-stream — 碎片生活流任务（从 maintenance-tasks.ts 拆出，重构阶段 2）
 *
 * 为什么拆：`maintenance-tasks.ts` 已 1050 行、混杂 6 类职责。本模块只负责「生活流」。
 *
 * 🔴 本次是**逐字搬迁**（一字未改），只把闭包依赖显式化为 `deps` 参数。
 *    拆前/拆后必须：`pnpm build` 通过 + `test/run-life-stream.mjs` 85 条断言全绿。
 *
 * 依赖边界（原文件里的闭包 → 本文件的参数）：
 *   · `deps.config`      → 原 `config`（读 lifeStream* 与 timeZone）
 *   · `deps.qqbotDataRoot` → 原 `qqbotDataRoot`
 *   · `deps.logger`      → 原 `logger`
 */
import { resolveDataRoot } from '../../shared/paths.js';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { personaDataRoot } from '../r4/paths.js';
import { dayKeyOf, listHistorySessions, readRecentMessages } from '../r4/sample.js';
import { resolveTimeZone, zonedTime } from '../r4/time.js';
import { LIFE_STREAM_DEFAULTS, buildLifeStreamPrompt, clampLifeStreamConfig, decideLifeStream, slotLabelOf, } from '../r4/life-stream.js';
import { isMaterialUsed, markSpeaked, readLifeStreamState, resetIfNewDay, writeLifeStreamState, } from '../r4/life-stream-state.js';
import { ensureDailyMood, readAllCandidates } from '../r4/life-store.js';
import { slotOfHour } from '../r4/life-events.js';
/** tick 间隔（20 分钟判定一次）。 */
export const LIFE_STREAM_TICK_MS = 20 * 60 * 1000;
const LIFE_STREAM_OUTBOX = 'heartbeat-outbox';
const LIFE_STREAM_LOG = 'life-stream.log';
export function createLifeStreamTask(deps) {
    const config = deps.config;
    const qqbotDataRoot = deps.qqbotDataRoot;
    const logger = deps.logger ?? {};
    /** 生活流诊断落盘（独立文件，便于排查；超过 256KB 归一到 .1）。 */
    const lifeStreamDiag = (event, data) => {
        try {
            const dir = resolveDataRoot();
            mkdirSync(dir, { recursive: true });
            const file = join(dir, LIFE_STREAM_LOG);
            try {
                // 超 256KB 归一到 .1（复用现有 diag 的轮转思路）
                if (statSync(file).size > 256 * 1024) {
                    try {
                        renameSync(file, `${file}.1`);
                    }
                    catch { /* ignore */ }
                }
            }
            catch { /* 文件不存在或读不到 → 不轮转 */ }
            appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', 'utf8');
        }
        catch { /* ignore */ }
    };
    /** 读生活流配置（从 deps.config 的扩展字段，缺省走 LIFE_STREAM_DEFAULTS）。 */
    const lifeStreamConfigOf = () => {
        const raw = config ?? {};
        return clampLifeStreamConfig({
            enabled: raw.lifeStreamEnabled,
            dailyMax: raw.lifeStreamDailyMax,
            minGapMs: typeof raw.lifeStreamMinGapMin === 'number'
                ? raw.lifeStreamMinGapMin * 60_000
                : undefined,
            hoursFrom: raw.lifeStreamHoursFrom,
            hoursTo: raw.lifeStreamHoursTo,
        });
    };
    /** 取 qqbot 数据根（deps 已给，兜底用 env / 默认）。 */
    const lifeStreamQqbotRoot = () => String(qqbotDataRoot ?? '').trim();
    /**
     * 算「群里最近多久没说话了」（毫秒）。读不到 → `-1`（跳过活跃度闸门，不因此永久静音）。
     */
    const computeGroupIdleMs = (groupId, now) => {
        try {
            const msgs = readRecentMessages('group', groupId, {
                qqbotDataRoot: lifeStreamQqbotRoot(),
                root: personaDataRoot(),
                withinMs: LIFE_STREAM_DEFAULTS.deadWindowMs + 60 * 60 * 1000, // 多读 1 小时防边界
                now,
            });
            if (!msgs || msgs.length === 0)
                return -1;
            const last = msgs[msgs.length - 1];
            // `RecentlyMessage` 的时间字段是 `at`（毫秒），没有 timestamp
            const at = Number(last?.at ?? 0);
            if (!Number.isFinite(at) || at <= 0)
                return -1;
            return Math.max(0, now - at);
        }
        catch {
            return -1;
        }
    };
    /** 取最近几条群聊文本（仅作语感参考，prompt 里明令禁止接话）。 */
    const recentChatOf = (groupId, limit, now) => {
        try {
            const msgs = readRecentMessages('group', groupId, {
                qqbotDataRoot: lifeStreamQqbotRoot(),
                root: personaDataRoot(),
                withinMs: 2 * 60 * 60 * 1000,
                now,
            });
            return (msgs ?? [])
                .filter((m) => !m?.self)
                .slice(-limit)
                .map((m) => `${String(m?.senderName ?? m?.senderId ?? '')}: ${String(m?.text ?? '')}`)
                .join('\n')
                .trim();
        }
        catch {
            return '';
        }
    };
    /** 挑一个群（优先活跃群；无群则返回空）。 */
    const pickLifeStreamGroup = () => {
        try {
            const sessions = listHistorySessions(lifeStreamQqbotRoot(), logger);
            const groups = (sessions ?? []).filter((s) => s.scope === 'group' && s.peerId);
            if (!groups.length)
                return '';
            // 只取第一个（当前部署只有一个主群）；未来多群可加轮询
            return String(groups[0]?.peerId ?? '');
        }
        catch {
            return '';
        }
    };
    /** 写一条 outbox 消息（桥会消费）。返回是否写成功。 */
    const enqueueLifeStreamOutbox = (groupId, text, at) => {
        try {
            const dir = join(personaDataRoot(), 'state', LIFE_STREAM_OUTBOX);
            mkdirSync(dir, { recursive: true });
            const id = `ls-${at}-${Math.random().toString(36).slice(2, 8)}`;
            const payload = { id, groupId, text, wakePrompt: text, at, kind: 'life-stream' };
            const file = join(dir, `${id}.json`);
            const tmp = `${file}.tmp`;
            writeFileSync(tmp, JSON.stringify(payload), 'utf8');
            renameSync(tmp, file);
            return true;
        }
        catch (err) {
            lifeStreamDiag('send:write-fail', { err: String(err) });
            return false;
        }
    };
    /** 取生活痕迹配置（从 elysia.json 的 life_events 段；缺失走默认）。 */
    const lifeEventsConfigOf = () => {
        try {
            const cfgPath = join(personaDataRoot(), 'persona-configs', 'elysia.json');
            const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
            const le = raw?.life_events;
            if (le && typeof le === 'object')
                return le;
        }
        catch { /* ignore */ }
        return { enabled: false, events_dir: '', max_event_chars: 40, fallbacks: {} };
    };
    /**
     * 从素材库挑一条「未用过」的（当前时段优先，不够再跨时段）。
     *
     * 🔴 为什么需要它（2026-11-07 实测发现的设计缺陷）：
     *   每天只抽 4 条素材（每时段 1 条）。若一天都集中在同一个时段，
     *   该时段素材用过一次后就再也拿不到新的 → material-used 永久跳过 →
     *   配置的 dailyMax=3 实际只能兑现 1 次。
     *   本函数从**全量素材库**（当前时段 80 条 + 其它时段）里随机挑未用过的。
     *
     * 失败（文件读不到 / 全用过）→ 返回空串（调用方据此跳过本轮）。
     */
    const pickUnusedFromPool = (eventsCfg, slotId, used, hour, now) => {
        try {
            if (!eventsCfg?.enabled || !eventsCfg?.events_dir)
                return '';
            const all = readAllCandidates(eventsCfg, logger);
            const strip = (x) => String(x ?? '').trim().replace(/^[-*+]\s+/u, '').trim();
            // 当前时段优先，其次其它时段（保证语感贴当前时间）
            const own = Array.isArray(all[slotId ?? '']) ? all[slotId ?? ''] : [];
            const others = Object.entries(all)
                .filter(([k]) => k !== slotId)
                .flatMap(([, v]) => (Array.isArray(v) ? v : []));
            const usedSet = new Set(used.map(strip));
            const pickFresh = (list) => {
                const fresh = list.map(strip).filter((t) => t && !usedSet.has(t));
                if (!fresh.length)
                    return '';
                // 用时间做种子，保证「同一轮内确定性、跨轮次有变化」
                const seed = (now + hour * 37) % fresh.length;
                return fresh[seed] ?? fresh[0] ?? '';
            };
            return pickFresh(own) || pickFresh(others);
        }
        catch {
            return '';
        }
    };
    const run = async () => {
        try {
            const cfg = lifeStreamConfigOf();
            if (!cfg.enabled) {
                lifeStreamDiag('tick', { decision: 'disabled' });
                return;
            }
            const now = Date.now();
            const tz = resolveTimeZone(config?.timeZone);
            const today = dayKeyOf(now, tz);
            const hour = (() => {
                try {
                    return zonedTime(now, tz).hour;
                }
                catch {
                    return new Date(now).getHours();
                }
            })();
            const groupId = pickLifeStreamGroup();
            if (!groupId) {
                lifeStreamDiag('tick', { decision: 'no-group' });
                return;
            }
            const root = personaDataRoot();
            // ① 读状态 + 跨天重置
            const st = resetIfNewDay(readLifeStreamState(root, logger), today);
            // ② 取素材（复用现有抽卡：每天只抽一次，重启不丢）
            const mood = ensureDailyMood({
                root,
                today,
                now,
                random: Math.random,
                config: lifeEventsConfigOf(),
                logger,
            });
            const slot = slotOfHour(hour);
            // ⚠️ 素材文件是 markdown 列表（每条以「- 」开头），而 parseEventLines 不剥前缀。
            //   在**使用侧**清洗（不改 life-events.ts 的现有行为，那个模块有别的调用方）。
            const stripPrefix = (x) => String(x ?? '').trim().replace(/^[-*+]\s+/u, '').trim();
            // 🔴 2026-11-07 修「同一时段只能说一次」：
            //   原来只取「当前时段」抽中的那 1 条素材 → 用过一次后，该时段后续所有 tick 都会
            //   因 material-used 跳过（配置 dailyMax=3 实际只能兑现 1 次）。
            //   修法：**优先用当日抽中素材；若已用过，则从素材库随机挑一条未用过的**。
            //   这样同一天能真正说满 dailyMax 次，且不会重复。
            const eventsCfg = lifeEventsConfigOf();
            let material = stripPrefix(slot ? mood?.slots?.[slot.id] : '');
            let materialSource = 'daily-pick';
            if (!material || isMaterialUsed(st, material)) {
                const pool = pickUnusedFromPool(eventsCfg, slot?.id, st.usedMaterials, hour, now);
                if (pool) {
                    material = stripPrefix(pool);
                    materialSource = 'pool-fallback';
                }
            }
            // ③ 群活跃度
            const idleMs = computeGroupIdleMs(groupId, now);
            // ④ 判定
            const d = decideLifeStream({
                now,
                hour,
                todayCount: st.todayCount,
                lastAt: st.lastAt,
                groupIdleMs: idleMs,
                material,
                materialUsed: isMaterialUsed(st, material),
                config: cfg,
            });
            lifeStreamDiag('tick', {
                decision: d.ok ? 'go' : d.reason,
                todayCount: st.todayCount,
                idleSec: idleMs >= 0 ? Math.round(idleMs / 1000) : -1,
            });
            if (!d.ok)
                return;
            // ⑤ 生成 prompt（空 prompt = 不发，防脏数据）
            const prompt = buildLifeStreamPrompt({
                material: d.material,
                slotLabel: slotLabelOf(slot?.id),
                recentChat: recentChatOf(groupId, 5, now),
            });
            if (!prompt) {
                lifeStreamDiag('gen:skip', { reason: 'empty-prompt' });
                return;
            }
            // ⑥ ⚠️ 先原子写状态（**写失败就不发**，防重复）
            const next = markSpeaked(st, now, d.material);
            if (!writeLifeStreamState(next, root, logger)) {
                lifeStreamDiag('skip:write-fail', { material: d.material.slice(0, 30) });
                return;
            }
            // ⑦ 发出（写 outbox，桥消费）
            const okSend = enqueueLifeStreamOutbox(groupId, prompt, now);
            lifeStreamDiag(okSend ? 'send:ok' : 'send:fail', { material: d.material.slice(0, 30) });
            void materialSource;
        }
        catch (err) {
            lifeStreamDiag('fail', { err: String(err) });
            logger.warn?.(`[bnnbotbox] 生活流异常（已静默降级）：${err}`);
        }
    };
    return { run, tickMs: LIFE_STREAM_TICK_MS };
}
