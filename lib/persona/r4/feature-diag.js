/**
 * feature-diag — 「活人感」功能的统一可观测埋点（2026-11-16）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个文件（不是"加个日志"这么简单）
 *
 * 2026-11-15 踩过一个真实的坑：
 *   `group_memory.mjs` 的 diag() 在 .mjs 里用了 `require('node:fs')` →
 *   `ReferenceError: require is not defined`，被外层 `catch {}` 吞掉。
 *   结果：日志文件冻结在 11-06，而工具**实际被调用 46 次**。
 *   我们花了很久才从别的地方间接推断出"功能其实在工作"。
 *
 * 教训：**日志写不进去 = 无法证明功能在工作 = 功能等于不存在**。
 *
 * 所以本文件的设计目标：
 *   ① 单一出口（所有功能都走这里的 record()，不允许各写各的）
 *   ② 绝不吞错（写失败也要往 stderr 吭一声，且最多每 60s 吭一次）
 *   ③ 自动轮转（超 2MB 换文件，保留 1 份 .old）
 *   ④ 零依赖（只用 node:fs，不引任何第三方）
 *   ⑤ 开关关闭时可完全静默（诊断本身不该拖慢主链）
 *
 * ── 记录格式（每行一个 JSON，便于 grep/jq/node 读取）──────────────────────
 *   {
 *     "ts": 1794800000000,
 *     "feature": "P2",              // 功能 ID（P1-P5 或自定义）
 *     "on": true,                   // 本轮是否真的注入了
 *     "chars": 180,                 // 注入字符数（on=false 时为 0）
 *     "reason": "",                 // on=false 时的原因（如 "not-due"、"disabled"）
 *     "detail": { ... },            // 功能特有字段（如 carried: 2）
 *     "err": ""                     // 异常信息（正常为空）
 *   }
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** 单文件上限（2MB）：超了轮转，避免无限增长拖慢读取。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 写失败时的告警节流（同一进程最多每 60s 报一次，避免刷屏）。 */
const WARN_INTERVAL_MS = 60_000;
let _lastWarnAt = 0;
let _disabled = false;
/** 诊断文件路径。 */
export function featureDiagPath(dataRoot) {
    return join(String(dataRoot ?? '').trim(), 'state', 'feature-diag.jsonl');
}
/**
 * 写一条诊断记录。
 *
 * **永不抛错**：任何异常都在内部吞掉（但会节流告警）。
 * 这让调用方可以放心在热路径里调用，不必再包 try/catch。
 *
 * @param dataRoot PERSONA_DATA_ROOT
 * @param rec 记录内容
 * @param enabled 总开关（false → 直接返回，零开销）
 */
export function record(dataRoot, rec, enabled = true) {
    if (!enabled || _disabled)
        return;
    const root = String(dataRoot ?? '').trim();
    if (!root)
        return;
    try {
        const dir = join(root, 'state');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const file = featureDiagPath(root);
        // ── 轮转（先判断再写，避免写完才发现超限）──
        try {
            if (existsSync(file) && statSync(file).size > MAX_BYTES) {
                const old = `${file}.old`;
                try {
                    if (existsSync(old)) {
                        // 覆盖旧 .old（只留一份，不无限堆积）
                        renameSync(file, `${old}.tmp`);
                        renameSync(`${old}.tmp`, old);
                    }
                    else {
                        renameSync(file, old);
                    }
                }
                catch {
                    // 轮转失败不阻塞写入（大不了这个文件继续变大）
                }
            }
        }
        catch { /* stat 失败就当没超限 */ }
        const line = JSON.stringify({
            ts: Date.now(),
            feature: String(rec.feature ?? '?'),
            on: rec.on === true,
            chars: Math.max(0, Math.floor(Number(rec.chars) || 0)),
            reason: String(rec.reason ?? ''),
            ...(rec.detail && typeof rec.detail === 'object' ? { detail: rec.detail } : {}),
            err: String(rec.err ?? ''),
        });
        appendFileSync(file, line + '\n', 'utf8');
    }
    catch (error) {
        // ── 关键：写失败必须吭声（节流），否则又变成"静默失效" ──
        _emitWarn(error);
    }
}
/**
 * 记一条「功能关闭/跳过」的轻量记录（语义糖）。
 * 等价于 record(..., { on: false, reason })。
 */
export function recordSkip(dataRoot, feature, reason, enabled = true) {
    record(dataRoot, { feature, on: false, reason }, enabled);
}
/**
 * 记一条「功能异常」记录（err 非空，便于汇总统计异常率）。
 */
export function recordError(dataRoot, feature, err, enabled = true) {
    record(dataRoot, {
        feature,
        on: false,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }, enabled);
}
/**
 * 连续失败降级：某功能连续抛错 N 次后自动停用（只在本进程内）。
 *
 * 为什么需要：如果某个功能每轮都炸（比如读一个永远权限不足的文件），
 * 不降级就会每轮刷一条 err 日志 + 每轮 try/catch 开销。
 * 降级后本进程内不再调用它，下次重启自动重试。
 */
const _failStreak = new Map();
const MAX_STREAK = 5;
/** 记录一次失败，返回 true = 已达到降级阈值。 */
export function noteFailure(feature) {
    const n = (_failStreak.get(feature) ?? 0) + 1;
    _failStreak.set(feature, n);
    return n >= MAX_STREAK;
}
/** 记录一次成功（清零失败计数）。 */
export function noteSuccess(feature) {
    _failStreak.delete(feature);
}
/** 该功能是否已降级（本进程内）。 */
export function isDegraded(feature) {
    return (_failStreak.get(feature) ?? 0) >= MAX_STREAK;
}
/** 重置降级状态（测试用）。 */
export function resetDegraded() {
    _failStreak.clear();
    _disabled = false;
    _lastWarnAt = 0;
}
/** 全局关闭诊断（测试用；生产不建议关，否则又变成不可观测）。 */
export function setDiagEnabled(on) {
    _disabled = !on;
}
function _emitWarn(error) {
    const now = Date.now();
    if (now - _lastWarnAt < WARN_INTERVAL_MS)
        return;
    _lastWarnAt = now;
    try {
        // 用 stderr 而不是日志文件（日志文件本身就是失败源）
        // eslint-disable-next-line no-console
        console.warn(`[feature-diag] 写诊断失败（已降级，不影响功能）: ${error instanceof Error ? error.message : String(error)}`);
    }
    catch { /* 连 stderr 都写不进去就只能放弃 */ }
}
