import z from '@deepseek-ai/schemastery';
/** 用户可在 DSH 设置面板直接编辑的配置。 */
export const Config = z.object({
    enabled: z.boolean().default(true).volatile(),
    qqbotDataRoot: z.string().default('~/.dsh-qqbot').volatile(),
    analysisIntervalMin: z.number().min(1).default(60).volatile(),
    maxHistoryDays: z.number().min(1).max(90).default(7).volatile(),
    reviewEnabled: z.boolean().default(true).volatile(),
    reviewProvider: z.string().default('').volatile(),
    reviewModel: z.string().default('').volatile(),
    reviewHour: z.number().min(0).max(23).default(4).volatile(),
    autoJudgeEnabled: z.boolean().default(true).volatile(),
    autoJudgeRate: z.number().min(0).max(1).default(1).volatile(),
    autoJudgeMinLength: z.number().min(0).default(15).volatile(),
    // ── 碎片生活流（2026-11-07 新增）──────────────────────────────────────
    // 「主动开口」的总开关与节律。解决「96% 被动回应，仅 4% 主动开口」。
    // ⚠️ 全部 .volatile()：schemastery 的 volatile 字段必须 .get() 取值
    //   （见下方 unwrap 的注释；直接读属性会拿到 {} 包装对象）。
    /** 总开关。关掉 = 完全不判定、不生成、不发送（紧急停止用）。 */
    lifeStreamEnabled: z.boolean().default(true).volatile(),
    /** 每天最多主动开口几次（硬夹到 1..3，配大了也夹住）。 */
    lifeStreamDailyMax: z.number().min(1).max(3).default(3).volatile(),
    /** 两次开口之间的最小间隔（分钟，硬夹到 30..720）。 */
    lifeStreamMinGapMin: z.number().min(30).max(720).default(90).volatile(),
    /** 允许开口的起始小时（含），0-23。 */
    lifeStreamHoursFrom: z.number().min(0).max(23).default(8).volatile(),
    /** 允许开口的结束小时（不含），1-24。 */
    lifeStreamHoursTo: z.number().min(1).max(24).default(24).volatile(),
    // ── 记忆联想化 · 第一层「被动联想」（2026-11-08 新增）──────────────────
    // 每轮 assemble 从 dsh-qq-memory 取人物卡/群卡摘要注入 prompt。
    // 独立 220 字预算（不复用 inject.ts 的 EXTRA_BUDGET，否则会被整段丢弃）。
    /** 总开关。关掉 = 不取不注入（首轮排查用）。 */
    memoryRecallEnabled: z.boolean().default(true).volatile(),
    /** 总预算（字符）。默认 220。 */
    memoryRecallBudgetChars: z.number().min(40).max(700).default(280).volatile(),
    /** 人物档案上限（字符）。默认 100。 */
    memoryRecallPersonChars: z.number().min(20).max(300).default(100).volatile(),
    /** 群档案上限（字符）。默认 50。 */
    memoryRecallGroupChars: z.number().min(10).max(200).default(50).volatile(),
    /** 最近事件上限（字符）。默认 70。 */
    memoryRecallEventsChars: z.number().min(20).max(300).default(70).volatile(),
    /** 「最近」指多少天。默认 3。 */
    memoryRecallRecentDays: z.number().min(1).max(30).default(3).volatile(),
    /** 人物档案缓存 TTL（分钟）。默认 5。 */
    memoryRecallCacheTtlMin: z.number().min(0.1).max(60).default(5).volatile(),
    /** 最多扫几人档案。默认 50。 */
    memoryRecallMaxPersonFiles: z.number().min(1).max(200).default(50).volatile(),
    /** 最多取几条最近事件。默认 2。 */
    memoryRecallMaxEvents: z.number().min(0).max(10).default(2).volatile(),
    // ── 记忆联想化 · 第二层「主动惦记」（2026-11-08 新增）──────────────────
    // 老友久未出现 / 生日临近 / 关系跳级 → 主动开口（复用生活流 outbox 通道）。
    /** 总开关。 */
    memoryCallbackEnabled: z.boolean().default(true).volatile(),
    /** 每天最多主动惦记几次（1..3）。默认 1。 */
    memoryCallbackDailyMax: z.number().min(1).max(3).default(1).volatile(),
    /** 「久未出现」阈值（天）。默认 7。 */
    memoryCallbackMinGapDays: z.number().min(1).max(60).default(7).volatile(),
    /** 允许惦记的起始小时（含）。默认 10。 */
    memoryCallbackHoursFrom: z.number().min(0).max(23).default(10).volatile(),
    /** 允许惦记的结束小时（不含）。默认 21。 */
    memoryCallbackHoursTo: z.number().min(1).max(24).default(21).volatile(),
    /** 老友判定：历史消息条数下限。默认 20。 */
    memoryCallbackMinMessages: z.number().min(0).max(10000).default(20).volatile(),
    /**
     * 是否把**自己的生日**也交给第二层（默认 false）。
     *
     * false = 决策 A：自己的生日交给扩展包 ext-birthday-auto（当天一次完整自祝），
     *         第二层只提醒别人的生日，避免「同一件事说两次」。
     */
    memoryCallbackOwnBirthday: z.boolean().default(false).volatile(),
});
/**
 * 取出 schemastery `volatile` 字段的真实值。
 *
 * 🔴 2026-11-06 修（跨两插件的 P0-1，真机审查发现）：
 *   `volatile` 字段在 `validate()` 输出里是**包装对象**（带 `.get()`），不是原始值。
 *   官方写法是 `config.timeoutMs.get()`（见 `dsh-bash-local/lib/index.js:52`）。
 *
 *   此前 resolveConfig 直接读属性 → 拿到 `{}`：
 *     · `String({})` → `"[object Object]"`（qqbotDataRoot 坏掉，被 paths-runtime 探测链救回）
 *     · `Number({})` → **NaN** ⇒ `reviewHour` / `autoJudgeRate` / `autoJudgeMinLength` 全变 NaN
 *       → `judge.ts` 里 `!(rate > 0)` 恒真 ⇒ **判官永远跳过，全库 0 条 judge 记录**
 *       → `setHours(NaN)` 使自排复盘定时器失效
 *   这是**用户可见的实害**，不是理论风险。
 */
function unwrap(v) {
    if (v && typeof v === 'object' && typeof v.get === 'function') {
        try {
            return v.get();
        }
        catch {
            return undefined;
        }
    }
    return v;
}
/** 数值守卫：unwrap + 拒绝 NaN/非数字 → 回落默认值。 */
function num(v, fallback, min, max) {
    const raw = unwrap(v);
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
/** 字符串守卫：unwrap + 空串回落。 */
function str(v, fallback) {
    const raw = unwrap(v);
    return typeof raw === 'string' && raw.length ? raw : fallback;
}
export function resolveConfig(input) {
    const i = (input ?? {});
    return {
        enabled: unwrap(i.enabled) !== false,
        qqbotDataRoot: str(i.qqbotDataRoot, '~/.dsh-qqbot'),
        analysisIntervalMin: num(i.analysisIntervalMin, 60, 1, Number.MAX_SAFE_INTEGER),
        maxHistoryDays: num(i.maxHistoryDays, 7, 1, 90),
        reviewEnabled: unwrap(i.reviewEnabled) !== false,
        reviewProvider: str(i.reviewProvider, ''),
        reviewModel: str(i.reviewModel, ''),
        reviewHour: num(i.reviewHour, 4, 0, 23),
        autoJudgeEnabled: unwrap(i.autoJudgeEnabled) !== false,
        autoJudgeRate: num(i.autoJudgeRate, 1, 0, 1),
        autoJudgeMinLength: num(i.autoJudgeMinLength, 15, 0, Number.MAX_SAFE_INTEGER),
        // 碎片生活流（上下限与 life-stream.ts 的 HARD_* 常量保持一致，双保险）
        lifeStreamEnabled: unwrap(i.lifeStreamEnabled) !== false,
        lifeStreamDailyMax: num(i.lifeStreamDailyMax, 3, 1, 3),
        lifeStreamMinGapMin: num(i.lifeStreamMinGapMin, 90, 30, 720),
        lifeStreamHoursFrom: num(i.lifeStreamHoursFrom, 8, 0, 23),
        lifeStreamHoursTo: num(i.lifeStreamHoursTo, 24, 1, 24),
        // 记忆联想 · 第一层（被动联想）
        memoryRecallEnabled: unwrap(i.memoryRecallEnabled) !== false,
        memoryRecallBudgetChars: num(i.memoryRecallBudgetChars, 280, 40, 700),
        memoryRecallPersonChars: num(i.memoryRecallPersonChars, 100, 20, 300),
        memoryRecallGroupChars: num(i.memoryRecallGroupChars, 50, 10, 200),
        memoryRecallEventsChars: num(i.memoryRecallEventsChars, 70, 20, 300),
        memoryRecallRecentDays: num(i.memoryRecallRecentDays, 3, 1, 30),
        memoryRecallCacheTtlMin: num(i.memoryRecallCacheTtlMin, 5, 0.1, 60),
        memoryRecallMaxPersonFiles: num(i.memoryRecallMaxPersonFiles, 50, 1, 200),
        memoryRecallMaxEvents: num(i.memoryRecallMaxEvents, 2, 0, 10),
        // 记忆联想 · 第二层（主动惦记）
        memoryCallbackEnabled: unwrap(i.memoryCallbackEnabled) !== false,
        memoryCallbackDailyMax: num(i.memoryCallbackDailyMax, 1, 1, 3),
        memoryCallbackMinGapDays: num(i.memoryCallbackMinGapDays, 7, 1, 60),
        memoryCallbackHoursFrom: num(i.memoryCallbackHoursFrom, 10, 0, 23),
        memoryCallbackHoursTo: num(i.memoryCallbackHoursTo, 21, 1, 24),
        memoryCallbackMinMessages: num(i.memoryCallbackMinMessages, 20, 0, 10000),
        memoryCallbackOwnBirthday: unwrap(i.memoryCallbackOwnBirthday) === true,
    };
}
