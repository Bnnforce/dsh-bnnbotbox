/**
 * R4.0 模块一（时间感知与作息映射）单元测试。
 *
 * 跑法（Node 24 原生驻留类型剥离，直接 import `.ts`）：
 *   cd /path/to/bnnbotbox && node test/r4-time.mjs
 *
 * 覆盖（图纸模块一 + 1.1）：
 *  - 六段注入文本：每段 1 个区间内样本 + 全部边界点（02/06/09/12/15/18/23/00/01:59）；
 *  - 文本**逐字**断言（完整期望串写进断言，不用 includes 糊过去）；
 *  - `zonedTime` 用 Intl timeZone：UTC 2026-10-03T14:30Z → 2026-11-03 22:30（Asia/Shanghai）；
 *  - 装死窗口 [2,6) 与 `wake_probability` 0/1 边界语义（含 random 取 [0,1) 的 0 点）；
 *  - `validateSleepConfig` 只告警、不参与运行逻辑。
 */

import assert from 'node:assert/strict';

const {
  DEFAULT_TIME_ZONE,
  SLEEP_WINDOW,
  zonedTime,
  isSleepWindow,
  timeBlockText,
  sleepWokeText,
  validateSleepConfig,
  shouldWake,
} = await import('../../lib/persona/r4/time.js');

let checks = 0;
function ok(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`r4-time: FAILED -> ${name}`);
    throw error;
  }
}

/** 构造 ZonedTime（`at` 仅占位，模块一文本只用 date/hour）。 */
function zt(date, hour, minute = 0) {
  return { date, hour, minute, at: 0 };
}

/** 按图纸 `[当前时间：YYYY-MM-DD HH:00，<描述>]` 拼**完整**期望串。 */
function expectText(date, hour, desc) {
  return `[当前时间：${date} ${hour < 10 ? `0${hour}` : hour}:00，${desc}]`;
}

const DATE = '2026-11-03';

/** 六段文案（逐字，从图纸表格抄下来，绝不改写标点）。 */
const BLOCK_DESC = {
  dawn: '清晨。你刚醒，慵懒但充满朝气。',
  morning: '上午。你精力充沛，喜欢调侃。',
  noon: '午后。你在晒太阳，犯困，慢条斯理。',
  evening: '傍晚。你在打扮赴宴，自信自恋。',
  night: '夜晚。你最兴奋，活跃开玩笑。',
  lateNight: '深夜。你心防微开，温柔轻柔。',
};

/* ───────────── 1. 常量与装死窗口 ───────────── */

ok('SLEEP_WINDOW 固定为 02:00-06:00', () => {
  assert.deepEqual(SLEEP_WINDOW, { startHour: 2, endHour: 6 });
});
ok('DEFAULT_TIME_ZONE = Asia/Shanghai', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');
});
ok('sleepWokeText 逐字', () => {
  assert.equal(sleepWokeText(), '[状态：熟睡被吵醒，语气朦胧]');
});

/* ───────────── 2. isSleepWindow（含 2，不含 6） ───────────── */

ok('isSleepWindow 覆盖全部关键点', () => {
  // 窗口内：2、3、5
  assert.equal(isSleepWindow(2), true);
  assert.equal(isSleepWindow(3), true);
  assert.equal(isSleepWindow(5), true);
  // 窗口外边界：1（深夜段）、6（清晨段）、0（深夜段）
  assert.equal(isSleepWindow(1), false);
  assert.equal(isSleepWindow(6), false);
  assert.equal(isSleepWindow(0), false);
  assert.equal(isSleepWindow(-1), false);
  assert.equal(isSleepWindow(24), false);
  // 非数字不抛、判否
  assert.equal(isSleepWindow(Number.NaN), false);
  assert.equal(isSleepWindow(undefined), false);
});

/* ───────────── 3. 六段：每段 1 个区间内样本（逐字全串断言） ───────────── */

ok('区间内样本：07:00 → 清晨', () => {
  assert.equal(timeBlockText(zt(DATE, 7, 15)), expectText(DATE, 7, BLOCK_DESC.dawn));
});
ok('区间内样本：10:00 → 上午', () => {
  assert.equal(timeBlockText(zt(DATE, 10, 42)), expectText(DATE, 10, BLOCK_DESC.morning));
});
ok('区间内样本：13:00 → 午后', () => {
  assert.equal(timeBlockText(zt(DATE, 13, 59)), expectText(DATE, 13, BLOCK_DESC.noon));
});
ok('区间内样本：16:00 → 傍晚', () => {
  assert.equal(timeBlockText(zt(DATE, 16, 5)), expectText(DATE, 16, BLOCK_DESC.evening));
});
ok('区间内样本：20:00 → 夜晚', () => {
  assert.equal(timeBlockText(zt(DATE, 20, 30)), expectText(DATE, 20, BLOCK_DESC.night));
});
ok('区间内样本：01:00 → 深夜（跨日）', () => {
  assert.equal(timeBlockText(zt(DATE, 1, 0)), expectText(DATE, 1, BLOCK_DESC.lateNight));
});

/* ───────────── 4. 全部边界点（逐字全串断言） ───────────── */

ok('边界 02:00 → 装死（空串，不归深夜）', () => {
  assert.equal(timeBlockText(zt(DATE, 2, 0)), '');
});
ok('边界 03:00 → 装死区内部（空串）', () => {
  assert.equal(timeBlockText(zt(DATE, 3, 0)), '');
});
ok('边界 05:59 → 仍在装死（hour=5，空串）', () => {
  assert.equal(timeBlockText(zt(DATE, 5, 59)), '');
});
ok('边界 06:00 → 清晨（含 06:00）', () => {
  assert.equal(timeBlockText(zt(DATE, 6, 0)), expectText(DATE, 6, BLOCK_DESC.dawn));
});
ok('边界 09:00 → 上午（清晨闭区间结束）', () => {
  assert.equal(timeBlockText(zt(DATE, 9, 0)), expectText(DATE, 9, BLOCK_DESC.morning));
});
ok('边界 08:59 → 清晨（hour=8）', () => {
  assert.equal(timeBlockText(zt(DATE, 8, 59)), expectText(DATE, 8, BLOCK_DESC.dawn));
});
ok('边界 12:00 → 午后', () => {
  assert.equal(timeBlockText(zt(DATE, 12, 0)), expectText(DATE, 12, BLOCK_DESC.noon));
});
ok('边界 15:00 → 傍晚', () => {
  assert.equal(timeBlockText(zt(DATE, 15, 0)), expectText(DATE, 15, BLOCK_DESC.evening));
});
ok('边界 18:00 → 夜晚', () => {
  assert.equal(timeBlockText(zt(DATE, 18, 0)), expectText(DATE, 18, BLOCK_DESC.night));
});
ok('边界 23:00 → 深夜（23 归深夜）', () => {
  assert.equal(timeBlockText(zt(DATE, 23, 0)), expectText(DATE, 23, BLOCK_DESC.lateNight));
});
ok('边界 00:00 → 深夜（跨日零点）', () => {
  assert.equal(timeBlockText(zt(DATE, 0, 0)), expectText(DATE, 0, BLOCK_DESC.lateNight));
});
ok('边界 01:59 → 深夜且分钟截断为 00', () => {
  const t = zt(DATE, 1, 59);
  assert.equal(timeBlockText(t), expectText(DATE, 1, BLOCK_DESC.lateNight));
  // 分钟恒为 00：显式确认期望串里没有 59。
  assert.equal(timeBlockText(t).includes('01:59'), false);
  assert.equal(timeBlockText(t).includes(':00'), true);
});
ok('22:59 → 夜晚（深夜段开始前）', () => {
  assert.equal(timeBlockText(zt(DATE, 22, 59)), expectText(DATE, 22, BLOCK_DESC.night));
});

/* ───────────── 5. 全部六段穷举（hour 0-23 全覆盖，逐字对表） ───────────── */

ok('hour 0-23 全量对表（六段 + 装死）', () => {
  const expected = new Map([
    [0, expectText(DATE, 0, BLOCK_DESC.lateNight)],
    [1, expectText(DATE, 1, BLOCK_DESC.lateNight)],
    [2, ''],
    [3, ''],
    [4, ''],
    [5, ''],
    [6, expectText(DATE, 6, BLOCK_DESC.dawn)],
    [7, expectText(DATE, 7, BLOCK_DESC.dawn)],
    [8, expectText(DATE, 8, BLOCK_DESC.dawn)],
    [9, expectText(DATE, 9, BLOCK_DESC.morning)],
    [10, expectText(DATE, 10, BLOCK_DESC.morning)],
    [11, expectText(DATE, 11, BLOCK_DESC.morning)],
    [12, expectText(DATE, 12, BLOCK_DESC.noon)],
    [13, expectText(DATE, 13, BLOCK_DESC.noon)],
    [14, expectText(DATE, 14, BLOCK_DESC.noon)],
    [15, expectText(DATE, 15, BLOCK_DESC.evening)],
    [16, expectText(DATE, 16, BLOCK_DESC.evening)],
    [17, expectText(DATE, 17, BLOCK_DESC.evening)],
    [18, expectText(DATE, 18, BLOCK_DESC.night)],
    [19, expectText(DATE, 19, BLOCK_DESC.night)],
    [20, expectText(DATE, 20, BLOCK_DESC.night)],
    [21, expectText(DATE, 21, BLOCK_DESC.night)],
    [22, expectText(DATE, 22, BLOCK_DESC.night)],
    [23, expectText(DATE, 23, BLOCK_DESC.lateNight)],
  ]);
  for (let hour = 0; hour < 24; hour += 1) {
    assert.equal(timeBlockText(zt(DATE, hour, 30)), expected.get(hour), `hour=${hour} 文案不符`);
  }
});

ok('timeBlockText 非法入参不抛错', () => {
  assert.equal(timeBlockText(null), '');
  assert.equal(timeBlockText(undefined), '');
  assert.equal(timeBlockText({ date: DATE, hour: Number.NaN, minute: 0, at: 0 }), '');
  assert.equal(timeBlockText({ date: '', hour: 7, minute: 0, at: 0 }), '');
});

/* ───────────── 6. zonedTime：Intl timeZone（不依赖系统 TZ） ───────────── */

ok('zonedTime(UTC 2026-11-03T14:30Z) → 2026-11-03 22:30（Asia/Shanghai）', () => {
  const nowMs = Date.UTC(2026, 10, 3, 14, 30, 0);
  const t = zonedTime(nowMs);
  assert.equal(t.date, '2026-11-03');
  assert.equal(t.hour, 22);
  assert.equal(t.minute, 30);
  assert.equal(t.at, nowMs);
});
ok('zonedTime 显式传 Asia/Shanghai 与默认一致', () => {
  const nowMs = Date.UTC(2026, 10, 3, 14, 30, 0);
  assert.deepEqual(zonedTime(nowMs, 'Asia/Shanghai'), zonedTime(nowMs));
});
ok('zonedTime 跨日：UTC 16:30Z = 北京时间次日 00:30', () => {
  const t = zonedTime(Date.UTC(2026, 10, 3, 16, 30, 0));
  assert.equal(t.date, '2026-11-04');
  assert.equal(t.hour, 0);
  assert.equal(t.minute, 30);
});
ok('zonedTime 午夜为 00 而不是 12（h23 语义）', () => {
  const t = zonedTime(Date.UTC(2026, 9, 31, 16, 0, 0)); // 北京 2026-11-01 00:00
  assert.equal(t.date, '2026-11-01');
  assert.equal(t.hour, 0);
  assert.equal(t.minute, 0);
});
ok('zonedTime 用其它时区（UTC）也正确', () => {
  const t = zonedTime(Date.UTC(2026, 10, 3, 14, 30, 0), 'UTC');
  assert.equal(t.date, '2026-11-03');
  assert.equal(t.hour, 14);
  assert.equal(t.minute, 30);
});
ok('zonedTime 非法时区回退 Asia/Shanghai 且不抛错', () => {
  const t = zonedTime(Date.UTC(2026, 10, 3, 14, 30, 0), 'Not/AZone');
  assert.equal(t.date, '2026-11-03');
  assert.equal(t.hour, 22);
});
ok('zonedTime 非法时间戳不抛错', () => {
  const t = zonedTime(Number.NaN);
  assert.equal(typeof t.date, 'string');
  assert.equal(Number.isInteger(t.hour), true);
  assert.equal(Number.isInteger(t.minute), true);
});
ok('zonedTime 与 timeBlockText 串联：北京时间 22:30 → 夜晚文案（分钟截断 22:00）', () => {
  const t = zonedTime(Date.UTC(2026, 10, 3, 14, 30, 0));
  assert.equal(timeBlockText(t), expectText(DATE, 22, BLOCK_DESC.night));
});
ok('zonedTime 与 isSleepWindow 串联：北京 03:00 ∈ [2,6)', () => {
  const t = zonedTime(Date.UTC(2026, 10, 2, 19, 0, 0)); // 北京 2026-11-03 03:00
  assert.equal(t.date, '2026-11-03');
  assert.equal(t.hour, 3);
  assert.equal(isSleepWindow(t.hour), true);
  assert.equal(timeBlockText(t), '');
});

/* ───────────── 7. shouldWake：random < p 放行 ───────────── */

ok('shouldWake(0, 任意) 全丢弃（含 random=0 的 [0,1) 左边界）', () => {
  assert.equal(shouldWake(0, () => 0.0), false);
  assert.equal(shouldWake(0, () => 0.5), false);
  assert.equal(shouldWake(0, () => 0.999999), false);
});
ok('shouldWake(1, 任意) 全放行（含 random=0）', () => {
  assert.equal(shouldWake(1, () => 0.999), true);
  assert.equal(shouldWake(1, () => 0), true);
  assert.equal(shouldWake(1, () => 0.5), true);
});
ok('shouldWake(0.7, ...) 语义：0.699 放行 / 0.7 丢弃', () => {
  assert.equal(shouldWake(0.7, () => 0.699), true);
  assert.equal(shouldWake(0.7, () => 0.7), false);
  assert.equal(shouldWake(0.7, () => 0.71), false);
});
ok('shouldWake 概率钳制到 [0,1]', () => {
  assert.equal(shouldWake(1.5, () => 0.999), true);
  assert.equal(shouldWake(-0.5, () => 0), false);
  assert.equal(shouldWake(2, () => 0.999999), true);
  assert.equal(shouldWake(-1, () => 0.5), false);
});
ok('shouldWake NaN 概率 → 按 0.7', () => {
  assert.equal(shouldWake(Number.NaN, () => 0.69), true);
  assert.equal(shouldWake(Number.NaN, () => 0.7), false);
  assert.equal(shouldWake(undefined, () => 0.69), true);
});
ok('shouldWake random 异常/非数字 → 丢弃，不误放行、不抛错', () => {
  assert.equal(shouldWake(1, () => Number.NaN), false);
  assert.equal(shouldWake(1, () => undefined), false);
  assert.equal(shouldWake(1, () => {
    throw new Error('boom');
  }), false);
  assert.equal(shouldWake(1, undefined), false);
});
ok('shouldWake 边界：钳到 1 后 random 极接近 1 仍放行', () => {
  assert.equal(shouldWake(0.9999999999, () => 0.99999), true);
});

/* ───────────── 8. validateSleepConfig：只告警 ───────────── */

ok('validateSleepConfig 正确配置 → []', () => {
  assert.deepEqual(validateSleepConfig({ sleep_start: '02:00', sleep_end: '06:00' }), []);
});
ok('validateSleepConfig 03:00/07:00 → 长度 1 且含「02:00」', () => {
  const warnings = validateSleepConfig({ sleep_start: '03:00', sleep_end: '07:00' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('02:00'), true);
  assert.equal(typeof warnings[0], 'string');
});
ok('validateSleepConfig 只错一端也告警', () => {
  assert.equal(validateSleepConfig({ sleep_start: '02:00', sleep_end: '07:00' }).length, 1);
  assert.equal(validateSleepConfig({ sleep_start: '03:00', sleep_end: '06:00' }).length, 1);
  assert.equal(validateSleepConfig({ sleep_start: '02:30', sleep_end: '06:00' }).length, 1);
});
ok('validateSleepConfig 缺字段/脏入参不抛错', () => {
  assert.equal(validateSleepConfig({}).length, 1);
  assert.equal(validateSleepConfig({ sleep_start: '02:00' }).length, 1);
  assert.equal(validateSleepConfig(undefined).length, 1);
});
ok('validateSleepConfig 不影响运行逻辑：窗口恒为 02:00-06:00', () => {
  // 即使传入错误配置，isSleepWindow 仍按固定窗口判定（不读配置值）。
  const warnings = validateSleepConfig({ sleep_start: '03:00', sleep_end: '07:00' });
  assert.equal(warnings.length, 1);
  assert.equal(isSleepWindow(3), true);
  assert.equal(isSleepWindow(6), false);
  assert.deepEqual(SLEEP_WINDOW, { startHour: 2, endHour: 6 });
});

/* ───────────── 9. 纯函数 / 无抛错兜底 ───────────── */

ok('模块导出函数均为 function 且不抛错', () => {
  for (const fn of [zonedTime, isSleepWindow, timeBlockText, sleepWokeText, validateSleepConfig, shouldWake]) {
    assert.equal(typeof fn, 'function');
  }
  // 反复调用幂等（纯函数：同一入参同一出参）
  const a = timeBlockText(zt(DATE, 20, 30));
  const b = timeBlockText(zt(DATE, 20, 30));
  assert.equal(a, b);
});

console.log(`r4-time: passed ${checks} checks`);
process.exitCode = 0;
