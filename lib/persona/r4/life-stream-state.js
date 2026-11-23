/**
 * 碎片生活流 — **状态持久化层**
 *
 * 分工（照 `life-store.ts` 的规矩，与纯函数层解耦）：
 *   · `life-stream.ts`      = 纯函数（判定 / prompt / 清洗，无 IO、无时钟）
 *   · 本文件                = 读盘 / 写盘 / 跨天重置 —— 所有失败一律降级，**绝不抛**
 *
 * 数据落点（`开发规则` 二.2 数据隔离红线）：
 *   `{PERSONA_DATA_ROOT}/state/life-stream.json`
 *   **绝不写进** `dshqqbot/.qqbot-extensions/data/` 等原生目录。
 *
 * 原子写（`开发规则` 四.3 / `审查标准` 三.1）：
 *   全部走 `atomic.ts` 的 `writeJsonAtomic`（临时文件 + fsync + rename），
 *   本文件**不自己写任何文件操作**。
 */
import { readJsonSafe, writeJsonAtomic } from '../../shared/atomic.js';
import { logWarn } from './logger.js';
import { stateDir } from './paths.js';
import { join } from 'node:path';
/** 空状态（当天还没开口过）。 */
export const EMPTY_LIFE_STREAM = {
    date: '',
    todayCount: 0,
    lastAt: 0,
    usedMaterials: [],
};
/**
 * `usedMaterials` 的保留上限。
 *
 * 为什么是 30：素材库共 200 条（4 时段 × 50），保留最近 30 条足以避免
 * 「短期内重复」，又不会让状态文件无限增长。
 */
export const MAX_USED_MATERIALS = 30;
/** `state/life-stream.json` 的绝对路径。 */
export function lifeStreamPath(root) {
    return join(stateDir(root), 'life-stream.json');
}
/** 把任意输入规整成合法状态（缺失/类型错 → 默认值）。**纯函数**。 */
function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ...EMPTY_LIFE_STREAM };
    const r = raw;
    const date = typeof r.date === 'string' ? r.date.trim() : '';
    const todayCount = Number.isFinite(Number(r.todayCount))
        ? Math.max(0, Math.floor(Number(r.todayCount)))
        : 0;
    const lastAt = Number.isFinite(Number(r.lastAt)) ? Math.max(0, Number(r.lastAt)) : 0;
    const usedMaterials = Array.isArray(r.usedMaterials)
        ? r.usedMaterials
            .filter((x) => typeof x === 'string' && x.trim().length > 0)
            // ⚠️ 归一化：历史记录可能带 markdown 前缀（「- xxx」），
            //    若不清洗则与「清洗后素材」对不上 → 去重失效（2026-11-07 实测踩到）。
            .map((x) => x.replace(/^[-*+]\s+/u, '').trim())
            .filter((x) => x.length > 0)
            .slice(-MAX_USED_MATERIALS)
        : [];
    return { date, todayCount, lastAt, usedMaterials };
}
/**
 * 读状态。**缺失 / 损坏 / 形状不对 → 返回 `EMPTY_LIFE_STREAM`**（不抛、不 warn 到刷屏）。
 *
 * 不 warn 的理由：文件缺失是**常态**（新装、首次运行），
 * 只有「存在但读不出来」才值得 warn —— 那种情况 `readJsonSafe` 内部已吞掉，
 * 这里补充一条 warn 便于排查。
 */
export function readLifeStreamState(root, logger) {
    try {
        const raw = readJsonSafe(lifeStreamPath(root));
        if (raw === undefined)
            return { ...EMPTY_LIFE_STREAM };
        return normalizeState(raw);
    }
    catch (error) {
        logWarn(logger, `[r4] 生活流：读状态失败（已降级为默认值）：${error instanceof Error ? error.message : String(error)}`);
        return { ...EMPTY_LIFE_STREAM };
    }
}
/** 原子写状态。失败 → warn + `false`（**不抛、不重试**）。 */
export function writeLifeStreamState(state, root, logger) {
    try {
        return writeJsonAtomic(lifeStreamPath(root), state, logger);
    }
    catch (error) {
        logWarn(logger, `[r4] 生活流：写状态失败（本次不生效，不影响主聊天）：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
/**
 * 跨天重置。**纯函数**。
 *
 * 规则：
 *   · `date` 不是今天 → `todayCount = 0`、`lastAt = 0`
 *   · ⚠️ **`usedMaterials` 保留**（见字段注释：清空会导致素材重复）
 */
export function resetIfNewDay(state, today) {
    const day = String(today ?? '').trim();
    if (!day)
        return state; // 调用方没给日期 → 不动（防御）
    if (state.date === day)
        return state; // 同一天 → 原样返回（零拷贝快路）
    return {
        date: day,
        todayCount: 0,
        lastAt: 0,
        usedMaterials: state.usedMaterials.slice(-MAX_USED_MATERIALS),
    };
}
/**
 * 标记「刚刚开口了一次」。**纯函数**（返回新对象，不改入参）。
 *
 * ⚠️ 调用顺序红线（幂等）：
 *   **必须先写盘成功，再发消息**。
 *   反了就可能在「写失败但已发出」的情况下重复发（下一轮又判 go）。
 *   见 `maintenance-tasks.ts` 的 `runLifeStream`。
 */
export function markSpeaked(state, now, material) {
    const m = String(material ?? '').trim();
    const used = m
        ? [...state.usedMaterials.filter((x) => x !== m), m].slice(-MAX_USED_MATERIALS)
        : state.usedMaterials.slice(-MAX_USED_MATERIALS);
    return {
        date: state.date,
        todayCount: Math.max(0, state.todayCount) + 1,
        lastAt: Number.isFinite(now) ? Number(now) : Date.now(),
        usedMaterials: used,
    };
}
/** 判断素材是否已被用过（**纯函数**，供调用方与 `index.ts` 互斥逻辑共用）。 */
export function isMaterialUsed(state, material) {
    const m = String(material ?? '').trim();
    if (!m)
        return false;
    return state.usedMaterials.includes(m);
}
