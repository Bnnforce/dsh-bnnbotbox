#!/usr/bin/env node
/**
 * F4 对话推进 / F5 作息仪式 · 单测（R4.3 批次 D）。
 * 运行：node test-r4/r4-chat-push.mjs
 *
 * 覆盖：
 *   ① lastWasQuestion 为真 → 返回空（上一轮已问过）
 *   ② consecutiveTurns < 1 → 返回空（刚开始不追问）
 *   ③ 动态概率：1 轮 60% / 2 轮 40% / >=3 轮空（注入 random 固定值，含边界值）
 *   ④ 同一文案 3 天内不重复（池子用尽 → 空；差 1ms 仍冷却、满 3 天解冻）
 *   ⑤ 深夜（0/1 点）+ 当天末次 → 困意句，冷却 key = ritual:night:{文案}
 *   ⑥ 清晨（6-8 点）+ 当天首次 → 刚醒句，冷却 key = ritual:morning:{文案}
 *   ⑦ 时段不对 / 首末次条件不满足 → 空
 *   ⑧ 任何畸形输入都不抛错，且永远返回字符串
 *   附加：文案池自检（条数 / ≤30 字 / 无客服句式 / 不重复 / 单行标签）、
 *         冷却表损坏降级、绝不写生产目录。
 *
 * 所有数据根都用 mkdtemp 隔离，绝不触碰生产目录。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const chatPush = await import('../../lib/persona/r4/chat-push.js');
const cooldown = await import('../../lib/persona/r4/phrase-cooldown.js');
const atomic = await import('../../lib/shared/atomic.js');

const { pushHint, ritualHint, PUSH_PHRASES, NIGHT_PHRASES, MORNING_PHRASES } = chatPush;

// 先硬性确认 lib 已构建且导出了文案池，否则后面的报错会变成难读的 TypeError。
assert.ok(Array.isArray(PUSH_PHRASES), 'chat-push 未导出 PUSH_PHRASES（是否忘了先构建 lib？）');
assert.ok(Array.isArray(NIGHT_PHRASES), 'chat-push 未导出 NIGHT_PHRASES（是否忘了先构建 lib？）');
assert.ok(Array.isArray(MORNING_PHRASES), 'chat-push 未导出 MORNING_PHRASES（是否忘了先构建 lib？）');

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.equal(actual, expected, label);
  checks += 1;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 固定时间点：2026-11-05 00:40（Asia/Shanghai），避免依赖当前时间。 */
const T0 = Date.parse('2026-11-05T00:40:00+08:00');

const roots = [];
/** 新建隔离数据根（测试结束统一删）。 */
function newRoot() {
  const root = mkdtempSync(join(tmpdir(), 'r4-chat-push-'));
  roots.push(root);
  return root;
}

/** 读冷却表条目（读不到/损坏 → 空对象）。 */
function cooldownItems(root) {
  const data = atomic.readJsonSafe(cooldown.cooldownPath(root));
  if (!data || typeof data !== 'object' || !data.items || typeof data.items !== 'object') return {};
  return data.items;
}

/** pushHint 便捷调用（默认非问句、1 轮、随机取 0）。 */
function push(root, over = {}) {
  return pushHint({ root, now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => 0, ...over });
}

/** ritualHint 便捷调用（默认深夜末次）。 */
function ritual(root, over = {}) {
  return ritualHint({
    root,
    groupId: 'G-test',
    now: T0,
    isFirstToday: false,
    isLastToday: true,
    hour: 0,
    random: () => 0,
    ...over,
  });
}

const len = (s) => [...s].length;

/** 临时替换 `Math.random`（用于验证「未注入 random / random 非函数 → 回退 Math.random」）；结束后必还原。 */
function withMathRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

try {
  /* ══════════ 一、文案池自检（防固定台词的第一道闸）══════════ */

  ok(PUSH_PHRASES.length >= 5, 'F4 文案池至少 5 条');
  ok(NIGHT_PHRASES.length >= 4, 'F5 困意池至少 4 条');
  ok(MORNING_PHRASES.length >= 4, 'F5 刚醒池至少 4 条');

  for (const [name, pool] of [
    ['F4', PUSH_PHRASES],
    ['F5-困意', NIGHT_PHRASES],
    ['F5-刚醒', MORNING_PHRASES],
  ]) {
    eq(new Set(pool).size, pool.length, `${name} 池内无重复文案`);
    ok(pool.every((p) => typeof p === 'string' && p.length > 0), `${name} 池无空项`);
    ok(pool.every((p) => len(p) <= 30), `${name} 每条都 ≤30 字`);
    ok(pool.every((p) => !p.includes('\n')), `${name} 每条都是单行（不抢主线）`);
    ok(pool.every((p) => !/还有什么可以帮|帮到您|您还需要|请问还|请稍等/.test(p)), `${name} 无客服句式`);
  }
  ok(PUSH_PHRASES.every((p) => p.startsWith('[推进] ')), 'F4 文案带统一 [推进] 标签');
  ok(NIGHT_PHRASES.every((p) => p.startsWith('[作息] ')), '困意文案带统一 [作息] 标签');
  ok(MORNING_PHRASES.every((p) => p.startsWith('[作息] ')), '刚醒文案带统一 [作息] 标签');

  /* ══════════ 二、F4 触发条件：上一轮已问 / 轮数不足 ══════════ */

  {
    const root = newRoot();
    eq(push(root, { lastWasQuestion: true, consecutiveTurns: 1 }), '', '上一轮已问 → 空');
    eq(push(root, { lastWasQuestion: true, consecutiveTurns: 2 }), '', '已问 + 2 轮 → 空（不是只看轮数）');
    eq(Object.keys(cooldownItems(root)).length, 0, '未命中不写冷却表（无副作用）');
  }

  {
    const root = newRoot();
    for (const turns of [0, -1, 0.5]) {
      eq(push(root, { consecutiveTurns: turns }), '', `连续轮数 ${turns} → 空（刚开始不追问）`);
    }
    eq(Object.keys(cooldownItems(root)).length, 0, '轮数不足不写冷却表');
  }

  {
    const root = newRoot();
    for (const turns of [3, 4, 10]) {
      eq(push(root, { consecutiveTurns: turns }), '', `连续轮数 ${turns} → 空（第 3 轮起不管）`);
    }
  }

  /* ══════════ 三、F4 动态概率（注入 random 固定值）══════════ */

  // 第 1 轮 60%
  eq(push(newRoot(), { consecutiveTurns: 1, random: () => 0 }), PUSH_PHRASES[0], '第 1 轮 random=0 → 命中');
  ok(push(newRoot(), { consecutiveTurns: 1, random: () => 0.599 }).length > 0, '第 1 轮 random=0.599 → 命中（60%）');
  eq(push(newRoot(), { consecutiveTurns: 1, random: () => 0.6 }), '', '第 1 轮 random=0.6 → 不命中（严格 <60%）');
  eq(push(newRoot(), { consecutiveTurns: 1, random: () => 0.61 }), '', '第 1 轮 random=0.61 → 不命中');
  eq(push(newRoot(), { consecutiveTurns: 1, random: () => 0.99 }), '', '第 1 轮 random=0.99 → 不命中');

  // 第 2 轮 40%
  ok(push(newRoot(), { consecutiveTurns: 2, random: () => 0 }).length > 0, '第 2 轮 random=0 → 命中');
  ok(push(newRoot(), { consecutiveTurns: 2, random: () => 0.399 }).length > 0, '第 2 轮 random=0.399 → 命中（40%）');
  eq(push(newRoot(), { consecutiveTurns: 2, random: () => 0.4 }), '', '第 2 轮 random=0.4 → 不命中（严格 <40%）');
  eq(push(newRoot(), { consecutiveTurns: 2, random: () => 0.41 }), '', '第 2 轮 random=0.41 → 不命中');
  eq(push(newRoot(), { consecutiveTurns: 2, random: () => 0.7 }), '', '第 2 轮 random=0.7 → 不命中');

  // 随机源给非法值 → 视为没抽中（不抛）
  eq(push(newRoot(), { consecutiveTurns: 1, random: () => NaN }), '', 'random 返回 NaN → 空');
  eq(push(newRoot(), { consecutiveTurns: 2, random: () => NaN }), '', 'random 返回 NaN（第 2 轮）→ 空');

  // 未注入 random / random 非函数 → 回退 Math.random（固定成确定值，避免测试不稳定）
  {
    const hint = withMathRandom(0, () => push(newRoot(), { consecutiveTurns: 1, random: undefined }));
    eq(hint, PUSH_PHRASES[0], '不传 random → 回退 Math.random（固定 0 → 命中首条）');
    ok(PUSH_PHRASES.includes(hint), '回退 Math.random 时也只从池子取句');
    eq(withMathRandom(0.99, () => push(newRoot(), { consecutiveTurns: 1, random: null })), '', 'random 非函数且回退值 0.99 → 命中概率不通过 → 空');
  }

  /* ══════════ 四、F4 冷却 3 天：同句不重复 ══════════ */

  {
    const root = newRoot();
    const seen = [];
    for (let i = 0; i < PUSH_PHRASES.length + 2; i += 1) {
      const hint = push(root, { consecutiveTurns: 1, random: () => 0 });
      if (!hint) break;
      seen.push(hint);
    }
    eq(seen.length, PUSH_PHRASES.length, '连续调用会逐条用完文案池，之后返回空');
    eq(new Set(seen).size, seen.length, '3 天内同一文案不重复');
    eq([...seen].sort().join('|'), [...PUSH_PHRASES].sort().join('|'), '用尽的是池子全集（不是固定一句）');
    ok(existsSync(cooldown.cooldownPath(root)), '冷却表落盘到 <root>/state/phrase-cooldown.json');
    ok(seen.every((h) => cooldown.isCoolingDown(h, 3, root, T0)), '每句都进入了 3 天冷却');

    eq(push(root, { now: T0 + 2 * DAY, consecutiveTurns: 1, random: () => 0 }), '', '2 天内仍全部冷却 → 空');
    eq(push(root, { now: T0 + 3 * DAY - 1, consecutiveTurns: 1, random: () => 0 }), '', '差 1ms 未满 3 天 → 仍冷却');
    const thawed = push(root, { now: T0 + 3 * DAY, consecutiveTurns: 1, random: () => 0 });
    ok(thawed.length > 0, '满 3 天 → 文案解冻可再用');
    ok(PUSH_PHRASES.includes(thawed), '解冻后仍取自池子');
  }

  /* ══════════ 五、F5 深夜：困意句 ══════════ */

  {
    const root = newRoot();
    const night = ritual(root, { hour: 0 });
    ok(NIGHT_PHRASES.includes(night), '00:xx + 当天末次 → 困意句');
    ok(len(night) <= 30, '困意句 ≤30 字');
    eq(cooldown.isCoolingDown(`ritual:night:${night}`, 3, root, T0), true, '冷却 key = ritual:night:{文案}');
    eq(cooldown.isCoolingDown(`ritual:night:${night}`, 3, root, T0 + 3 * DAY), false, '困意句 3 天后解冻');
    eq(cooldown.isCoolingDown(night, 3, root, T0), false, '不是裸文案做 key（必须带前缀）');

    const night1 = ritual(root, { hour: 1 });
    ok(NIGHT_PHRASES.includes(night1), '01:xx + 当天末次 → 困意句');
    eq(night1 === night, false, '同一天第二次取句换一条（不重复）');
  }

  {
    // 池子用尽 → 空（防「每天一句固定台词」）
    const root = newRoot();
    const seen = [];
    for (let i = 0; i < NIGHT_PHRASES.length + 2; i += 1) {
      const hint = ritual(root, { hour: 0 });
      if (!hint) break;
      seen.push(hint);
    }
    eq(seen.length, NIGHT_PHRASES.length, '困意池用尽后返回空（不循环复读）');
    eq(new Set(seen).size, seen.length, '困意句 3 天内不重复');
    eq([...seen].sort().join('|'), [...NIGHT_PHRASES].sort().join('|'), '用尽困意池全集');
    eq(ritual(root, { hour: 0 }), '', '池子耗尽 → 空（同一时刻）');
  }

  {
    const root = newRoot();
    eq(ritual(root, { hour: 0, isLastToday: false, isFirstToday: true }), '', '深夜但不是当天末次 → 空');
    eq(ritual(root, { hour: 1, isLastToday: false }), '', '01:xx 但不是当天末次 → 空');
    eq(ritual(root, { hour: 2, isLastToday: true }), '', '02:xx 不在定稿窗口 → 空');
    eq(ritual(root, { hour: 23, isLastToday: true }), '', '23:xx 不是深夜窗口 → 空');
    eq(ritual(root, { hour: 0, isLastToday: 1 }), '', 'isLastToday 非布尔 true → 空（严格判定）');
    eq(Object.keys(cooldownItems(root)).length, 0, '条件不满足不写冷却表');
  }

  /* ══════════ 六、F5 清晨：刚醒句 ══════════ */

  {
    const root = newRoot();
    const morning = ritual(root, { hour: 6, isFirstToday: true, isLastToday: false });
    ok(MORNING_PHRASES.includes(morning), '06:xx + 当天首次 → 刚醒句');
    ok(len(morning) <= 30, '刚醒句 ≤30 字');
    eq(cooldown.isCoolingDown(`ritual:morning:${morning}`, 3, root, T0), true, '冷却 key = ritual:morning:{文案}');
    eq(cooldown.isCoolingDown(`ritual:morning:${morning}`, 3, root, T0 + 3 * DAY), false, '刚醒句 3 天后解冻');
    eq(cooldown.isCoolingDown(morning, 3, root, T0), false, '不是裸文案做 key（必须带前缀）');

    const morning8 = ritual(root, { hour: 8, isFirstToday: true, isLastToday: false });
    ok(MORNING_PHRASES.includes(morning8), '08:xx + 当天首次 → 刚醒句');
    eq(morning8 === morning, false, '同一天第二次取句换一条');
    ok(!NIGHT_PHRASES.includes(morning8), '清晨不会串到困意池');
  }

  {
    const root = newRoot();
    const seen = [];
    for (let i = 0; i < MORNING_PHRASES.length + 2; i += 1) {
      const hint = ritual(root, { hour: 7, isFirstToday: true, isLastToday: false });
      if (!hint) break;
      seen.push(hint);
    }
    eq(seen.length, MORNING_PHRASES.length, '刚醒池用尽后返回空');
    eq(new Set(seen).size, seen.length, '刚醒句 3 天内不重复');
    eq([...seen].sort().join('|'), [...MORNING_PHRASES].sort().join('|'), '用尽刚醒池全集');
  }

  {
    const root = newRoot();
    eq(ritual(root, { hour: 6, isFirstToday: false }), '', '06:xx 但不是当天首次 → 空');
    eq(ritual(root, { hour: 8, isFirstToday: false }), '', '08:xx 但不是当天首次 → 空');
    eq(ritual(root, { hour: 9, isFirstToday: true }), '', '09:xx 超出清晨窗口 → 空');
    eq(ritual(root, { hour: 5, isFirstToday: true }), '', '05:xx 不在清晨窗口 → 空');
    eq(ritual(root, { hour: 6, isFirstToday: 1 }), '', 'isFirstToday 非布尔 true → 空（严格判定）');
    eq(Object.keys(cooldownItems(root)).length, 0, '条件不满足不写冷却表');
  }

  {
    // 未注入 random / random 非函数 → 回退 Math.random（固定成确定值，避免测试不稳定）
    const hint = withMathRandom(0, () => ritual(newRoot(), { hour: 7, isFirstToday: true, isLastToday: false, random: undefined }));
    eq(hint, MORNING_PHRASES[0], 'ritual 不传 random → 回退 Math.random（固定 0 → 命中首条）');
    ok(MORNING_PHRASES.includes(hint), '回退 Math.random 时也只从刚醒池取句');
    ok(
      MORNING_PHRASES.includes(withMathRandom(0, () => ritual(newRoot(), { hour: 7, isFirstToday: true, isLastToday: false, random: 'nope' }))),
      'ritual random 非函数 → 回退 Math.random，不抛',
    );
  }

  /* ══════════ 七、时段不对（两个条件同时给也不乱出）══════════ */

  {
    const root = newRoot();
    for (const hour of [2, 5, 9, 12, 20, 22]) {
      eq(
        ritual(root, { hour, isFirstToday: true, isLastToday: true }),
        '',
        `${String(hour).padStart(2, '0')}:xx 非仪式时段 → 空（即使首末次都为真）`,
      );
    }
    eq(Object.keys(cooldownItems(root)).length, 0, '非仪式时段不写冷却表');

    // 深夜即使同时是首次，也只走困意分支；清晨即使同时是末次，也只走刚醒分支。
    ok(NIGHT_PHRASES.includes(ritual(newRoot(), { hour: 0, isFirstToday: true, isLastToday: true })), '深夜双条件 → 困意句');
    ok(MORNING_PHRASES.includes(ritual(newRoot(), { hour: 7, isFirstToday: true, isLastToday: true })), '清晨双条件 → 刚醒句');
  }

  /* ══════════ 八、冷却表损坏/畸形 → 降级不崩 ══════════ */

  {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'phrase-cooldown.json'), 'not json {{{');
    const hint = push(root, { consecutiveTurns: 1, random: () => 0 });
    ok(PUSH_PHRASES.includes(hint), '冷却表损坏 → 视为空表，照常出句');
    const repaired = atomic.readJsonSafe(cooldown.cooldownPath(root));
    ok(repaired && typeof repaired === 'object' && typeof repaired.items === 'object', '损坏的冷却表被原子写覆盖修复');
  }

  {
    const root = newRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'phrase-cooldown.json'), JSON.stringify({ version: 1, items: 'oops' }));
    ok(NIGHT_PHRASES.includes(ritual(root, { hour: 1 })), '冷却表结构畸形 → 视为空表，照常出句');
  }

  /* ══════════ 九、防御：任何输入都不抛错 ══════════ */

  {
    const deepRoot = join(tmpdir(), 'r4-chat-push-deep', 'a', 'b', 'c');
    const frozen = Object.freeze({
      root: newRoot(),
      now: T0,
      lastWasQuestion: false,
      consecutiveTurns: 1,
      random: () => 0,
    });
    const badPushInputs = [
      undefined,
      null,
      {},
      [],
      42,
      { root: '', now: T0, lastWasQuestion: false, consecutiveTurns: 1 },
      { root: 123, now: T0, lastWasQuestion: false, consecutiveTurns: 1 },
      { root: newRoot(), now: NaN, lastWasQuestion: false, consecutiveTurns: 1 },
      { root: newRoot(), now: '2026-11-05', lastWasQuestion: false, consecutiveTurns: 1 },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: NaN },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: '1' },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: 1.5 },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => { throw new Error('boom'); } },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => NaN },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => 2 },
      { root: newRoot(), now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => -1 },
      frozen,
      // 数据根不存在 → mkdir 递归创建；父路径是普通文件 → 写失败静默
      { root: deepRoot, now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => 0 },
      { root: join(newRoot(), 'not-a-dir'), now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => 0 },
    ];
    for (let i = 0; i < badPushInputs.length; i += 1) {
      const input = badPushInputs[i];
      let out = null;
      assert.doesNotThrow(() => { out = pushHint(input); }, `pushHint 第 ${i} 个畸形输入不抛错`);
      checks += 1;
      eq(typeof out, 'string', `pushHint 第 ${i} 个畸形输入返回字符串`);
      if (out) {
        ok(PUSH_PHRASES.includes(out), `pushHint 第 ${i} 个畸形输入非空时也来自池子`);
        ok(len(out) <= 30, `pushHint 第 ${i} 个畸形输入非空时 ≤30 字`);
        ok(!out.includes('\n'), `pushHint 第 ${i} 个畸形输入非空时是单行`);
      }
    }

    // 「父路径是文件」场景：先写一个普通文件，再拿它当 root
    const rootAsFile = join(newRoot(), 'plain-file');
    writeFileSync(rootAsFile, 'x');
    assert.doesNotThrow(() => {
      pushHint({ root: rootAsFile, now: T0, lastWasQuestion: false, consecutiveTurns: 1, random: () => 0 });
    }, 'root 指向普通文件 → 不抛错');
    checks += 1;
  }

  {
    const frozenRitual = Object.freeze({
      root: newRoot(),
      groupId: 'G',
      now: T0,
      isFirstToday: true,
      isLastToday: true,
      hour: 7,
      random: () => 0,
    });
    const badRitualInputs = [
      undefined,
      null,
      {},
      [],
      'night',
      { root: '', now: T0, groupId: 'g', hour: 0, isFirstToday: false, isLastToday: true },
      { root: newRoot(), now: NaN, groupId: 'g', hour: 0, isFirstToday: false, isLastToday: true },
      { root: newRoot(), now: T0, groupId: 'g', hour: NaN, isFirstToday: false, isLastToday: true },
      { root: newRoot(), now: T0, groupId: 'g', hour: '0', isFirstToday: false, isLastToday: true },
      { root: newRoot(), now: T0, groupId: 'g', hour: Infinity, isFirstToday: false, isLastToday: true },
      { root: newRoot(), now: T0, groupId: 'g', hour: 0, isFirstToday: false, isLastToday: true, random: () => { throw new Error('boom'); } },
      { root: newRoot(), now: T0, groupId: 'g', hour: 7, isFirstToday: true, isLastToday: false, random: () => NaN },
      frozenRitual,
    ];
    for (let i = 0; i < badRitualInputs.length; i += 1) {
      const input = badRitualInputs[i];
      let out = null;
      assert.doesNotThrow(() => { out = ritualHint(input); }, `ritualHint 第 ${i} 个畸形输入不抛错`);
      checks += 1;
      eq(typeof out, 'string', `ritualHint 第 ${i} 个畸形输入返回字符串`);
      if (out) {
        ok(NIGHT_PHRASES.includes(out) || MORNING_PHRASES.includes(out), `ritualHint 第 ${i} 个畸形输入非空时来自仪式池`);
        ok(len(out) <= 30, `ritualHint 第 ${i} 个畸形输入非空时 ≤30 字`);
        ok(out.startsWith('[作息] '), `ritualHint 第 ${i} 个畸形输入非空时带 [作息] 标签`);
      }
    }
  }

  /* ══════════ 十、边界补强：组号不影响冷却（定为全局）══════════ */

  {
    const root = newRoot();
    const a = ritual(root, { groupId: 'G-A', hour: 0 });
    const b = ritual(root, { groupId: 'G-B', hour: 0 });
    ok(a !== b, '同一文案不因换群就重复（冷却表全局）');
    ok(NIGHT_PHRASES.includes(a) && NIGHT_PHRASES.includes(b), '换群仍取自困意池');
  }

  /* ══════════ 十一、输出格式（绝不抢主线）══════════ */

  {
    const pushLine = push(newRoot(), { consecutiveTurns: 1, random: () => 0 });
    ok(pushLine.startsWith('[推进] '), 'F4 提示是带标签的单行软提示');
    ok(!pushLine.includes('\n'), 'F4 提示不跨行');
    ok(len(pushLine) <= 30, 'F4 提示 ≤30 字');
    const ritualLine = ritual(newRoot(), { hour: 7, isFirstToday: true, isLastToday: false });
    ok(ritualLine.startsWith('[作息] '), 'F5 提示是带标签的单行语气修饰');
    ok(!ritualLine.includes('\n'), 'F5 提示不跨行');
    ok(len(ritualLine) <= 30, 'F5 提示 ≤30 字');
  }

  console.log(`r4-chat-push: passed ${checks} checks`);
} finally {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
  try { rmSync(join(tmpdir(), 'r4-chat-push-deep'), { recursive: true, force: true }); } catch { /* ignore */ }
}
