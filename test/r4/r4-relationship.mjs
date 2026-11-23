/**
 * R4.0 模块四（关系网与争宠）单元测试 —— 纯函数、无 IO、时间全部入参。
 *
 * 运行：`cd /path/to/bnnbotbox && node test/r4-relationship.mjs`
 * Node 24 直跑 `.ts`（`import('./relationship.ts')`）。
 */

/* ─────────── 断言小工具 ─────────── */

let checks = 0;
const failures = [];

function ok(cond, label) {
  checks += 1;
  if (!cond) failures.push(label);
}
function eq(actual, expected, label) {
  checks += 1;
  if (actual !== expected) failures.push(`${label}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`);
}
function deepEq(actual, expected, label) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}（期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}）`);
  }
}

/* ─────────── 固定时基（Asia/Shanghai 语义，与系统时区无关） ─────────── */

const TZ = 'Asia/Shanghai';

/** 2026-11-03 12:00:00（+08） */
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);
/** 2026-11-04 00:00:00（+08）= 11-03 的「次日 0 点」 */
const NEXT_DAY_START = Date.UTC(2026, 10, 3, 16, 0, 0);
/** 2026-11-02 12:00:00（+08） */
const PREV_DAY = Date.UTC(2026, 10, 2, 4, 0, 0);
/** 2026-10-31 12:00:00（+08） */
const THREE_DAYS_AGO = Date.UTC(2026, 9, 31, 4, 0, 0);
/** 2026-11-03 08:00:30（+08）—— 与 NOW 同日 */
const SAME_DAY_EARLIER = Date.UTC(2026, 10, 3, 0, 0, 30);
const MIN = 60_000;

const levels = { L0: '高信任', L1: '熟悉', L2: '普通', L3: '低互动' };

/** 图纸 1.1 的 relationship_config 原样。 */
const CFG = {
  initial_level: 'L2',
  initial_score: 0,
  level_bounds: {
    L3: { minInclusive: -100, maxExclusive: -5 },
    L2: { minInclusive: -5, maxExclusive: 10 },
    L1: { minInclusive: 10, maxExclusive: 25 },
    L0: { minInclusive: 25, maxInclusive: 100 },
  },
  decay_per_day: 1,
  score_cooldown_minutes: 10,
  score_reply: 2,
  score_mention: 3,
  score_bot: 1,
};

/** 手搓一条记录（与 types.ts 的 emptyRelationshipEntry 同形，避免运行时 import 依赖）。 */
function entry(patch = {}) {
  return {
    level: 'L2',
    score: 0,
    lastDecayAt: 0,
    updatedAt: 0,
    scoreCooldowns: { reply: 0, mention: 0, bot: 0 },
    temporaryAttitude: '',
    temporaryAttitudeExpiresAt: 0,
    ...patch,
  };
}
function msg(senderId, at, self = false) {
  return { senderId, text: 'hi', at, self };
}

/** 用 Intl 取某瞬时在 Asia/Shanghai 的 `YYYY-MM-DD HH:mm:ss`（测试侧独立断言用）。 */
function zonedStamp(ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    calendar: 'gregory',
    numberingSystem: 'latn',
  });
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/* ─────────── 加载被测模块 ─────────── */

const R = await import('../../lib/persona/r4/relationship.js');

/* ─────────── 1. levelForScore 全边界 ─────────── */

eq(R.levelForScore(-100, CFG.level_bounds), 'L3', 'level -100 → L3');
eq(R.levelForScore(-6, CFG.level_bounds), 'L3', 'level -6 → L3');
eq(R.levelForScore(-5, CFG.level_bounds), 'L2', 'level -5 → L2（半开区间左闭）');
eq(R.levelForScore(0, CFG.level_bounds), 'L2', 'level 0 → L2');
eq(R.levelForScore(9, CFG.level_bounds), 'L2', 'level 9 → L2');
eq(R.levelForScore(9.99, CFG.level_bounds), 'L2', 'level 9.99 → L2');
eq(R.levelForScore(10, CFG.level_bounds), 'L1', 'level 10 → L1（右开）');
eq(R.levelForScore(24, CFG.level_bounds), 'L1', 'level 24 → L1');
eq(R.levelForScore(25, CFG.level_bounds), 'L0', 'level 25 → L0');
eq(R.levelForScore(100, CFG.level_bounds), 'L0', 'level 100 → L0（maxInclusive）');
eq(R.levelForScore(101, CFG.level_bounds), 'L0', 'level 101 越界 → 仍 L0（升级不越 L0）');
eq(R.levelForScore(-101, CFG.level_bounds), 'L3', 'level -101 越界 → 仍 L3（降级不越 L3）');
eq(R.levelForScore(-1e9, CFG.level_bounds), 'L3', 'level 极小值 → L3');
eq(R.levelForScore(1e9, CFG.level_bounds), 'L0', 'level 极大值 → L0');

/* ─────────── 2. 自然日 dayKey / dayDiff（不是毫秒除法） ─────────── */

eq(R.dayKey(NOW), '2026-11-03', 'dayKey(NOW) 取 Asia/Shanghai 日期');
eq(R.dayKey(NEXT_DAY_START), '2026-11-04', 'dayKey(次日 0 点) = 次日');
eq(R.dayKey(NEXT_DAY_START - 1000), '2026-11-03', 'dayKey(23:59:59) 仍是当天');
// 跨 00:00 但只差 2 分钟 → 天数差 1（证明不是毫秒除法）
const BEFORE_MIDNIGHT = Date.UTC(2026, 10, 2, 15, 59, 0); // 11-02 23:59 +08
const AFTER_MIDNIGHT = Date.UTC(2026, 10, 2, 16, 1, 0); // 11-03 00:01 +08
eq(R.dayDiff(AFTER_MIDNIGHT, BEFORE_MIDNIGHT), 1, '跨 00:00 仅 2 分钟 → 天数差 1');
eq(R.dayDiff(NOW, NOW), 0, '同日 → 天数差 0');
eq(R.dayDiff(NOW, PREV_DAY), 1, '相邻两日 → 1');
eq(R.dayDiff(NOW, THREE_DAYS_AGO), 3, '三日差 → 3');
eq(R.dayDiff(PREV_DAY, NOW), -1, '反向 → -1');
eq(R.dayDiff(NEXT_DAY_START, NEXT_DAY_START - 1000), 1, '相差 1 秒但跨 00:00 → 天数差 1');

/* ─────────── 3. 衰减 ─────────── */

// 3.1 lastDecayAt === 0 → 只设时间、不扣分
{
  const e = entry({ level: 'L2', score: 5 });
  const out = R.applyDecay(e, NOW, CFG);
  eq(out.score, 5, '首次（lastDecayAt=0）不扣分');
  eq(out.lastDecayAt, NOW, '首次把 lastDecayAt 设为 now');
  eq(out.level, 'L2', '首次不改 level');
  deepEq(e, entry({ level: 'L2', score: 5 }), 'applyDecay 不改入参（深拷贝）');
}

// 3.2 跨 1 天扣 1
{
  const out = R.applyDecay(entry({ score: 5, lastDecayAt: PREV_DAY }), NOW, CFG);
  eq(out.score, 4, '跨 1 天扣 1（5 → 4）');
  eq(out.lastDecayAt, NOW, '跨天衰减后 lastDecayAt=now');
}

// 3.3 跨 3 天扣 3
{
  const out = R.applyDecay(entry({ score: 5, lastDecayAt: THREE_DAYS_AGO }), NOW, CFG);
  eq(out.score, 2, '跨 3 天扣 3（5 → 2）');
}

// 3.4 跨 0 天扣 0
{
  const out = R.applyDecay(entry({ score: 5, lastDecayAt: SAME_DAY_EARLIER }), NOW, CFG);
  eq(out.score, 5, '跨 0 天扣 0');
  eq(out.lastDecayAt, NOW, '跨 0 天也刷新 lastDecayAt');
}

// 3.5 钳制到 -100
{
  const out = R.applyDecay(entry({ score: -99, lastDecayAt: THREE_DAYS_AGO }), NOW, CFG);
  eq(out.score, -100, '衰减钳制到 -100（-99 - 3 → -100）');
  eq(out.level, 'L3', '钳制后 level 落在 L3');
}

// 3.6 钳制到 100（decay 为负/为 0 时不越上限；极端配置也钳制）
{
  const bigCfg = { ...CFG, decay_per_day: 0 };
  const out = R.applyDecay(entry({ score: 100, lastDecayAt: PREV_DAY }), NOW, bigCfg);
  eq(out.score, 100, 'decay_per_day=0 时分数不变且不越 100');
  eq(out.level, 'L0', '100 分 level=L0');
}

// 3.7 now 早于 lastDecayAt → deltaDays 取 max(0, ...)，不涨分
{
  const out = R.applyDecay(entry({ score: 7, lastDecayAt: NOW }), PREV_DAY, CFG);
  eq(out.score, 7, 'now 早于 lastDecayAt 时不涨分（deltaDays=0）');
  eq(out.lastDecayAt, PREV_DAY, '此时 lastDecayAt 仍更新为 now');
}

// 3.8 衰减按新分数重算 level（9 → 跨 1 天 → 8 仍 L2；10 → 9 变 L2）
{
  const out = R.applyDecay(entry({ level: 'L1', score: 10, lastDecayAt: PREV_DAY }), NOW, CFG);
  eq(out.score, 9, '衰减后 10 → 9');
  eq(out.level, 'L2', '衰减后按新分数降级 L1 → L2');
}

/* ─────────── 4. 冷却 ─────────── */

{
  eq(R.canScore(entry(), 'reply', NOW, CFG), true, '冷却 last=0 → 可计分');
  eq(R.canScore(entry(), 'mention', NOW, CFG), true, '冷却 last=0 → 可计分（mention）');
  eq(R.canScore(entry({ scoreCooldowns: { reply: NOW - 9 * MIN, mention: 0, bot: 0 } }), 'reply', NOW, CFG), false, 'now-last=9min → 不可计分');
  eq(R.canScore(entry({ scoreCooldowns: { reply: NOW - 10 * MIN, mention: 0, bot: 0 } }), 'reply', NOW, CFG), true, 'now-last=10min → 可计分（>= 边界）');
  eq(R.canScore(entry({ scoreCooldowns: { reply: NOW - 11 * MIN, mention: 0, bot: 0 } }), 'reply', NOW, CFG), true, 'now-last=11min → 可计分');
  eq(R.canScore(entry({ scoreCooldowns: { reply: 0, mention: NOW - 9 * MIN, bot: 0 } }), 'reply', NOW, CFG), true, '冷却按 kind 分开（mention 冷却不影响 reply）');
}

/* ─────────── 5. 三种计分 ─────────── */

// 5.1 reply +2
{
  const e = entry({ score: 0 });
  const out = R.scoreEvent(e, 'reply', NOW, CFG);
  eq(out.score, 2, 'reply 计分 +2');
  eq(out.updatedAt, NOW, 'reply 计分后 updatedAt=now');
  eq(out.scoreCooldowns.reply, NOW, 'reply 计分后更新 scoreCooldowns.reply');
  eq(out.scoreCooldowns.mention, 0, 'reply 计分不动 mention 冷却');
  eq(out.scoreCooldowns.bot, 0, 'reply 计分不动 bot 冷却');
  eq(out.level, 'L2', 'reply 后 2 分仍 L2');
  deepEq(e, entry({ score: 0 }), 'scoreEvent 不改入参');
}

// 5.2 mention +3
{
  const out = R.scoreEvent(entry({ score: 5, lastDecayAt: NOW }), 'mention', NOW, CFG);
  eq(out.score, 8, 'mention 计分 +3');
  eq(out.scoreCooldowns.mention, NOW, 'mention 计分后更新 scoreCooldowns.mention');
  eq(out.scoreCooldowns.reply, 0, 'mention 计分不动 reply 冷却');
  eq(out.updatedAt, NOW, 'mention 计分后 updatedAt=now');
}

// 5.3 bot +1
{
  const out = R.scoreEvent(entry({ score: 5, lastDecayAt: NOW }), 'bot', NOW, CFG);
  eq(out.score, 6, 'bot 计分 +1');
  eq(out.scoreCooldowns.bot, NOW, 'bot 计分后更新 scoreCooldowns.bot');
  eq(out.scoreCooldowns.reply, 0, 'bot 计分不动 reply 冷却');
  eq(out.scoreCooldowns.mention, 0, 'bot 计分不动 mention 冷却');
}

// 5.4 冷却中：原样返回 decay 后的对象（updatedAt 不动、分不加、冷却不回写）
{
  const e = entry({
    score: 5,
    lastDecayAt: PREV_DAY,
    updatedAt: PREV_DAY,
    scoreCooldowns: { reply: NOW - 9 * MIN, mention: 0, bot: 0 },
  });
  const out = R.scoreEvent(e, 'reply', NOW, CFG);
  eq(out.score, 4, '冷却中仍先按自然日衰减（5 → 4）');
  eq(out.updatedAt, PREV_DAY, '冷却中 updatedAt 不动');
  eq(out.scoreCooldowns.reply, NOW - 9 * MIN, '冷却中不回写 scoreCooldowns（等下次窗口）');
  eq(out.lastDecayAt, NOW, '冷却中也已刷新 lastDecayAt');
}

// 5.5 计分钳制 [-100, 100]
{
  const out = R.scoreEvent(entry({ score: 99, lastDecayAt: NOW }), 'reply', NOW, CFG);
  eq(out.score, 100, '计分钳制到 100');
  const down = R.scoreEvent(entry({ score: -100, lastDecayAt: NOW }), 'bot', NOW, CFG);
  ok(down.score >= -100 && down.score <= 100, '计分结果始终落在 [-100, 100]');
}

/* ─────────── 6. 升降级 ─────────── */

// 6.1 score 9 → +2 = 11 → L1
{
  const out = R.scoreEvent(entry({ level: 'L2', score: 9, lastDecayAt: NOW }), 'reply', NOW, CFG);
  eq(out.score, 11, '9 + 2 = 11');
  eq(out.level, 'L1', '9 → 11 升到 L1');
}

// 6.2 score 25 → L0
{
  const out = R.scoreEvent(entry({ level: 'L1', score: 24, lastDecayAt: NOW }), 'bot', NOW, CFG);
  eq(out.score, 25, '24 + 1 = 25');
  eq(out.level, 'L0', '25 → L0');
}

// 6.3 score -4 → 跨 1 天衰减 3 → -7 → L3（decay_per_day = 3；纯衰减路径）
{
  const cfg3 = { ...CFG, decay_per_day: 3 };
  const decayed = R.applyDecay(entry({ level: 'L2', score: -4, lastDecayAt: PREV_DAY }), NOW, cfg3);
  eq(decayed.score, -7, '-4 - 3 = -7');
  eq(decayed.level, 'L3', '-7 → L3');
  // 同一起点在计分路径上再 +1（bot）：-7 + 1 = -6，仍落 L3
  const scored = R.scoreEvent(entry({ level: 'L2', score: -4, lastDecayAt: PREV_DAY }), 'bot', NOW, cfg3);
  eq(scored.score, -6, '衰减后再 bot +1 → -6');
  eq(scored.level, 'L3', '-6 → L3（计分路径同样能降级）');
}

// 6.4 降级不越 L3 / 升级不越 L0
{
  const out = R.scoreEvent(entry({ level: 'L3', score: -100, lastDecayAt: NOW }), 'bot', NOW, CFG);
  ok(out.level === 'L3', 'L3 底部计分后仍不越 L3 下限（level 由分数决定）');
  const up = R.scoreEvent(entry({ level: 'L0', score: 100, lastDecayAt: NOW }), 'mention', NOW, CFG);
  eq(up.level, 'L0', 'L0 顶部计分后仍 L0（100 钳制后 100）');
}

/* ─────────── 7. 临时态度 ─────────── */

{
  const e = entry({ level: 'L1', score: 12, lastDecayAt: NOW, updatedAt: NOW });
  const out = R.setTemporaryCold({ entry: e, now: NOW, timeZone: TZ });
  eq(out.temporaryAttitude, '冷淡', 'setTemporaryCold 写 temporaryAttitude="冷淡"');
  eq(out.temporaryAttitudeExpiresAt, NEXT_DAY_START, 'expiresAt = 次日 0 点（Asia/Shanghai 毫秒值）');
  eq(zonedStamp(out.temporaryAttitudeExpiresAt), '2026-11-04 00:00:00', 'expiresAt 用 Intl 断言到次日 00:00:00');
  eq(out.level, 'L1', 'setTemporaryCold 不改 level');
  eq(out.score, 12, 'setTemporaryCold 不改 score');
  eq(out.updatedAt, NOW, 'setTemporaryCold 不动 updatedAt');
  deepEq(e, entry({ level: 'L1', score: 12, lastDecayAt: NOW, updatedAt: NOW }), 'setTemporaryCold 不改入参');
}

// 7.2 跨日边界：23:59 → 次日 0 点；次日 00:00:01 → 再下一日
{
  const lateAt = Date.UTC(2026, 10, 3, 15, 59, 0); // 11-03 23:59 +08
  const out = R.setTemporaryCold({ entry: entry(), now: lateAt });
  eq(out.temporaryAttitudeExpiresAt, NEXT_DAY_START, '23:59 的次日 0 点仍是 11-04 00:00');
  const justAfter = Date.UTC(2026, 10, 3, 16, 0, 1); // 11-04 00:00:01 +08
  const out2 = R.setTemporaryCold({ entry: entry(), now: justAfter });
  eq(zonedStamp(out2.temporaryAttitudeExpiresAt), '2026-11-05 00:00:00', '00:00:01 的次日 0 点是 11-05 00:00');
}

// 7.3 跨月/跨年：1 月 31 日 → 2 月 1 日
{
  const jan31 = Date.UTC(2026, 0, 31, 4, 0, 0); // 2026-01-31 12:00 +08
  const out = R.setTemporaryCold({ entry: entry(), now: jan31 });
  eq(zonedStamp(out.temporaryAttitudeExpiresAt), '2026-02-01 00:00:00', '1/31 的次日 0 点 = 2/1 00:00（跨月正确）');
  const dec31 = Date.UTC(2026, 11, 31, 4, 0, 0); // 2026-12-31 12:00 +08
  const out2 = R.setTemporaryCold({ entry: entry(), now: dec31 });
  eq(zonedStamp(out2.temporaryAttitudeExpiresAt), '2027-01-01 00:00:00', '12/31 的次日 0 点 = 次年 1/1（跨年正确）');
}

// 7.4 lazyExpireAttitude 过期清除
{
  const cold = R.setTemporaryCold({ entry: entry({ level: 'L2', score: 3 }), now: NOW });
  const after = R.lazyExpireAttitude(cold, NEXT_DAY_START);
  eq(after.temporaryAttitude, '', '已过期 → temporaryAttitude 清空');
  eq(after.temporaryAttitudeExpiresAt, 0, '已过期 → expiresAt 归 0');
  eq(after.level, 'L2', '过期清除不动 level');
  eq(after.score, 3, '过期清除不动 score');
}

// 7.5 未过期保留
{
  const cold = R.setTemporaryCold({ entry: entry(), now: NOW });
  const before = R.lazyExpireAttitude(cold, NEXT_DAY_START - 1);
  eq(before.temporaryAttitude, '冷淡', '未过期 → 保留 temporaryAttitude');
  eq(before.temporaryAttitudeExpiresAt, NEXT_DAY_START, '未过期 → 保留 expiresAt');
  const atBoundary = R.lazyExpireAttitude(cold, NEXT_DAY_START);
  eq(atBoundary.temporaryAttitude, '', 'now === expiresAt 视为已过期（>=）');
}

// 7.6 无临时态度时惰性判断不改动
{
  const out = R.lazyExpireAttitude(entry({ score: 4 }), NOW);
  eq(out.temporaryAttitude, '', '无临时态度 → 保持空串');
  eq(out.temporaryAttitudeExpiresAt, 0, '无临时态度 → expiresAt 保持 0');
  eq(out.updatedAt, 0, 'lazyExpireAttitude 不动 updatedAt');
}

/* ─────────── 8. 争宠 ─────────── */

const relationships = {
  u_high: entry({ level: 'L1', score: 12 }),
  u_a: entry({ level: 'L3', score: -6 }),
  u_c: entry({ level: 'L3', score: -8 }),
  u_b: entry({ level: 'L3', score: -7 }),
  u_other: entry({ level: 'L2', score: 0 }),
};

{
  const messages = [
    msg('u_a', NOW - 5 * MIN),
    msg('u_b', NOW - 12 * MIN),
    msg('u_c', NOW - 29 * MIN),
    msg('u_high', NOW - 3 * MIN), // L1，不算在场 L3
    msg('u_other', NOW - 20 * MIN), // L2，不算
  ];
  const present = R.presentLowLevelUsers({ messages, relationships, now: NOW });
  deepEq(present, ['u_a', 'u_b', 'u_c'], 'presentLow 只含 3 个 L3 且按 userId 字典序');
  eq(R.shouldInjectContest({ currentLevel: 'L0', presentLow: present }), true, 'currentLevel=L0 + 非空 → 触发');
  eq(R.shouldInjectContest({ currentLevel: 'L1', presentLow: present }), true, 'currentLevel=L1 + 非空 → 触发');
  eq(R.shouldInjectContest({ currentLevel: 'L2', presentLow: present }), false, 'currentLevel=L2 → 不触发');
  eq(R.shouldInjectContest({ currentLevel: 'L3', presentLow: present }), false, 'currentLevel=L3 → 不触发');
  eq(R.shouldInjectContest({ currentLevel: undefined, presentLow: present }), false, 'currentLevel 缺省 → 不触发');
}

// 8.2 超 30 分钟的不算；恰好 30 分钟算；未来时间戳也不算「不在场」
{
  const messages = [
    msg('u_a', NOW - 31 * MIN), // 超窗
    msg('u_b', NOW - 30 * MIN), // 边界（<= 算在场）
    msg('u_c', NOW + 10 * MIN), // 未来时间戳，仍在窗内
  ];
  const present = R.presentLowLevelUsers({ messages, relationships, now: NOW });
  deepEq(present, ['u_b', 'u_c'], '超 30 分钟不算、恰好 30 分钟算');
}

// 8.3 bot 自身（self=true）不算；senderId 不在 relationships 不算
{
  const messages = [
    msg('u_a', NOW - 2 * MIN, true), // bot 自己（即使 id 是 L3 也不计）
    msg('u_b', NOW - 2 * MIN), // 在 relationships
    msg('u_unknown', NOW - 2 * MIN), // 不在 relationships
  ];
  const present = R.presentLowLevelUsers({ messages, relationships, now: NOW });
  deepEq(present, ['u_b'], 'self=true 的 bot 消息与陌生 userId 都不算');
}

// 8.4 数据不可用 → 空数组（调用方 warn 并跳过）
{
  eq(R.presentLowLevelUsers({ messages: [], relationships, now: NOW }).length, 0, 'messages 为空 → 空数组');
  eq(R.presentLowLevelUsers({ messages: undefined, relationships, now: NOW }).length, 0, 'messages 缺失 → 空数组');
  eq(R.presentLowLevelUsers({ messages: [msg('u_a', NOW - MIN)], relationships: {}, now: NOW }).length, 0, 'relationships 为空 → 空数组');
  eq(R.shouldInjectContest({ currentLevel: 'L0', presentLow: [] }), false, 'presentLow 空 → 不触发');
}

// 8.5 withinMinutes 可覆盖（默认 30）
{
  const messages = [msg('u_a', NOW - 45 * MIN), msg('u_b', NOW - 90 * MIN)];
  const present = R.presentLowLevelUsers({ messages, relationships, now: NOW, withinMinutes: 60 });
  deepEq(present, ['u_a'], 'withinMinutes=60 时 45 分钟前的仍在场');
}

/* ─────────── 9. 关系标签 ─────────── */

eq(R.relationshipTag('L1', levels), '[当前关系标签：熟悉]', 'relationshipTag L1 文本逐字');
eq(R.relationshipTag('L0', levels), '[当前关系标签：高信任]', 'relationshipTag L0 文本逐字');
eq(R.relationshipTag('L2', levels), '[当前关系标签：普通]', 'relationshipTag L2 文本逐字');
eq(R.relationshipTag('L3', levels), '[当前关系标签：低互动]', 'relationshipTag L3 文本逐字');
eq(R.relationshipTag(undefined, levels), '[当前关系标签：普通]', 'level 缺省 → 按 L2 文案「普通」');
eq(R.relationshipTag('L1', { L0: '高信任', L1: '熟悉' }), '[当前关系标签：熟悉]', 'levels 只给了部分键时仍取到 L1');
eq(R.relationshipTag('L1', undefined), '[当前关系标签：普通]', 'levels 缺失 → 兜底「普通」');
eq(R.relationshipTag(undefined, undefined), '[当前关系标签：普通]', 'level 与 levels 都缺省 → 兜底「普通」');

/* ─────────── 10. 纯函数纪律：不写全局、不改入参 ─────────── */

{
  const e = entry({ score: 5, lastDecayAt: PREV_DAY });
  const snapshot = JSON.stringify(e);
  R.scoreEvent(e, 'reply', NOW, CFG);
  R.applyDecay(e, NOW, CFG);
  R.lazyExpireAttitude(e, NOW);
  eq(JSON.stringify(e), snapshot, '三个函数调用后入参对象保持原样（无副作用）');

  const msgs = [msg('u_a', NOW - MIN)];
  const relSnap = JSON.stringify(relationships);
  R.presentLowLevelUsers({ messages: msgs, relationships, now: NOW });
  eq(JSON.stringify(relationships), relSnap, 'presentLowLevelUsers 不改 relationships');
  eq(JSON.stringify(msgs), JSON.stringify([msg('u_a', NOW - MIN)]), 'presentLowLevelUsers 不改 messages');
}

/* ─────────── 11. 坏配置防御（bounds 缺失/空 → 回退图纸默认区间，绝不误判 L0） ─────────── */

{
  eq(R.levelForScore(5, undefined), 'L2', 'bounds 缺失时 5 分回退默认区间 → L2（不误判 L0）');
  eq(R.levelForScore(5, {}), 'L2', 'bounds 为空对象时 5 分 → L2');
  eq(R.levelForScore(-7, {}), 'L3', 'bounds 为空对象时 -7 分 → L3');
  eq(R.levelForScore(30, {}), 'L0', 'bounds 为空对象时 30 分 → L0');
  eq(R.levelForScore(101, {}), 'L0', 'bounds 为空对象时 101 分 → 仍 L0');
  eq(R.levelForScore(-101, {}), 'L3', 'bounds 为空对象时 -101 分 → 仍 L3');
  // 坏配置下 applyDecay 也走兜底区间
  const decayed = R.applyDecay(entry({ score: 5, lastDecayAt: PREV_DAY }), NOW, { decay_per_day: 1 });
  eq(decayed.score, 4, 'cfg 无 level_bounds 时衰减仍生效');
  eq(decayed.level, 'L2', 'cfg 无 level_bounds 时 4 分仍 L2');
  // cfg 整个缺失也不抛（防御坏入参）
  ok(typeof R.applyDecay(entry(), NOW, undefined).score === 'number', 'cfg 缺失时 applyDecay 不抛');
  ok(typeof R.scoreEvent(entry(), 'reply', NOW, undefined).score === 'number', 'cfg 缺失时 scoreEvent 不抛');
}

/* ─────────── 结果 ─────────── */

if (failures.length > 0) {
  console.error(`r4-relationship: ${failures.length} / ${checks} checks FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log(`r4-relationship: passed ${checks} checks`);
process.exit(0);
