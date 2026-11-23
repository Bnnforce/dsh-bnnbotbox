/**
 * R4.0 模块二（心跳状态机 + 有人回复判定）单元测试。
 *
 * 跑法：
 *   cd /path/to/bnnbotbox && node test/r4-heartbeat.mjs
 *
 * 为什么测试文件里有一个 resolve hook：
 *  - 源码按工程惯例用 ESM 的 `.js` 后缀 import 兄弟模块（`./time.js`、`./types.js`），
 *    tsc 编译后同名 `.js` 存在；但本机 Node 24.18（amaro 1.1.9）**不做**
 *    `.js` → `.ts` 的隐式映射，直接 `import('../../lib/persona/r4/heartbeat.js')` 会在
 *    `./time.js` 上 ERR_MODULE_NOT_FOUND。
 *  - 所以测试启动时 `registerHooks` 把「父文件是 .ts、说明符以 .js 结尾、同名 .ts 存在」
 *    的解析改到 `.ts`。**只影响本测试进程**，不改源码、不改工程配置。
 *
 * 覆盖（图纸 2.1 / 2.2 / 2.3 / 2.4）：
 *  - 5 条前置跳过各 1 例 + 死群边界（`now-lastNonBotMessageAt = 2h` 不跳过、`2h+1ms` 跳过）；
 *  - 跳过顺序严格（装死 > 每日上限、死群 > waiting 未到期）；
 *  - `normal → waiting` 四字段断言；跨天重置与跳过的关系；
 *  - 发送失败回滚：`dailyCount` 不为负、`lastBotMessageAt` 不动；
 *  - waiting 到期（有人回复 → normal / 无人回复 → cooldown+cold+3h）；
 *  - cooldown 内有人回复 → cold=false；cooldown 到期 → normal 且 cold 保留；
 *  - coldSetAt 超 24h → cold=false 且 coldSetAt 清 0；恰好 24h → 仍是 cold；
 *  - `nextIntervalMs` 抖动区间 / 5 分钟下限 / NaN 与抛错兜底；
 *  - 有人回复 A（`<@BOTID>`）/ B（quoteOfSelf）/ C（关键词、正则、超窗、非首条、单字「吗」、从没发过）。
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith('.js')
      && typeof context.parentURL === 'string'
      && context.parentURL.endsWith('.js')
    ) {
      const candidate = new URL(specifier.replace(/\.js$/u, '.js'), context.parentURL);
      if (candidate.protocol === 'file:' && existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const hb = await import('../../lib/persona/r4/heartbeat.js');
const rd = await import('../../lib/persona/r4/reply-detect.js');

let checks = 0;
function ok(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`r4-heartbeat: FAILED -> ${name}`);
    throw error;
  }
}

/* ───────────── 公共夹具 ───────────── */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** 2026-11-03 12:00:00 Asia/Shanghai（UTC 04:00）。用 UTC 构造，不依赖系统时区。 */
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);
const DATE = '2026-11-03';
/** 2026-11-03 03:00 Asia/Shanghai（UTC 前一天 19:00）—— 落在装死窗口 [2,6)。 */
const SLEEP_NOW = Date.UTC(2026, 10, 2, 19, 0, 0);

/** 图纸默认心跳配置（与 config.ts DEFAULT_CONFIG 逐字一致）。 */
const CFG = {
  interval_minutes: 45,
  jitter_minutes: 15,
  max_daily: 5,
  cooldown_hours: 3,
  heartbeatMaxTokens: 200,
  heartbeatTimeoutMs: 5000,
};

/** 图纸默认回复判定配置（与 config.ts DEFAULT_CONFIG 逐字一致）。 */
const RD_CFG = {
  window_minutes: 10,
  keywords: ['哈哈', '确实', '真的吗', '怎么说', '为什么', '然后呢', '你觉得'],
  question_regex: '([?？]|[吗呢][?？])$',
};

/** 构造一个「不跳过」的正常状态：非死群、normal、当日已重置、未超每日上限。 */
function st(over = {}) {
  return {
    date: DATE,
    dailyCount: 0,
    lastNonBotMessageAt: NOW - 10 * MIN,
    lastBotMessageAt: 0,
    state: 'normal',
    cold: false,
    coldSetAt: 0,
    waitingUntil: 0,
    cooldownUntil: 0,
    ...over,
  };
}

/** evaluateTick 的最简入参（其余用默认夹具）。 */
function tick(state, over = {}) {
  return hb.evaluateTick({
    state,
    now: NOW,
    date: DATE,
    heartbeat: CFG,
    lastNonBotMessageAt: NOW - 10 * MIN,
    ...over,
  });
}

/** 构造一条消息。 */
function msg(fields) {
  return {
    senderId: fields.self === true ? 'self' : (fields.senderId ?? 'u1'),
    text: fields.text ?? '',
    at: fields.at ?? 0,
    self: fields.self === true,
    ...fields,
  };
}

/* ───────────── 1. 导出形状 ───────────── */

ok('模块导出齐全且均为 function', () => {
  for (const fn of [
    hb.resetIfNewDay,
    hb.evaluateTick,
    hb.markWaitSent,
    hb.rollbackWaitSent,
    hb.onSomeoneReplied,
    hb.expireWaitingToCooldown,
    hb.onCooldownExpired,
    hb.enforceColdExpiry,
    hb.nextIntervalMs,
    rd.hasSomeoneReplied,
  ]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(hb.WAITING_MINUTES, 15);
  assert.equal(hb.MIN_INTERVAL_MS, 5 * MIN);
  assert.equal(hb.DEAD_GROUP_MS, 2 * HOUR);
});

/* ───────────── 2. resetIfNewDay（跨天重置） ───────────── */

ok('resetIfNewDay：date 不同 → dailyCount=0、date=今天，其余字段不动、不改入参', () => {
  const input = st({ date: '2026-11-02', dailyCount: 4, cold: true, coldSetAt: NOW - HOUR });
  const before = JSON.parse(JSON.stringify(input));
  const next = hb.resetIfNewDay(input, { date: DATE, at: NOW });
  assert.equal(next.date, DATE);
  assert.equal(next.dailyCount, 0);
  assert.equal(next.state, input.state);
  assert.equal(next.lastBotMessageAt, input.lastBotMessageAt);
  assert.equal(next.lastNonBotMessageAt, input.lastNonBotMessageAt);
  assert.equal(next.cold, true);
  assert.equal(next.coldSetAt, input.coldSetAt);
  assert.equal(next.waitingUntil, input.waitingUntil);
  assert.equal(next.cooldownUntil, input.cooldownUntil);
  assert.deepEqual(input, before, 'resetIfNewDay 不得修改入参');
  assert.notEqual(next, input, '必须返回新对象');
});

ok('resetIfNewDay：date 相同 → 原样返回（仍是新对象）', () => {
  const input = st({ dailyCount: 3 });
  const next = hb.resetIfNewDay(input, { date: DATE, at: NOW });
  assert.equal(next.date, DATE);
  assert.equal(next.dailyCount, 3);
  assert.notEqual(next, input);
});

/* ───────────── 3. markWaitSent / rollbackWaitSent ───────────── */

ok('markWaitSent：state=waiting、waitingUntil=now+15min、lastBotMessageAt=now、dailyCount+1', () => {
  const input = st({ dailyCount: 2 });
  const before = JSON.parse(JSON.stringify(input));
  const next = hb.markWaitSent(input, NOW);
  assert.equal(next.state, 'waiting');
  assert.equal(next.waitingUntil, NOW + 15 * MIN);
  assert.equal(next.lastBotMessageAt, NOW);
  assert.equal(next.dailyCount, 3);
  // 其余字段保持
  assert.equal(next.date, input.date);
  assert.equal(next.lastNonBotMessageAt, input.lastNonBotMessageAt);
  assert.equal(next.cold, input.cold);
  assert.equal(next.coldSetAt, input.coldSetAt);
  assert.equal(next.cooldownUntil, input.cooldownUntil);
  assert.deepEqual(input, before, 'markWaitSent 不得修改入参');
});

ok('markWaitSent：自定义 waitingMinutes 生效', () => {
  const next = hb.markWaitSent(st(), NOW, 7);
  assert.equal(next.waitingUntil, NOW + 7 * MIN);
});

ok('rollbackWaitSent：state=normal、waitingUntil=0、dailyCount-1、lastBotMessageAt 不动', () => {
  const sent = hb.markWaitSent(st({ dailyCount: 1 }), NOW);
  const next = hb.rollbackWaitSent(sent);
  assert.equal(next.state, 'normal');
  assert.equal(next.waitingUntil, 0);
  assert.equal(next.dailyCount, 1); // 2 - 1
  assert.equal(next.lastBotMessageAt, NOW, '回滚不回滚 lastBotMessageAt（失败消息未进入历史）');
});

ok('rollbackWaitSent：dailyCount 不得为负', () => {
  assert.equal(hb.rollbackWaitSent(st({ dailyCount: 0 })).dailyCount, 0);
  assert.equal(hb.rollbackWaitSent(st({ dailyCount: 1 })).dailyCount, 0);
});

/* ───────────── 4. 状态迁移纯函数 ───────────── */

ok('onSomeoneReplied：waiting → normal、waitingUntil=0', () => {
  const next = hb.onSomeoneReplied(st({ state: 'waiting', waitingUntil: NOW + 15 * MIN }), NOW, 3);
  assert.equal(next.state, 'normal');
  assert.equal(next.waitingUntil, 0);
});

ok('onSomeoneReplied：cooldown → normal、cooldownUntil=0、cold=false', () => {
  const next = hb.onSomeoneReplied(
    st({ state: 'cooldown', cooldownUntil: NOW + 3 * HOUR, cold: true, coldSetAt: NOW }),
    NOW,
    3,
  );
  assert.equal(next.state, 'normal');
  assert.equal(next.cooldownUntil, 0);
  assert.equal(next.cold, false);
  assert.equal(next.coldSetAt, 0);
});

ok('onSomeoneReplied：normal → 原样（新对象）', () => {
  const input = st({ state: 'normal' });
  const next = hb.onSomeoneReplied(input, NOW, 3);
  assert.equal(next.state, 'normal');
  assert.equal(next.waitingUntil, input.waitingUntil);
  assert.equal(next.cold, input.cold);
});

ok('expireWaitingToCooldown：cooldownUntil=now+3h、cold=true、coldSetAt=now、waitingUntil 清 0', () => {
  const next = hb.expireWaitingToCooldown(st({ state: 'waiting', waitingUntil: NOW }), NOW, 3);
  assert.equal(next.state, 'cooldown');
  assert.equal(next.cooldownUntil, NOW + 3 * HOUR);
  assert.equal(next.cold, true);
  assert.equal(next.coldSetAt, NOW);
  assert.equal(next.waitingUntil, 0);
});

ok('onCooldownExpired：state=normal 且 cold 保留（cooldownUntil 不动）', () => {
  const input = st({ state: 'cooldown', cooldownUntil: NOW, cold: true, coldSetAt: NOW - 3 * HOUR });
  const next = hb.onCooldownExpired(input, NOW);
  assert.equal(next.state, 'normal');
  assert.equal(next.cold, true, 'cooldown 到期后 cold 必须保留');
  assert.equal(next.coldSetAt, input.coldSetAt);
  assert.equal(next.cooldownUntil, input.cooldownUntil);
});

/* ───────────── 5. 24h cold 兜底 ───────────── */

ok('enforceColdExpiry：coldSetAt 超 24h → cold=false 且 coldSetAt 清 0', () => {
  const next = hb.enforceColdExpiry(st({ cold: true, coldSetAt: NOW - 24 * HOUR - 1 }), NOW);
  assert.equal(next.cold, false);
  assert.equal(next.coldSetAt, 0, 'coldSetAt 清 0（避免 cold=false 残留过期时间戳）');
});

ok('enforceColdExpiry：恰好 24h 仍算 cold（严格大于）', () => {
  const next = hb.enforceColdExpiry(st({ cold: true, coldSetAt: NOW - 24 * HOUR }), NOW);
  assert.equal(next.cold, true);
  assert.equal(next.coldSetAt, NOW - 24 * HOUR);
});

ok('enforceColdExpiry：cold=false 原样、可自定义 hours', () => {
  assert.equal(hb.enforceColdExpiry(st({ cold: false }), NOW).cold, false);
  const next = hb.enforceColdExpiry(st({ cold: true, coldSetAt: NOW - 2 * HOUR }), NOW, 1);
  assert.equal(next.cold, false);
});

/* ───────────── 6. nextIntervalMs（抖动 + 5 分钟下限） ───────────── */

/** 确定性伪随机（LCG），避免测试抖动。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

ok('nextIntervalMs：200 次随机都落在 [base-jitter, base+jitter] 且不小于 5 分钟', () => {
  const base = CFG.interval_minutes * MIN; // 45min
  const jitter = CFG.jitter_minutes * MIN; // 15min
  const random = lcg(20261103);
  for (let i = 0; i < 200; i += 1) {
    const ms = hb.nextIntervalMs(CFG, random);
    assert.ok(ms >= base - jitter, `第 ${i} 次低于下界：${ms}`);
    assert.ok(ms <= base + jitter, `第 ${i} 次高于上界：${ms}`);
    assert.ok(ms >= hb.MIN_INTERVAL_MS, `第 ${i} 次低于 5 分钟下限：${ms}`);
    assert.equal(Number.isInteger(ms), true);
  }
});

ok('nextIntervalMs：random=0 → base-jitter；random=1 → base+jitter', () => {
  const base = CFG.interval_minutes * MIN;
  const jitter = CFG.jitter_minutes * MIN;
  assert.equal(hb.nextIntervalMs(CFG, () => 0), base - jitter);
  assert.equal(hb.nextIntervalMs(CFG, () => 1), base + jitter);
});

ok('nextIntervalMs：计算结果低于 5 分钟时被钳到下限', () => {
  const tiny = { ...CFG, interval_minutes: 1, jitter_minutes: 5 };
  assert.equal(hb.nextIntervalMs(tiny, () => 0), hb.MIN_INTERVAL_MS);
  assert.equal(hb.nextIntervalMs(tiny, () => 0.5), hb.MIN_INTERVAL_MS); // 1min 本身 < 5min
});

ok('nextIntervalMs：NaN/抛错/越界 random 都不抛且按 0.5 兜底', () => {
  const base = CFG.interval_minutes * MIN;
  assert.equal(hb.nextIntervalMs(CFG, () => Number.NaN), base);
  assert.equal(hb.nextIntervalMs(CFG, () => { throw new Error('boom'); }), base);
  assert.equal(hb.nextIntervalMs(CFG, () => 2), base + CFG.jitter_minutes * MIN); // 钳到 1
});

/* ───────────── 7. evaluateTick：前置跳过 5 条（顺序严格） ───────────── */

ok('跳过 1/5：装死窗口 03:00 → 跳过，不计数不发送不改状态', () => {
  const state = st({ date: '2026-11-03', lastNonBotMessageAt: SLEEP_NOW - 10 * MIN });
  const result = hb.evaluateTick({
    state,
    now: SLEEP_NOW,
    date: '2026-11-03',
    heartbeat: CFG,
    lastNonBotMessageAt: SLEEP_NOW - 10 * MIN,
  });
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.equal(result.state.dailyCount, 0);
  assert.equal(result.state.state, 'normal');
  assert.match(result.skipReason, /装死/u);
});

ok('跳过 2/5：死群（now-lastNonBotMessageAt = 2h+1ms）→ 跳过', () => {
  const lastNonBot = NOW - 2 * HOUR - 1;
  const result = tick(st({ lastNonBotMessageAt: lastNonBot }), { lastNonBotMessageAt: lastNonBot });
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.match(result.skipReason, /死群/u);
});

ok('死群边界：now-lastNonBotMessageAt = 2h 整 → 不跳过（严格大于才跳过）', () => {
  const lastNonBot = NOW - 2 * HOUR;
  const result = tick(st({ lastNonBotMessageAt: lastNonBot }), { lastNonBotMessageAt: lastNonBot });
  assert.equal(result.shouldSend, true);
});

ok('跳过 3/5：state=waiting 且 now < waitingUntil → 跳过', () => {
  const result = tick(st({ state: 'waiting', waitingUntil: NOW + 15 * MIN }));
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.match(result.skipReason, /waiting 等待期内/u);
});

ok('跳过 4/5：state=cooldown 且 now < cooldownUntil → 跳过', () => {
  const result = tick(st({ state: 'cooldown', cooldownUntil: NOW + 3 * HOUR, cold: true, coldSetAt: NOW }));
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.match(result.skipReason, /cooldown 冷却期内/u);
});

ok('跳过 5/5：dailyCount >= max_daily → 跳过（不发送不计数）', () => {
  const result = tick(st({ dailyCount: 5 }));
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.equal(result.state.dailyCount, 5);
  assert.match(result.skipReason, /上限/u);
});

ok('顺序严格：装死窗口优先于每日上限（两条都命中时报装死）', () => {
  const state = st({ date: '2026-11-03', dailyCount: 5, lastNonBotMessageAt: SLEEP_NOW - 10 * MIN });
  const result = hb.evaluateTick({
    state,
    now: SLEEP_NOW,
    date: '2026-11-03',
    heartbeat: CFG,
    lastNonBotMessageAt: SLEEP_NOW - 10 * MIN,
  });
  assert.match(result.skipReason, /装死/u);
});

ok('顺序严格：死群优先于 waiting 未到期（两条都命中时报死群）', () => {
  const lastNonBot = NOW - 2 * HOUR - 1;
  const result = tick(
    st({ state: 'waiting', waitingUntil: NOW + 15 * MIN, lastNonBotMessageAt: lastNonBot }),
    { lastNonBotMessageAt: lastNonBot },
  );
  assert.match(result.skipReason, /死群/u);
});

/* ───────────── 8. evaluateTick：normal → waiting ───────────── */

ok('normal 触发心跳 → state=waiting、waitingUntil=now+15min、lastBotMessageAt=now、dailyCount=1', () => {
  const input = st({ dailyCount: 0 });
  const before = JSON.parse(JSON.stringify(input));
  const result = tick(input);
  assert.equal(result.shouldSend, true);
  assert.equal(result.changed, true);
  assert.equal(result.skipReason, undefined);
  assert.equal(result.state.state, 'waiting');
  assert.equal(result.state.waitingUntil, NOW + 15 * MIN);
  assert.equal(result.state.lastBotMessageAt, NOW);
  assert.equal(result.state.dailyCount, 1);
  // 其余字段不动
  assert.equal(result.state.date, DATE);
  assert.equal(result.state.lastNonBotMessageAt, input.lastNonBotMessageAt);
  assert.equal(result.state.cold, input.cold);
  assert.equal(result.state.coldSetAt, input.coldSetAt);
  assert.equal(result.state.cooldownUntil, input.cooldownUntil);
  assert.deepEqual(input, before, 'evaluateTick 不得修改入参状态');
});

ok('跨天：date 不匹配 → 先重置 dailyCount=0 再 +1（结果 1，不是 6）', () => {
  const result = tick(st({ date: '2026-11-02', dailyCount: 5 }));
  assert.equal(result.shouldSend, true, '重置后 dailyCount=0 < max_daily，不应被上限跳过');
  assert.equal(result.state.dailyCount, 1);
  assert.equal(result.state.date, DATE);
});

ok('跨天 + 上限：昨日 dailyCount=5 不能挡住今天（重置优先于上限判定）', () => {
  const result = tick(st({ date: '2026-11-02', dailyCount: 5 }));
  assert.match(String(result.skipReason ?? ''), /^$/u);
  assert.equal(result.shouldSend, true);
});

/* ───────────── 9. evaluateTick：waiting 到期的两条分支 ───────────── */

ok('waiting 到期 + repliedDuringWait=true → normal、waitingUntil=0（不发发送）', () => {
  const state = st({ state: 'waiting', waitingUntil: NOW - 1, dailyCount: 1, lastBotMessageAt: NOW - 16 * MIN });
  const result = tick(state, { repliedDuringWait: true });
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, true);
  assert.equal(result.state.state, 'normal');
  assert.equal(result.state.waitingUntil, 0);
  assert.match(result.skipReason, /有人回复/u);
});

ok('waiting 到期 + repliedDuringWait=false（缺省）→ cooldown、cold=true、coldSetAt=now、cooldownUntil=now+3h', () => {
  const state = st({ state: 'waiting', waitingUntil: NOW - 1, dailyCount: 1, lastBotMessageAt: NOW - 16 * MIN });
  const result = tick(state);
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, true);
  assert.equal(result.state.state, 'cooldown');
  assert.equal(result.state.cold, true);
  assert.equal(result.state.coldSetAt, NOW);
  assert.equal(result.state.cooldownUntil, NOW + 3 * HOUR);
  assert.equal(result.state.waitingUntil, 0);
  assert.match(result.skipReason, /cooldown/u);
});

ok('waiting 未到期 + repliedDuringWait=true 不生效（等待期内仍跳过，状态不动）', () => {
  const state = st({ state: 'waiting', waitingUntil: NOW + 15 * MIN });
  const result = tick(state, { repliedDuringWait: true });
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, false);
  assert.equal(result.state.state, 'waiting');
  assert.equal(result.state.waitingUntil, NOW + 15 * MIN);
});

/* ───────────── 10. evaluateTick：cooldown 到期 ───────────── */

ok('cooldown 到期且无人回复 → normal 且 cold 保留（迁移 tick 不发送）', () => {
  const state = st({ state: 'cooldown', cooldownUntil: NOW, cold: true, coldSetAt: NOW - 3 * HOUR, dailyCount: 1 });
  const result = tick(state);
  assert.equal(result.shouldSend, false);
  assert.equal(result.changed, true);
  assert.equal(result.state.state, 'normal');
  assert.equal(result.state.cold, true);
  assert.equal(result.state.coldSetAt, NOW - 3 * HOUR);
});

/* ───────────── 11. 有人回复判定（图纸 2.2） ───────────── */

const BOT_ID = 'BOTID';
const BOT_AT = NOW - 30 * MIN;

ok('A：消息文本含 <@BOTID> → true', () => {
  const messages = [msg({ self: false, at: NOW - 5 * MIN, text: `前面的 <@${BOT_ID}> 后面` })];
  assert.equal(rd.hasSomeoneReplied({ state: st(), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('A：bot 自己发的消息里出现 <@BOTID> 不算「有人回复」', () => {
  const messages = [msg({ self: true, at: NOW - 5 * MIN, text: `<@${BOT_ID}> 自言自语` })];
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: NOW - 5 * MIN }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('B：quoteOfSelf=true → true', () => {
  const messages = [msg({ self: false, at: NOW - 5 * MIN, text: '随便说点什么', quoteOfSelf: true })];
  assert.equal(rd.hasSomeoneReplied({ state: st(), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('B：quoteOfSelf 只认非 bot 消息（bot 自己的引用标记不算）', () => {
  const messages = [msg({ self: true, at: NOW - 5 * MIN, text: 'x', quoteOfSelf: true })];
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: NOW - 5 * MIN }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

/** C 场景：bot 最后一条在 BOT_AT，之后给若干条回复。 */
function cMessages(replies) {
  return [msg({ self: true, at: BOT_AT, text: 'bot 的心跳' }), ...replies];
}

ok('C 关键词命中（真的吗，无问号 → 只可能靠关键词）→ true', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '真的吗' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('C 关键词命中（为什么）→ true', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '为什么' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('C 正则命中（真的吗？）→ true', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '真的吗？' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('C 正则命中（仅正则路：keywords=[] 且「吃了吗？」）→ true', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '你吃了吗？' })]);
  const detection = { window_minutes: 10, keywords: [], question_regex: RD_CFG.question_regex };
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: detection, botId: BOT_ID, now: NOW }), true);
});

ok('C 超窗：now-lastBotAt > 10min 不算', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + 10 * MIN + 1000, text: '真的吗' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('C 窗口边界：恰好 10min → 仍算（窗口含端点）', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + 10 * MIN, text: '真的吗' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
});

ok('C 非首条：首条不命中、第二条关键词命中 → 不算（只判首条一次）', () => {
  const messages = cMessages([
    msg({ self: false, at: BOT_AT + MIN, text: '嗯嗯嗯' }),
    msg({ self: false, at: BOT_AT + 2 * MIN, text: '为什么' }),
  ]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('C 单字「吗」「呢」「吧」不算疑问标记', () => {
  for (const text of ['吗', '呢', '吧']) {
    const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text })]);
    assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false, `单字「${text}」不应算有人回复`);
  }
});

ok('C 普通陈述（无关键词、无疑问）不算', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '我去吃饭了' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('从没发过（无 bot 消息且 state.lastBotMessageAt=0）→ false', () => {
  const messages = [msg({ self: false, at: NOW - 5 * MIN, text: '真的吗' })];
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: 0 }), messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('空消息列表 / 非法入参 → false 且不抛错', () => {
  assert.equal(rd.hasSomeoneReplied({ state: st(), messages: [], replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
  assert.equal(rd.hasSomeoneReplied({ state: st(), messages: undefined, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), false);
});

ok('正则编译失败 → 跳过正则判定（不抛），只靠关键词', () => {
  const detection = { window_minutes: 10, keywords: ['真的吗'], question_regex: '([?？]' };
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '真的吗' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages, replyDetection: detection, botId: BOT_ID, now: NOW }), true);
  const messages2 = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '吃了吗？' })]);
  assert.equal(rd.hasSomeoneReplied({ state: st({ lastBotMessageAt: BOT_AT }), messages: messages2, replyDetection: detection, botId: BOT_ID, now: NOW }), false);
});

ok('hasSomeoneReplied 纯函数：不修改入参与消息数组', () => {
  const messages = cMessages([msg({ self: false, at: BOT_AT + MIN, text: '真的吗？', quoteOfSelf: true })]);
  const snapshot = JSON.parse(JSON.stringify(messages));
  const state = st({ lastBotMessageAt: BOT_AT });
  const stateSnapshot = JSON.parse(JSON.stringify(state));
  assert.equal(rd.hasSomeoneReplied({ state, messages, replyDetection: RD_CFG, botId: BOT_ID, now: NOW }), true);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(state, stateSnapshot);
});

/* ───────────── 12. 端到端：tick 循环（normal→waiting→cooldown→normal） ───────────── */

ok('端到端：normal → waiting →（无人回复）cooldown →（到期）normal 且 cold 保留', () => {
  let state = st({ dailyCount: 0 });
  // tick1：发心跳
  let r = tick(state);
  assert.equal(r.shouldSend, true);
  state = r.state;
  // tick2：waiting 未到期 → 跳过
  r = hb.evaluateTick({
    state,
    now: NOW + 10 * MIN,
    date: DATE,
    heartbeat: CFG,
    lastNonBotMessageAt: state.lastNonBotMessageAt,
  });
  assert.equal(r.shouldSend, false);
  assert.equal(r.changed, false);
  // tick3：waiting 到期无人回复 → cooldown
  r = hb.evaluateTick({
    state,
    now: NOW + 15 * MIN + 1,
    date: DATE,
    heartbeat: CFG,
    lastNonBotMessageAt: state.lastNonBotMessageAt,
  });
  assert.equal(r.state.state, 'cooldown');
  assert.equal(r.state.cold, true);
  state = r.state;
  // tick4：cooldown 到期 → normal，cold 保留
  // 注意：死群前置跳过排在 cooldown 之前，所以这里要让 lastNonBotMessageAt 保持「活跃」
  // （时间前进 3h 后，原来的 NOW-10min 早已超 2h，会被死群跳过而留在 cooldown）。
  r = hb.evaluateTick({
    state,
    now: state.cooldownUntil,
    date: DATE,
    heartbeat: CFG,
    lastNonBotMessageAt: state.cooldownUntil - 10 * MIN,
  });
  assert.equal(r.state.state, 'normal');
  assert.equal(r.state.cold, true);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-05（心跳人性化·阶段 1）：群最近有人说话 → 跳过，不插嘴
 *
 * 事故回放：2026-11-05 20:05:17 示例群心跳发出「你们俩这是被同一件事坑了吧哈哈」，
 * 而群里 **11 分 45 秒前**（19:53:32）刚有人说话。旧状态机完全不看群里有没有人说话，
 * 只按自己的 waiting/cooldown 记账，于是在别人的对话中间硬插了一句总结。
 * ═══════════════════════════════════════════════════════════════════════════ */

ok('阶段1·事故回放：群 11 分钟前有人说话 → 20:05 那条不该发', () => {
  // 两个时间戳都取自真实台账（示例群 2026-11-05）：
  //   19:53:32 = 群友A「【表情: 微笑】」（最后一条真人消息）
  //   20:05:17 = 心跳实际发出时间
  const at1953 = new Date('2026-11-05T19:53:32+08:00').getTime();
  const at2005 = new Date('2026-11-05T20:05:17+08:00').getTime();
  const result = hb.evaluateTick({
    state: st({ date: '2026-11-05', lastNonBotMessageAt: at1953, dailyCount: 4 }),
    now: at2005,
    date: '2026-11-05',
    heartbeat: { ...CFG, min_quiet_minutes: 20 },
    lastNonBotMessageAt: at1953,
  });
  assert.equal(result.shouldSend, false, '群刚有人说话，不该插嘴');
  assert.match(String(result.skipReason ?? ''), /不插嘴/u);
  assert.equal(result.state.dailyCount, 4, '跳过不得消耗配额');
});

ok('阶段1·阈值边界：19 分钟跳过、20 分钟放行、21 分钟放行', () => {
  const cfg = { ...CFG, min_quiet_minutes: 20 };
  const run = (quietMin) => hb.evaluateTick({
    state: st({ lastNonBotMessageAt: NOW - quietMin * MIN }),
    now: NOW,
    date: DATE,
    heartbeat: cfg,
    lastNonBotMessageAt: NOW - quietMin * MIN,
  });
  assert.equal(run(19).shouldSend, false, '19 < 20 → 跳过');
  assert.equal(run(20).shouldSend, true, '恰好 20 → 放行（判定取严格小于）');
  assert.equal(run(21).shouldSend, true, '21 > 20 → 放行');
});

ok('阶段1·min_quiet_minutes=0 → 关闭该判定（回到旧行为）', () => {
  const result = hb.evaluateTick({
    state: st({ lastNonBotMessageAt: NOW - 1 * MIN }),
    now: NOW,
    date: DATE,
    heartbeat: { ...CFG, min_quiet_minutes: 0 },
    lastNonBotMessageAt: NOW - 1 * MIN,
  });
  assert.equal(result.shouldSend, true, '0 = 关闭');
});

ok('阶段1·纯函数缺省该字段 = 关闭（保证老测试与老调用方向后兼容）', () => {
  const result = tick(st({ lastNonBotMessageAt: NOW - 1 * MIN }), { lastNonBotMessageAt: NOW - 1 * MIN });
  assert.equal(result.shouldSend, true);
});

ok('阶段1·顺序：min_quiet 在死群之前，安静 3 小时走死群而不是走"不插嘴"', () => {
  const last = NOW - 180 * MIN;
  const result = hb.evaluateTick({
    state: st({ lastNonBotMessageAt: last }),
    now: NOW,
    date: DATE,
    heartbeat: { ...CFG, min_quiet_minutes: 20, max_daily: 5 },
    lastNonBotMessageAt: last,
  });
  assert.equal(result.shouldSend, false);
  assert.match(String(result.skipReason ?? ''), /死群/u);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-05 修 P0：状态机卡死（跳过发送的判定挡住了到期迁移）
 *
 * 事故：min_quiet 和 dailyCount>=max 两个判定排在 waiting/cooldown 迁移**之前**，
 * 导致配额跑满或群持续活跃的群永远迁不出来。实测 示例群 cooldown 过期 48 分钟、
 * 688E 群 waiting 过期 23 分钟仍卡着；次日 0 点跨天重置后还会凭空进 3h cooldown+cold。
 * 迁移本身不发送消息，不该被这两个判定拦截。
 * ═══════════════════════════════════════════════════════════════════════════ */

ok('修复P0·配额满（dailyCount>=max）时 waiting 到期仍迁移到 cooldown', () => {
  const cfg = { ...CFG, max_daily: 1, min_quiet_minutes: 0 };
  const r = hb.evaluateTick({
    state: st({ state: 'waiting', dailyCount: 1, waitingUntil: NOW - 1 }),
    now: NOW,
    date: DATE,
    heartbeat: cfg,
    lastNonBotMessageAt: NOW - 10 * MIN,
    repliedDuringWait: false,
  });
  assert.equal(r.state.state, 'cooldown', '★ 配额满也必须迁移（原先被每日上限挡死）');
  assert.equal(r.changed, true);
});

ok('修复P0·群刚有人说话（min_quiet 命中）时 waiting 到期仍迁移', () => {
  const cfg = { ...CFG, max_daily: 5, min_quiet_minutes: 20 };
  const r = hb.evaluateTick({
    state: st({ state: 'waiting', dailyCount: 0, waitingUntil: NOW - 1 }),
    now: NOW,
    date: DATE,
    heartbeat: cfg,
    lastNonBotMessageAt: NOW - 5 * MIN, // 群 5 分钟前有人说话 → 旧代码会在这里跳过
    repliedDuringWait: true,
  });
  assert.equal(r.state.state, 'normal', '★ 有人回复 → normal（不受 min_quiet 影响）');
});

ok('修复P0·配额满 + 群活跃 时 cooldown 到期仍迁移到 normal', () => {
  const cfg = { ...CFG, max_daily: 1, min_quiet_minutes: 20 };
  const r = hb.evaluateTick({
    state: st({
      state: 'cooldown', dailyCount: 1, cold: true, coldSetAt: NOW - 100 * MIN,
      cooldownUntil: NOW - 1, waitingUntil: 0,
    }),
    now: NOW,
    date: DATE,
    heartbeat: cfg,
    lastNonBotMessageAt: NOW - 5 * MIN,
  });
  assert.equal(r.state.state, 'normal', '★ cooldown 到期 → normal（cold 保留）');
  assert.equal(r.state.cold, true, '冷落标记保留（图纸语义）');
});

console.log(`r4-heartbeat: passed ${checks} checks`);
process.exitCode = 0;
