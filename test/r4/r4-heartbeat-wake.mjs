/**
 * 2026-11-05（心跳人性化·阶段 2）：**调度分派**回归测试。
 *
 * 为什么单独一个文件：`r4-scheduler.mjs` 已经 262 条，但它测的全是 legacy 路径。
 * 新加的 wake 分派（mode 从配置来、走 sendWake 不走 send、只有 sendWake 也能工作、
 * 失败回滚）没有任何回归保护 —— 这批断言就是保护它。
 *
 * 覆盖：
 *  - `resolveGenerationMode` 四象限（generation_mode × wake_first_groups）；
 *  - wake 配置 → 走 `sendWake`、绝不调 `send`；
 *  - 只注入 `sendWake`、没有 `send` → 不能被判成"无发送能力"而跳过；
 *  - `sendWake` 返回 false → 走与 send 失败同一条回滚分支（state=normal、dailyCount 不增）；
 *  - legacy 配置 → 绝不调 `sendWake`（回滚开关有效）；
 *  - `wake_first_groups` 灰度：名单内 wake、名单外 legacy；
 *  - 报告 `queued` / `delivered` 语义（入队 ≠ 送达）。
 *
 * ★ 2026-11-05 追加（心跳账目 bug 修复）：
 *  - `.bridge-alive` 缺失 / 超过 30 秒 → wake 模式跳过（不生成、不计数、不进 waiting）；
 *  - 收到 `wake-failed` 回执 → 回滚 `dailyCount`、`lastBotMessageAt` 恢复到入队前；
 *  - 同一回执只回滚一次（已消费标记落在 R4 自己的账本里，跨 scheduler 实例有效）；
 *  - `injected` 回执 → 不回滚；回执超过 30 分钟 / 拿不到旧值 → 不乱动。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import { existsSync as fsExists, } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith('.js')
      && typeof context.parentURL === 'string'
      && context.parentURL.endsWith('.js')
    ) {
      const candidate = new URL(specifier.replace(/\.js$/u, '.js'), context.parentURL);
      if (candidate.protocol === 'file:' && fsExists(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const sched = await import('../../lib/persona/r4/scheduler.js');
const cfgMod = await import('../../lib/persona/r4/config.js');
const paths = await import('../../lib/persona/r4/paths.js');

const BASE = tmpdir();
const root = mkdtempSync(join(BASE, 'wake-sched-'));
const NOW = Date.UTC(2026, 10, 5, 12, 0); // 北京 2026-11-05 20:00
const DATE = '2026-11-05';
const GID1 = 'FADE0001FADE0001FADE0001FADE0001'; // 示例群（白名单内）
const GID2 = 'FADE0011FADE0011FADE0011FADE0011'; // 奥赫玛（白名单外）

/** 桥存活 / 回执 / 账本的固定路径（与 scheduler.ts 的约定一致）。 */
const ALIVE_PATH = join(paths.stateDir(root), 'heartbeat-outbox', '.bridge-alive');
const LEDGER_PATH = join(paths.stateDir(root), 'heartbeat-wake-ledger.json');
const receiptPath = (gid) => join(paths.stateDir(root), 'heartbeat-receipts', `${gid}.json`);

/** 写 JSON（测试造数据用，不是生产写盘路径）。 */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

/** 写一份「刚刷新」的桥存活心跳（wake 模式的前置条件）。 */
function setBridgeAlive(at = NOW) {
  writeJson(ALIVE_PATH, { at, scanned: 0, sent: 0, failed: 0 });
}

/** 删掉桥存活心跳（模拟扩展桥没加载）。 */
function removeBridgeAlive() {
  try { unlinkSync(ALIVE_PATH); } catch { /* 本来就不存在 */ }
}

/** 造一份心跳状态。 */
function seedHeartbeat(gid, over = {}) {
  writeJson(paths.heartbeatPath(gid, root), { ...mkState(), ...over });
}

/** 读心跳状态。 */
function readState(gid) {
  return JSON.parse(readFileSync(paths.heartbeatPath(gid, root), 'utf8'));
}

/** 造一份桥回执。 */
function seedReceipt(gid, receipt) {
  writeJson(receiptPath(gid), receipt);
}

/** 造 R4 自己的 wake 账本（只留本测试群）。 */
function seedLedger(gid, group) {
  writeJson(LEDGER_PATH, { version: 1, groups: { [gid]: group } });
}

/** 读 R4 的 wake 账本。 */
function readLedger() {
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
}

/** evaluate 的「不发」版本：本文件只测回滚/跳过，不测状态机。 */
const noSendVerdict = ({ state, date }) => ({ next: { ...state, date }, changed: false, shouldSend: false });

let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks += 1; };
const ok = (v, m) => { assert.ok(v, m); checks += 1; };

/** 造一份配置：heartbeat_config 按需覆盖。 */
function mkCfg(over = {}) {
  const base = cfgMod.DEFAULT_CONFIG;
  return {
    ...base,
    heartbeat_config: { ...base.heartbeat_config, min_quiet_minutes: 0, ...over },
  };
}

/** 心跳 deps：evaluate 直接放行（本文件只测分派，不测状态机）。 */
function mkDeps(opts) {
  return {
    heartbeat: {
      config: opts.config,
      root,
      logger: opts.logger,
      listGroups: () => [opts.gid ?? GID1],
      readMessages: () => [],
      evaluate: opts.evaluate ?? (({ state, now, date }) => ({
        next: { ...state, date, state: 'waiting', waitingUntil: now + 15 * 60000, lastBotMessageAt: now, dailyCount: state.dailyCount + 1 },
        changed: true,
        shouldSend: true,
      })),
      generate: opts.generate,
      send: opts.send,
      sendWake: opts.sendWake,
      now: () => NOW,
    },
    extraction: {
      config: opts.config, root,
      listGroups: () => [], readMessages: () => [],
      extract: async () => ({ accepted: 0 }), now: () => NOW,
    },
  };
}

const mkState = () => ({ date: DATE, dailyCount: 0, lastNonBotMessageAt: 0, lastBotMessageAt: 0, state: 'normal', cold: false, coldSetAt: 0, waitingUntil: 0, cooldownUntil: 0 });

/* ══════════ 1. resolveGenerationMode 四象限 ══════════ */
{
  const legacyCfg = mkCfg({ generation_mode: 'legacy' });
  const wakeCfgAll = mkCfg({ generation_mode: 'wake' });
  const wakeCfgSel = mkCfg({ generation_mode: 'wake', wake_first_groups: [GID1] });
  eq(sched.resolveGenerationMode(legacyCfg, GID1), 'legacy', 'legacy → legacy（不看名单）');
  // ★ 2026-11-05 修 P1（回滚开关失效）：总闸关 + 灰度名单非空时，**名单内的群也必须 legacy**。
  //   原先 `wake_first_groups` 非空会完全覆盖 `generation_mode`，导致按文档回滚（改 legacy）
  //   后灰度群仍在走 wake —— 安全开关是假的。
  const legacySel = mkCfg({ generation_mode: 'legacy', wake_first_groups: [GID1] });
  eq(sched.resolveGenerationMode(legacySel, GID1), 'legacy', '★ legacy + 名单非空 → 名单内的群也必须 legacy（回滚开关有效）');
  eq(sched.resolveGenerationMode(wakeCfgAll, GID1), 'wake', 'wake + 无名单 → 全部 wake');
  eq(sched.resolveGenerationMode(wakeCfgAll, GID2), 'wake', 'wake + 无名单 → 别的群也 wake');
  eq(sched.resolveGenerationMode(wakeCfgSel, GID1), 'wake', '白名单内 → wake');
  eq(sched.resolveGenerationMode(wakeCfgSel, GID2), 'legacy', '★ 白名单外 → legacy（灰度生效）');
}

/* ══════════ 2. wake 模式：走 sendWake、不调 send ══════════ */
{
  setBridgeAlive(); // 桥活着 = wake 模式的前置条件（2026-11-05 新增）
  let wakePayload = null;
  let direct = null;
  const deps = mkDeps({
    config: mkCfg({ generation_mode: 'wake' }),
    generate: async () => ({ wakePrompt: '【你看了一眼群】\n\n测试' }),
    send: async (g, t) => { direct = { g, t }; return true; },
    sendWake: async (p) => { wakePayload = p; return true; },
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(reps.length, 1, '单群 1 条报告');
  ok(wakePayload !== null, '✓ 走了 sendWake');
  eq(direct, null, '✗ 没有调 send（wake 模式必须独占）');
  eq(wakePayload.groupId, GID1, 'payload.groupId 正确');
  ok(typeof wakePayload.wakePrompt === 'string' && wakePayload.wakePrompt.length > 0, 'payload.wakePrompt 非空');
  eq(reps[0].queued, true, '报告 queued=true（已入队）');
  eq(reps[0].delivered, false, '★ wake 只是入队，delivered=false（不谎报已送达）');
  const st = JSON.parse(readFileSync(paths.heartbeatPath(GID1, root), 'utf8'));
  eq(st.state, 'waiting', '入队成功 → 状态推进到 waiting');
  eq(st.dailyCount, 1, 'dailyCount 计 1');
}

/* ══════════ 3. 只有 sendWake、没有 send → 不能被跳过 ══════════ */
{
  setBridgeAlive();
  let wakePayload = null;
  const deps = mkDeps({
    config: mkCfg({ generation_mode: 'wake' }),
    generate: async () => ({ wakePrompt: '【你看了一眼群】\n\n只有 wake 通道' }),
    send: undefined,
    sendWake: async (p) => { wakePayload = p; return true; },
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  ok(wakePayload !== null, '★ 无 send 也能走 wake（不能判成"无发送能力"）');
  eq(reps[0].queued, true, '报告 queued');
}

/* ══════════ 4. sendWake 失败 → 回滚（与 send 失败同一条分支） ══════════ */
{
  setBridgeAlive();
  // 进入本轮之前磁盘上的 dailyCount（前面的用例已经把它推进过），回滚必须回到这个水平
  const before = JSON.parse(readFileSync(paths.heartbeatPath(GID1, root), 'utf8')).dailyCount;
  const deps = mkDeps({
    config: mkCfg({ generation_mode: 'wake' }),
    generate: async () => ({ wakePrompt: '【你看了一眼群】\n\n会失败' }),
    send: undefined,
    sendWake: async () => false,
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(reps[0].sent, false, '失败 → sent=false');
  eq(reps[0].queued, false, '失败 → queued=false');
  ok(String(reps[0].reason ?? '').includes('回滚'), `失败原因含"回滚"：${reps[0].reason}`);
  const st = JSON.parse(readFileSync(paths.heartbeatPath(GID1, root), 'utf8'));
  eq(st.state, 'normal', '★ 失败回滚：state=normal（不留 waiting）');
  eq(st.dailyCount, before, '★ 失败回滚：dailyCount 撤回（回到进入前水平）');
}

/* ══════════ 5. legacy 配置 → 绝不走 sendWake（回滚开关有效） ══════════ */
{
  removeBridgeAlive(); // ★ 故意让桥「死掉」：legacy 不依赖扩展桥，必须照发不误
  let wakeCalled = 0;
  let directText = null;
  const deps = mkDeps({
    config: mkCfg({ generation_mode: 'legacy' }),
    generate: async () => ({ text: '老路径正文' }),
    send: async (g, t) => { directText = t; return true; },
    sendWake: async () => { wakeCalled += 1; return true; },
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(wakeCalled, 0, '★ legacy 模式下 sendWake 一次都不许调（否则回滚开关是假的）');
  eq(directText, '老路径正文', 'legacy 走 send');
}

/* ══════════ 6. 灰度：名单外群仍走 legacy ══════════ */
{
  let wakeCalled = 0;
  let directText = null;
  const deps = mkDeps({
    gid: GID2,
    config: mkCfg({ generation_mode: 'wake', wake_first_groups: [GID1] }),
    generate: async () => ({ text: '名单外群的老路径' }),
    send: async (g, t) => { directText = t; return true; },
    sendWake: async () => { wakeCalled += 1; return true; },
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(wakeCalled, 0, '白名单外的群不调 sendWake');
  eq(directText, '名单外群的老路径', '白名单外的群走 legacy send');
}

/* ══════════ 7. generate 返回空（text/wakePrompt 都空）→ 不发送、不计费 ══════════ */
{
  setBridgeAlive();
  let wakeCalled = 0;
  const deps = mkDeps({
    config: mkCfg({ generation_mode: 'wake' }),
    generate: async () => ({ text: '  ', wakePrompt: '' }),
    send: async () => true,
    sendWake: async () => { wakeCalled += 1; return true; },
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(wakeCalled, 0, '都空 → 不调 sendWake');
  eq(reps[0].sent, false, '都空 → 不发送');
}

/* ══════════ 8. wake-failed 回执 → 回滚 dailyCount + lastBotMessageAt ══════════ */
{
  const gid = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
  const receiptId = `${gid}-${NOW - 120000}-abcd`;
  setBridgeAlive();
  // 模拟「上一次 tick 已把假成功写进状态」：dailyCount=2，lastBotMessageAt=入队时刻（假）。
  seedHeartbeat(gid, { dailyCount: 2, lastBotMessageAt: NOW });
  seedLedger(gid, { pending: { id: receiptId, at: NOW, prevLastBotMessageAt: 1111 } });
  seedReceipt(gid, { at: NOW - 60_000, via: 'wakeTo', status: 'wake-failed', id: receiptId });
  const warns = [];
  let generated = 0;
  const deps = mkDeps({
    gid,
    logger: { warn: (m) => warns.push(m) },
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => { generated += 1; return { wakePrompt: '不该生成' }; },
    sendWake: async () => true,
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  const st = readState(gid);
  eq(st.dailyCount, 1, '★ wake-failed → dailyCount 回滚（2 → 1）');
  eq(st.lastBotMessageAt, 1111, '★ lastBotMessageAt 恢复到入队前，而不是入队时刻');
  eq(generated, 0, '回执回滚后判不发送 → 不调 generate');
  eq(reps.length, 1, '仍产出 1 条报告');
  eq(reps[0].dailyCount, 1, '报告里的 dailyCount 是回滚后的值');
  eq(readLedger().groups[gid].pending, undefined, '回滚后 pending 被清掉');
  ok(warns.some((m) => m.includes('wake 投递失败') && m.includes('已回滚 dailyCount')), 'logWarn 明确写了「wake 投递失败 → 已回滚 dailyCount」');
}

/* ══════════ 9. 同一回执只回滚一次（已消费标记跨 scheduler 实例有效） ══════════ */
{
  const gid = 'B1B2C3D4E5F60718293A4B5C6D7E8F91';
  const receiptId = `${gid}-${NOW - 120000}-efgh`;
  setBridgeAlive();
  seedHeartbeat(gid, { dailyCount: 3, lastBotMessageAt: NOW });
  seedLedger(gid, { pending: { id: receiptId, at: NOW, prevLastBotMessageAt: 2222 } });
  seedReceipt(gid, { at: NOW - 60_000, via: 'wakeTo', status: 'wake-failed', id: receiptId });
  const deps = mkDeps({
    gid,
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => null,
    sendWake: async () => true,
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(readState(gid).dailyCount, 2, '第一次 tick 回滚一次（3 → 2）');
  eq(readLedger().groups[gid].consumedReceiptId, receiptId, '★ 已消费回执 id 记在 R4 自己的账本里');
  // 换一个 scheduler 实例（模拟重启/下一轮），只能靠磁盘账本去重。
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(readState(gid).dailyCount, 2, '★ 同一回执第二次 tick 不重复回滚');
  eq(readState(gid).lastBotMessageAt, 2222, 'lastBotMessageAt 也只恢复一次');
}

/* ══════════ 10. injected 回执 → 不回滚 ══════════ */
{
  const gid = 'C1B2C3D4E5F60718293A4B5C6D7E8F92';
  const receiptId = `${gid}-${NOW - 120000}-ijkl`;
  setBridgeAlive();
  seedHeartbeat(gid, { dailyCount: 2, lastBotMessageAt: 3333 });
  seedLedger(gid, { pending: { id: receiptId, at: NOW, prevLastBotMessageAt: 0 } });
  seedReceipt(gid, { at: NOW - 1000, via: 'wakeTo', status: 'injected', id: receiptId });
  const deps = mkDeps({
    gid,
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => null,
    sendWake: async () => true,
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(readState(gid).dailyCount, 2, 'injected（投递成功）→ 不回滚 dailyCount');
  eq(readState(gid).lastBotMessageAt, 3333, 'injected → 不动 lastBotMessageAt');
}

/* ══════════ 11. .bridge-alive 缺失 / 超过 30 秒 → wake 跳过、不计数 ══════════ */
{
  const gid = 'D1B2C3D4E5F60718293A4B5C6D7E8F93';
  seedHeartbeat(gid, { dailyCount: 1, lastBotMessageAt: 4444 });
  removeBridgeAlive();
  let generated = 0;
  const deps = mkDeps({
    gid,
    config: mkCfg({ generation_mode: 'wake' }),
    generate: async () => { generated += 1; return { wakePrompt: '不该生成' }; },
    sendWake: async () => true,
  });
  const reps = await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(generated, 0, '★ .bridge-alive 缺失 → 不生成');
  eq(readState(gid).dailyCount, 1, '.bridge-alive 缺失 → 不计数');
  eq(readState(gid).state, 'normal', '.bridge-alive 缺失 → 不进 waiting');
  eq(reps[0].skipped, true, '报告 skipped=true');
  ok(String(reps[0].reason ?? '').includes('扩展桥未存活'), '报告原因写明扩展桥未存活');

  setBridgeAlive(NOW - 31_000); // 31 秒没刷新 = 桥挂了
  const reps2 = await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(generated, 0, '★ .bridge-alive 超过 30 秒 → 不生成');
  eq(readState(gid).dailyCount, 1, '.bridge-alive 超过 30 秒 → 不计数');
  eq(reps2[0].skipped, true, '过期存活文件 → 报告 skipped=true');
}

/* ══════════ 12. 回执对不上 pending → 只回滚配额，不动 lastBotMessageAt ══════════ */
{
  const gid = 'E1B2C3D4E5F60718293A4B5C6D7E8F94';
  const receiptId = `${gid}-${NOW - 120000}-old0`;
  const pendingId = `${gid}-${NOW - 60000}-new0`;
  setBridgeAlive();
  seedHeartbeat(gid, { dailyCount: 2, lastBotMessageAt: NOW });
  seedLedger(gid, { pending: { id: pendingId, at: NOW, prevLastBotMessageAt: 5555 } });
  seedReceipt(gid, { at: NOW - 30_000, via: 'wakeTo', status: 'wake-failed', id: receiptId });
  const deps = mkDeps({
    gid,
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => null,
    sendWake: async () => true,
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  const st = readState(gid);
  eq(st.dailyCount, 1, '回执对不上 pending 也要回滚配额');
  eq(st.lastBotMessageAt, NOW, '★ 拿不到旧值 → 不动 lastBotMessageAt（绝不写 0）');
  eq(readLedger().groups[gid].pending.id, pendingId, '新 pending 不会被旧回执抹掉');
}

/* ══════════ 13. 回执有效期：按心跳节律推导（不是死 30 分钟） ══════════ */
{
  // 节律是 45±15 分钟 = 最长 60 分钟；失败回执要等**下一次 tick** 才会被消费。
  // 所以 40 分钟前的回执仍然有效（写死 30 分钟会让大多数轮次的回滚失效）。
  eq(sched.wakeReceiptTtlMs(mkCfg({ generation_mode: 'wake' })), 75 * 60_000, '默认 45+15 分钟 → 回执有效期 75 分钟（覆盖一整轮 + 余量）');
  const gid = 'F1B2C3D4E5F60718293A4B5C6D7E8F95';
  const receiptId = `${gid}-${NOW - 40 * 60_000}-mid0`;
  setBridgeAlive();
  seedHeartbeat(gid, { dailyCount: 2, lastBotMessageAt: NOW });
  seedLedger(gid, { pending: { id: receiptId, at: NOW, prevLastBotMessageAt: 6666 } });
  seedReceipt(gid, { at: NOW - 40 * 60_000, via: 'wakeTo', status: 'wake-failed', id: receiptId });
  const deps = mkDeps({
    gid,
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => null,
    sendWake: async () => true,
  });
  await sched.createScheduler(deps).tickHeartbeatOnce();
  eq(readState(gid).dailyCount, 1, '★ 40 分钟前的回执仍能回滚（等得到下一次 tick）');
  eq(readState(gid).lastBotMessageAt, 6666, '40 分钟前的回执也能恢复 lastBotMessageAt');

  // 超出有效期（2 小时）→ 不回滚，避免拿历史回执扣错账。
  const gid2 = 'F2B2C3D4E5F60718293A4B5C6D7E8F96';
  const oldId = `${gid2}-${NOW - 3 * 60 * 60_000}-old0`;
  seedHeartbeat(gid2, { dailyCount: 2, lastBotMessageAt: NOW });
  seedReceipt(gid2, { at: NOW - 2 * 60 * 60_000, via: 'wakeTo', status: 'wake-failed', id: oldId });
  const deps2 = mkDeps({
    gid: gid2,
    config: mkCfg({ generation_mode: 'wake' }),
    evaluate: noSendVerdict,
    generate: async () => null,
    sendWake: async () => true,
  });
  await sched.createScheduler(deps2).tickHeartbeatOnce();
  eq(readState(gid2).dailyCount, 2, '★ 超过有效期的回执 → 不回滚（避免旧回执扣错账）');
}

console.log(`r4-heartbeat-wake: passed ${checks} checks`);
// 2026-11-14 修：测试在维护/归档/ 下 mkdtempSync 却不清理 → 每跑一次留一个 wake-sched-*（实测已留 2 份）。
//   改为跑完必清；清理失败不影响结论。
try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = 0;
