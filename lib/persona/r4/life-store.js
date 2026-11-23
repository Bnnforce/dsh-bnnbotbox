/**
 * R4.0 模块新增（2026-11-04）：生活痕迹抽卡的**持久化 + IO 层**。
 *
 * 分工（与 life-events.ts 解耦）：
 *   · `life-events.ts` = 纯函数（解析/抽卡/渲染，无 IO、无时间源）；
 *   · 本文件 = 读文件、读状态、原子写回 —— 所有失败一律 warn 降级，**绝不抛**。
 *
 * 数据落点（开发规则二.2 数据隔离红线）：
 *   `{PERSONA_DATA_ROOT}/state/daily-mood.json`
 *   **绝不写进** `dshqqbot/.qqbot-extensions/data/` 等原生目录。
 *
 * 事件库位置（方案 §1）：
 *   `{WORKSPACE_ROOT}/Bot/事件库/`，四个 md 文件；目录与截断长度来自配置。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic, isPlainObject } from '../../shared/atomic.js';
import { logInfo, logWarn } from './logger.js';
import { stateDir } from './paths.js';
import { EMPTY_DAILY_MOOD, LIFE_SLOTS, isStaleMood, parseEventLines, pickLifeEvents, } from './life-events.js';
/** `state/daily-mood.json` 路径。 */
export function dailyMoodPath(root) {
    return join(stateDir(root), 'daily-mood.json');
}
/**
 * 读当日抽卡状态。
 * 文件缺失/损坏/形状不对 → 返回 `EMPTY_DAILY_MOOD`（调用方据此视为「需要重抽」）。
 */
export function readDailyMood(root, logger) {
    try {
        const raw = readJsonSafe(dailyMoodPath(root));
        if (!isPlainObject(raw))
            return { ...EMPTY_DAILY_MOOD };
        const slots = {};
        const rawSlots = isPlainObject(raw.slots) ? raw.slots : {};
        for (const slot of LIFE_SLOTS) {
            const value = rawSlots[slot.id];
            if (typeof value === 'string' && value.trim())
                slots[slot.id] = value.trim();
        }
        // ── 跨天延续（2026-11-16）：解析 recent（容错：脏数据逐条跳过，不整份丢弃）──
        const recent = [];
        if (Array.isArray(raw.recent)) {
            for (const it of raw.recent) {
                if (!isPlainObject(it))
                    continue;
                const d = typeof it.date === 'string' ? it.date.trim() : '';
                const t = typeof it.text === 'string' ? it.text.trim() : '';
                if (!d || !t)
                    continue;
                recent.push({ date: d, text: t, slot: typeof it.slot === 'string' ? it.slot : '' });
            }
        }
        return {
            date: typeof raw.date === 'string' ? raw.date : '',
            slots,
            generatedAt: Number.isFinite(Number(raw.generatedAt)) ? Number(raw.generatedAt) : 0,
            recent,
        };
    }
    catch (error) {
        logWarn(logger, `[r4] 生活痕迹：读状态失败（已降级为重新抽卡）：${error instanceof Error ? error.message : String(error)}`);
        return { ...EMPTY_DAILY_MOOD };
    }
}
/** 原子写当日抽卡状态。失败 → warn + false（不抛）。 */
export function writeDailyMood(state, root, logger) {
    try {
        return writeJsonAtomic(dailyMoodPath(root), state, logger);
    }
    catch (error) {
        logWarn(logger, `[r4] 生活痕迹：写状态失败（本次不生效，不影响主聊天）：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}
/**
 * 读单个事件文件并解析为候选列表。
 *
 * 方案的容错要求：文件不存在 / 为空 / 无读取权限 → **返回空数组**（调用方用兜底文案），
 * 并 warn 提示。**绝不抛错、绝不阻塞**。
 */
export function readEventCandidates(dir, file, logger) {
    const path = join(String(dir ?? ''), String(file ?? ''));
    try {
        if (!existsSync(path)) {
            logWarn(logger, `[r4] 生活痕迹：事件文件不存在（${path}）→ 该时段用兜底文案`);
            return [];
        }
        const raw = readFileSync(path, 'utf8');
        const list = parseEventLines(raw);
        if (list.length === 0) {
            logWarn(logger, `[r4] 生活痕迹：事件文件为空或全是空行（${path}）→ 该时段用兜底文案`);
        }
        return list;
    }
    catch (error) {
        logWarn(logger, `[r4] 生活痕迹：读事件文件失败（${path}，已用兜底）：${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
/** 读取四个事件文件 → 候选表（键为 slotId）。 */
export function readAllCandidates(config, logger) {
    const out = {};
    if (!config?.enabled)
        return out;
    const dir = String(config.events_dir ?? '').trim();
    if (!dir) {
        logWarn(logger, '[r4] 生活痕迹：未配置 events_dir → 全部时段用兜底文案');
        return out;
    }
    for (const slot of LIFE_SLOTS) {
        out[slot.id] = readEventCandidates(dir, slot.file, logger);
    }
    return out;
}
/**
 * 确保当日抽卡已完成（跨天则重抽并落盘）。**幂等**。
 *
 * 返回最终生效的状态（即使写盘失败也返回内存态，保证本轮能正常注入）。
 * 这是本模块唯一的"入口"：index.ts 每次 assemble 调它一次，代价极低
 * （当日已抽过时只读一个小 JSON）。
 *
 * @param today  今天的 `YYYY-MM-DD`（由调用方用 `dayKeyOf` 算，本模块不读时间）
 * @param now    当前时间戳（写入 generatedAt）
 * @param random 随机源（测试注入）
 */
export function ensureDailyMood(input) {
    const { root, today, now, random, config, logger, skipSlots } = input;
    if (!config?.enabled)
        return { ...EMPTY_DAILY_MOOD };
    const existing = readDailyMood(root, logger);
    if (!isStaleMood(existing, today))
        return existing;
    try {
        const candidates = readAllCandidates(config, logger);
        // previous 传给抽卡层 → 旧条目并进 recent（跨天延续）
        // ★ 2026-11-16：ensureDailyMood 保持「4 段都抽」的既有契约（不在此处做 P5 策略），
        //   P5 的「装死窗口不抽」由调用方按需传 skipSlots —— 保持本函数是**通用工具**。
        const next = pickLifeEvents({ date: today, now, random, candidates, config, previous: existing, skipSlots: input.skipSlots });
        const ok = writeDailyMood(next, root, logger);
        const picked = LIFE_SLOTS
            .map((s) => `${s.label}=${next.slots[s.id] ?? '-'}`)
            .join(' / ');
        if (ok) {
            logInfo(logger, `[r4] 生活痕迹：${today} 已抽卡（${picked}）`);
        }
        else {
            logWarn(logger, `[r4] 生活痕迹：${today} 抽卡完成但写盘失败（本轮先按内存态注入）`);
        }
        return next;
    }
    catch (error) {
        // 理论上不会走到（下游都已 try-catch），这里再兜一层：绝不阻塞主聊天。
        logWarn(logger, `[r4] 生活痕迹：抽卡异常（本轮跳过注入）：${error instanceof Error ? error.message : String(error)}`);
        return { ...EMPTY_DAILY_MOOD };
    }
}
