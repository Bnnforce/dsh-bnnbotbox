/**
 * 2026-11-05（心跳人性化·阶段 2）：`buildWakePrompt()` 单元测试。
 *
 * 跑法：`cd <plugin> && node test-r4/r4-heartbeat-gen.mjs`
 *
 * 为什么单独一个文件：`heartbeat-gen.ts` 的心跳内容生成与状态机（`heartbeat.ts`）是
 * 两块独立逻辑，状态机测试已经 57 条，混在一起难以定位。
 *
 * 覆盖：
 *  - `HEARTBEAT_WAKE_MARKER` 导出且首行出现（入站守卫靠它识别，写错 = 守卫失效）；
 *  - 时间状态（现在几点 / 她上次说话 / 群里最后一条多久前）；
 *  - 必须引导 agent 用 `group_history` 看真消息、用 `reply_gate` 沉默；
 *  - **不得**出现聊天摘要段落与旧的三分类框架（那是 20:05 人机感的来源）；
 *  - 负面词分支；
 *  - 时间戳缺失/为 0 时不崩、不出现 Invalid Date；
 *  - 旧 `buildHeartbeatPrompt` 仍在（legacy 路径回归）。
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

const gen = await import('../../lib/persona/r4/heartbeat-gen.js');

let checks = 0;
function ok(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    console.error(`r4-heartbeat-gen: FAILED -> ${name}`);
    throw error;
  }
}

const MIN = 60 * 1000;

/** 2026-11-05 20:05:17 Asia/Shanghai（UTC 12:05:17）—— 与 20:05 事故同一时刻。 */
const NOW = Date.UTC(2026, 10, 5, 12, 5, 17);
/** 19:53:32 Asia/Shanghai（UTC 11:53:32）—— 事故当时群里最后一条真人消息。 */
const LAST_NON_BOT = Date.UTC(2026, 10, 5, 11, 53, 32);
/** 19:19:00 Asia/Shanghai（UTC 11:19:00）—— 她当天上一次在群里说话。 */
const LAST_BOT = Date.UTC(2026, 10, 5, 11, 19, 0);

const BASE = { now: NOW, lastBotMessageAt: LAST_BOT, lastNonBotMessageAt: LAST_NON_BOT };

/* ───────────── 1. 标记常量 ───────────── */

ok('导出 HEARTBEAT_WAKE_MARKER 且值为「【你看了一眼群】」', () => {
  assert.equal(typeof gen.HEARTBEAT_WAKE_MARKER, 'string');
  assert.equal(gen.HEARTBEAT_WAKE_MARKER, '【你看了一眼群】');
});

ok('首行必须是标记（入站守卫 startsWith 靠它）', () => {
  const text = gen.buildWakePrompt(BASE);
  const firstLine = text.split('\n')[0];
  assert.equal(firstLine, gen.HEARTBEAT_WAKE_MARKER);
  assert.ok(text.startsWith(gen.HEARTBEAT_WAKE_MARKER));
});

/* ───────────── 2. 时间状态 ───────────── */

ok('含当前时间 20:05（上海时区）', () => {
  assert.match(gen.buildWakePrompt(BASE), /现在 20:05/u);
});

ok('含她上次说话时间 19:19', () => {
  assert.match(gen.buildWakePrompt(BASE), /你上次在群里说话是 19:19/u);
});

ok('含群里最后一条消息的"多久前"（11 分钟前）', () => {
  const text = gen.buildWakePrompt(BASE);
  // 注意「是」后面有空格：真实测试输出曾出现「是40 分钟前」，已修
  assert.match(text, /群里最后一条消息是 \d+ 分钟前/u);
  // 20:05:17 - 19:53:32 = 11 分 45 秒 → 四舍五入 12 分钟；只要落在 11~12 都算对
  assert.match(text, /群里最后一条消息是 1[12] 分钟前/u);
});

ok('时间戳为 0 / 缺失时不崩、不出现 Invalid', () => {
  const text = gen.buildWakePrompt({ now: 0, lastBotMessageAt: 0, lastNonBotMessageAt: 0 });
  assert.ok(!/Invalid|NaN|undefined/u.test(text), `输出含非法时间: ${text}`);
  assert.ok(text.startsWith(gen.HEARTBEAT_WAKE_MARKER));
});

/* ───────────── 3. 必须引导"自己看群 + 可以沉默" ───────────── */

ok('引导用 group_history 看最后 10 条', () => {
  const text = gen.buildWakePrompt(BASE);
  assert.match(text, /group_history/u);
  assert.match(text, /最后 10 条/u);
});

ok('给出 reply_gate 沉默出口（这是"宁可不说"的机制基础）', () => {
  const text = gen.buildWakePrompt(BASE);
  assert.match(text, /reply_gate\(false/u);
});

ok('正面形状：要求"对说那句话的人说"「落在他说的具体东西上」', () => {
  const text = gen.buildWakePrompt(BASE);
  assert.match(text, /对说那句话的人说/u);
  assert.match(text, /落在他说的具体东西上/u);
});

/* ───────────── 4. 不得出现的东西（回归 20:05 人机感来源） ───────────── */

ok('不含聊天摘要段落（旧 buildHeartbeatPrompt 的【本群最近对话】）', () => {
  const text = gen.buildWakePrompt(BASE);
  assert.ok(!text.includes('本群最近对话'), '不应再塞聊天摘要（摘要会丢引用/图/@）');
});

ok('不含旧的三分类框架（冷场救援/话题共鸣/人际关心）', () => {
  const text = gen.buildWakePrompt(BASE);
  for (const tag of ['冷场救援', '话题共鸣', '人际关心']) {
    assert.ok(!text.includes(tag), `不应再出现旧标签「${tag}」`);
  }
});

ok('不提「心跳/系统/提醒」这类元叙述词（只在禁止句里以否定形式出现）', () => {
  const text = gen.buildWakePrompt(BASE);
  // 允许出现在「不要提"心跳/系统/提醒"」这句里，但不能有肯定用法
  assert.match(text, /不要提"心跳\/系统\/提醒"/u);
});

/* ───────────── 5. 负面词分支 ───────────── */

ok('负面词分支：引导轻轻关心、禁止诊断追问', () => {
  const text = gen.buildWakePrompt({ ...BASE, negativeHit: '不想活了' });
  assert.match(text, /不想活了/u);
  assert.match(text, /关心/u);
  assert.match(text, /不要诊断/u);
  // 负面分支不应给"接话"的普通出口
  assert.ok(!text.includes('就接那一句'), '负面词分支不应鼓励接梗');
});

ok('负面词分支也保留 reply_gate 沉默出口', () => {
  assert.match(gen.buildWakePrompt({ ...BASE, negativeHit: '难受' }), /reply_gate\(false/u);
});

/* ───────────── 6. legacy 路径回归（旧函数必须原样还在） ───────────── */

ok('旧 buildHeartbeatPrompt 仍导出且仍走三分类（legacy 路径不回归）', () => {
  assert.equal(typeof gen.buildHeartbeatPrompt, 'function');
  const legacy = gen.buildHeartbeatPrompt({
    messages: [{ senderName: '群友', senderId: 'u1', text: '今天好热', at: NOW, self: false }],
    negativeHit: null,
  });
  assert.match(legacy, /本群最近对话/u);
  assert.match(legacy, /冷场救援/u);
});

ok('旧 HEARTBEAT_SYSTEM 仍导出（legacy 生成用）', () => {
  assert.equal(typeof gen.HEARTBEAT_SYSTEM, 'string');
  assert.ok(gen.HEARTBEAT_SYSTEM.length > 0);
});

ok('旧 parseHeartbeatOutput / isUsableHeartbeatText / withTimeout 仍导出', () => {
  for (const name of ['parseHeartbeatOutput', 'isUsableHeartbeatText', 'withTimeout']) {
    assert.equal(typeof gen[name], 'function', `${name} 应仍导出`);
  }
});

console.log(`r4-heartbeat-gen: passed ${checks} checks`);
process.exitCode = 0;
