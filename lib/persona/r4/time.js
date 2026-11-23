/**
 * R4.0 模块一：时间感知与作息映射。
 *
 * 图纸依据（方案.txt 模块一 + 1.1「sleep_start/end 说明」）：
 *  - 注入格式 `[当前时间：YYYY-MM-DD HH:00，<时段描述>]`，**分钟恒为 00（整点截断）**；
 *  - 六段半开区间文案逐字固定，**不可自由发挥一个字**；
 *  - 边界：`02:00` 归装死、`06:00` 归清晨、`23:00` 归深夜；
 *  - 凌晨装死窗口**固定 02:00-06:00（含 02:00，不含 06:00）**，
 *    `sleep_start/sleep_end` 只做一致性校验，**运行逻辑永远用固定窗口，绝不读取配置值**
 *    （避免配置值与六段映射打架）；
 *  - 时区 `Asia/Shanghai`，**必须用 `Intl.DateTimeFormat` 的 `timeZone` 选项**取分量，
 *    不得用 `getHours()`（Android 系统时区未必是 +8）。
 *
 * 纪律：
 *  - 本文件**纯函数、无 IO、无 import 其它模块、永不抛错**（全部出口都包 try-catch）；
 *  - 不 import contracts.ts（图纸 0.1 纪律：模块之间只许共享 types/logger），
 *    `ZonedTime` 在本文件内联定义，结构与 contracts.ts 的 `ZonedTime` **逐字一致**。
 */
/** 默认时区（图纸 0.5：全局时区 Asia/Shanghai）。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
/**
 * 一天的毫秒数（2026-11-05 批次 D 统一到本文件）。
 *
 * 原先三处各写一份：`relationship.ts` 的 `MS_PER_DAY`、`profile.ts` 的 `DAY_MS`、
 * `bot-identity.ts` 的内联 `86_400_000`。物理常量不该有多个真相来源。
 */
export const DAY_MS = 86_400_000;
/**
 * 校验时区串是否可用（`Intl` 能构造即视为合法）。
 *
 * 2026-11-03 修复（R4 体检 P1-4）：`config.timezone` 最终只允许落到能被 Intl 接受的值，
 * 否则一律回退 `Asia/Shanghai`（**运行逻辑固定 +8**，与装死窗口/关系衰减同一基准）。
 * 纯函数、不抛错。
 */
export function isValidTimeZone(timeZone) {
    const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
    if (!tz)
        return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 归一化时区：合法则原样返回（trim 后），非法/空 → `DEFAULT_TIME_ZONE`。
 * `unknown` 也照收（配置可能是数字/null），永不抛错。
 */
export function resolveTimeZone(timeZone) {
    const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
    return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}
/** 固定装死窗口（含开始、不含结束）：02:00-06:00。运行逻辑只用这个常量。 */
export const SLEEP_WINDOW = { startHour: 2, endHour: 6 };
/** 装死放行时追加的状态文案（图纸模块一，逐字）。 */
const SLEEP_WOKE_TEXT = '[状态：熟睡被吵醒，语气朦胧]';
/** `Intl.DateTimeFormat` 缓存（构造较贵；纯内存，不影响纯函数语义）。 */
const FORMATTER_CACHE = new Map();
/** 两位补零。 */
function pad2(n) {
    return n < 10 ? `0${n}` : String(n);
}
/**
 * 取指定时区的格式化器；非法时区返回 undefined（不抛错）。
 * 用 `hourCycle: 'h23'` 保证 00-23（避免 12 小时制把午夜格式化成 12:00）。
 */
function getFormatter(timeZone) {
    const cached = FORMATTER_CACHE.get(timeZone);
    if (cached !== undefined)
        return cached ?? undefined;
    let formatter;
    try {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            // ★ 2026-11-05（重构任务 A）：多取一个 second，
            //   让 scheduler 的「距下个 HH:MM 还有多久」、relationship 的「墙上时间差」
            //   都能复用这一份缓存，不再各自 new Intl.DateTimeFormat。
            second: '2-digit',
        });
    }
    catch {
        // 非法时区（RangeError 等）→ 交给调用方降级，不抛。
        formatter = undefined;
    }
    FORMATTER_CACHE.set(timeZone, formatter ?? null);
    return formatter;
}
/** `utcFallback` 只告警一次（避免刷屏；这是「静默偏 8 小时」的唯一可观测点）。 */
let warnedUtcFallback = false;
/** 供测试/诊断读取：是否发生过 UTC 兜底降级（2026-11-03 R-7 修复）。 */
export function hasUtcFallbackHappened() {
    return warnedUtcFallback;
}
/**
 * 最后兜底：按 UTC 分解分量（**不用 getHours**，不依赖系统时区）。
 * 仅在「时区串非法且 Asia/Shanghai 也不可用」时才会走到（实测不会发生）。
 *
 * 2026-11-03（R-7）：这是**静默错误**——整体时间会偏 8 小时，而图纸要求
 * 「跨天/装死窗口以 Asia/Shanghai 为准」。现在降级时用 `console.warn` 打一次，
 * 让线上能发现「Intl 时区数据缺失」这种环境问题，而不是闷声算错。
 */
function utcFallback(at) {
    if (!warnedUtcFallback) {
        warnedUtcFallback = true;
        try {
            console.warn('[r4] Intl 时区不可用，已降级为 UTC 分解 —— 时间会与 Asia/Shanghai 相差 8 小时，请检查运行环境的 ICU/时区数据');
        }
        catch { /* 打日志失败也不抛 */ }
    }
    const d = new Date(at);
    return {
        date: `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
        at,
    };
}
/**
 * 取指定时区（默认 Asia/Shanghai）的本地时间分量，**不依赖系统 TZ**。
 * 纯函数、无 IO、不抛错：非法时间戳按 0 处理，非法时区回退 Asia/Shanghai。
 */
export function zonedTime(nowMs, timeZone = DEFAULT_TIME_ZONE) {
    const at = Number.isFinite(nowMs) ? nowMs : 0;
    const requested = resolveTimeZone(timeZone);
    const formatter = getFormatter(requested) ?? getFormatter(DEFAULT_TIME_ZONE);
    if (!formatter)
        return utcFallback(at);
    try {
        const parts = formatter.formatToParts(new Date(at));
        let year = '';
        let month = '';
        let day = '';
        let hour = -1;
        let minute = -1;
        let second = 0;
        for (const part of parts) {
            if (part.type === 'year')
                year = part.value;
            else if (part.type === 'month')
                month = part.value;
            else if (part.type === 'day')
                day = part.value;
            else if (part.type === 'hour')
                hour = Number(part.value);
            else if (part.type === 'minute')
                minute = Number(part.value);
            else if (part.type === 'second')
                second = Number(part.value);
        }
        if (!year || !month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) {
            return utcFallback(at);
        }
        // `hourCycle: 'h23'` 正常给 00-23；个别实现给 24 时归一为 0（同日零点）。
        const hour24 = hour === 24 ? 0 : hour;
        if (hour24 < 0 || hour24 > 23 || minute < 0 || minute > 59)
            return utcFallback(at);
        if (!Number.isInteger(second) || second < 0 || second > 59)
            second = 0;
        return {
            date: `${year.padStart(4, '0')}-${pad2(Number(month))}-${pad2(Number(day))}`,
            hour: hour24,
            minute,
            second,
            at,
        };
    }
    catch {
        return utcFallback(at);
    }
}
/**
 * ★ 2026-11-05（重构任务 A）：**统一的「本地自然日键」**，取代三处各自实现。
 *
 * 原先三份重复：
 *   · `r4/relationship.ts` 的 `dayKey()`  —— 自带 FORMATTERS 缓存
 *   · `r4/sample.ts` 的 `dayKeyOf()`       —— 自带 en-CA 格式化
 *   · `r4/index.ts` 用 `dayKeyOf` 做跨天判据
 * 现在全部走这里，共享 `time.ts` 的 `FORMATTER_CACHE`。
 *
 * 语义与旧实现**逐字一致**：`YYYY-MM-DD`；非法值 → `1970-01-01`（绝不抛）。
 * （`zonedTime` 本身就有「非法时区回退 Asia/Shanghai、再不行回退 UTC」的降级链。）
 */
export function dayKeyOf(ms, timeZone = DEFAULT_TIME_ZONE) {
    const at = Number.isFinite(Number(ms)) ? Number(ms) : 0;
    if (Number.isNaN(new Date(at).getTime()))
        return '1970-01-01';
    return zonedTime(at, timeZone).date;
}
/**
 * ★ 2026-11-05（重构任务 A）：**当天已过秒数**（0..86399）。
 *
 * 用途：`scheduler.ts` 算「距下一个 `HH:MM` 还有多久」——
 * 原来是 `hour*3600 + minute*60 + second`，需要 `second` 字段；
 * 现在 `zonedTime` 已提供，调用方不再自己造格式化器。
 */
export function secondsOfDay(nowMs, timeZone = DEFAULT_TIME_ZONE) {
    const t = zonedTime(nowMs, timeZone);
    return t.hour * 3600 + t.minute * 60 + t.second;
}
/**
 * 是否处于装死窗口（含 02:00，不含 06:00）。
 * **固定窗口，不读任何配置**（图纸 1.1：配置仅告警）。
 */
export function isSleepWindow(hour) {
    if (!Number.isFinite(hour))
        return false;
    return hour >= SLEEP_WINDOW.startHour && hour < SLEEP_WINDOW.endHour;
}
/**
 * 六段注入文本之一（完整文本，含方括号与全角标点）。
 * `hour` 落在 `[2,6)`（装死窗口）时返回空串，由调用方按装死逻辑处理。
 *
 * 时间串 `YYYY-MM-DD HH:00`：**分钟恒为 `00`**（图纸：整点截断）。
 */
export function timeBlockText(t) {
    if (!t || !Number.isFinite(t.hour))
        return '';
    // 日期串不合法（空/非 `YYYY-MM-DD`）→ 空串（宁可不注入也不注入畸形文本）。
    if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date))
        return '';
    const hour = t.hour;
    if (isSleepWindow(hour))
        return '';
    const stamp = `${t.date} ${pad2(hour)}:00`;
    if (hour >= 6 && hour < 9) {
        return `[当前时间：${stamp}，清晨。你刚醒，慵懒但充满朝气。]`;
    }
    if (hour >= 9 && hour < 12) {
        return `[当前时间：${stamp}，上午。你精力充沛，喜欢调侃。]`;
    }
    if (hour >= 12 && hour < 15) {
        return `[当前时间：${stamp}，午后。你在晒太阳，犯困，慢条斯理。]`;
    }
    if (hour >= 15 && hour < 18) {
        return `[当前时间：${stamp}，傍晚。你在打扮赴宴，自信自恋。]`;
    }
    if (hour >= 18 && hour < 23) {
        return `[当前时间：${stamp}，夜晚。你最兴奋，活跃开玩笑。]`;
    }
    // 23:00-02:00（跨日）：23 点与 0、1 点。
    if (hour >= 23 || hour < 2) {
        return `[当前时间：${stamp}，深夜。你心防微开，温柔轻柔。]`;
    }
    return '';
}
/** 装死放行时追加的状态文案（逐字，图纸模块一）。 */
export function sleepWokeText() {
    return SLEEP_WOKE_TEXT;
}
/** 安全取字符串（配置可能缺字段/类型不对，读错也不抛）。 */
function safeStr(value) {
    if (typeof value === 'string')
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return '';
}
/**
 * 作息配置一致性校验（**只校验、不参与运行逻辑**）：
 * `sleep_start/sleep_end` 不等于 `02:00/06:00` 时返回一条中文 warning；
 * 相等返回 `[]`。
 *
 * 图纸 1.1：实际装死窗口**固定为 02:00-06:00**，运行逻辑**永远不读取配置值**，
 * 配置只做一致性告警，避免与六段映射打架。返回的字符串只供调用方 `logger.warn`。
 */
export function validateSleepConfig(timeConfig) {
    const start = safeStr(timeConfig?.sleep_start);
    const end = safeStr(timeConfig?.sleep_end);
    if (start === '02:00' && end === '06:00')
        return [];
    return [
        `[r4] sleep_start/end 与固定装死窗口不一致（${start || '空'}-${end || '空'}）`
            + ' → 运行逻辑仍用 02:00-06:00，配置仅告警（不参与判定）',
    ];
}
/** 概率钳制到 [0,1]；`NaN`/非数字 → 默认 0.7（图纸默认 wake_probability）。 */
function clampProbability(wakeProbability) {
    if (!Number.isFinite(wakeProbability)) {
        // NaN / Infinity / 非数字：Infinity 按 1，-Infinity 按 0，其余（含 NaN）按默认 0.7。
        if (wakeProbability === Infinity)
            return 1;
        if (wakeProbability === -Infinity)
            return 0;
        return 0.7;
    }
    return Math.max(0, Math.min(1, wakeProbability));
}
/**
 * 装死随机判定：`random()` 返回值 `< wakeProbability` → true（放行），否则 false（静默丢弃）。
 * 概率先钳到 `[0,1]`，`NaN` → 按 0.7。
 * 边界语义（图纸模块一）：`wake_probability=0` 全丢弃（`0 < 0` 为 false，正确）、`=1` 全放行。
 * 纯函数、不抛错：`random` 缺失/抛错/返回非数字 → 一律按丢弃（不误放行）。
 */
export function shouldWake(wakeProbability, random) {
    const probability = clampProbability(typeof wakeProbability === 'number' ? wakeProbability : 0.7);
    let roll;
    try {
        roll = typeof random === 'function' ? Number(random()) : Number.NaN;
    }
    catch {
        roll = Number.NaN;
    }
    if (!Number.isFinite(roll))
        return false;
    return roll < probability;
}
