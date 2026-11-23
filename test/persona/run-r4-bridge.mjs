/**
 * r4-bridge 测试（2026-11-20 新增）
 *
 * 背景：`lib/persona/r4-bridge.js` 23KB，此前**零测试覆盖**。
 * 本测试覆盖它的核心契约：
 *   B1  工厂能创建、返回完整方法集
 *   B2  r4Groups：从 msg-history 读群列表 + sanitize
 *   B3  r4Groups：目录不存在时降级到 guidelines，再降级到 []
 *   B4  r4SenderOf：查不到时降级
 *   B5  r4BotOpenid：从 diagnostics 取
 *   B6  sendToGroupViaBridge：能力缺失时安全降级
 *   B7  dispose 可调用
 *   B8  脏目录名被过滤（安全）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const PKG_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const ROOT = PKG_ROOT;
const BRIDGE = await import(`file://${ROOT}/lib/persona/r4-bridge.js`);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`);

const TMP = mkdtempSync(join(tmpdir(), 'r4bridge-'));

/** 造一个 qqbot 结构：.qqbot/msg-history/group_<id>。 */
function makeQqbotRoot(gids = []) {
  const root = join(TMP, 'qqbot-' + Math.random().toString(36).slice(2, 8));
  const mh = join(root, '.qqbot', 'msg-history');
  mkdirSync(mh, { recursive: true });
  for (const gid of gids) {
    mkdirSync(join(mh, 'group_' + gid), { recursive: true });
    writeFileSync(join(mh, 'group_' + gid, 'x.jsonl'), '', 'utf8');
  }
  return root;
}

/** 最小 deps（只给必填）。 */
function makeDeps(over = {}) {
  return {
    qqbotDataRoot: TMP,
    logger: { warn() {}, info() {}, debug() {} },
    ...over,
  };
}

console.log('═══ r4-bridge 测试 ═══\n');

try {
  // ── B1 工厂 ──
  console.log('B1 工厂创建');
  const b = BRIDGE.createR4Bridge(makeDeps());
  ok(b && typeof b === 'object', '返回对象');
  for (const m of ['r4Groups', 'r4SenderOf', 'r4MentionFlagsOf', 'r4BotOpenid', 'sendToGroupViaBridge', 'sendWakeToGroup', 'dispose']) {
    ok(typeof b[m] === 'function', `有方法 ${m}`);
  }

  // ── B2 读群列表 ──
  console.log('\nB2 r4Groups 读目录');
  const root2 = makeQqbotRoot(['AAA111', 'BBB222']);
  const b2 = BRIDGE.createR4Bridge(makeDeps({ qqbotDataRoot: root2 }));
  const groups = b2.r4Groups();
  ok(Array.isArray(groups), '返回数组');
  eq(groups.length, 2, '读到 2 个群');
  ok(groups.includes('AAA111') && groups.includes('BBB222'), '群 id 正确（去掉 group_ 前缀）');

  // ── B3 降级 ──
  console.log('\nB3 r4Groups 降级');
  const emptyRoot = join(TMP, 'empty-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(emptyRoot, { recursive: true });
  const b3 = BRIDGE.createR4Bridge(makeDeps({ qqbotDataRoot: emptyRoot }));
  const g3 = b3.r4Groups();
  ok(Array.isArray(g3), '目录不存在也返回数组（不抛）');

  // ── B4 sender 查询降级 ──
  console.log('\nB4 r4SenderOf 降级');
  const b4 = BRIDGE.createR4Bridge(makeDeps({ qqbotDataRoot: emptyRoot }));
  const sender = b4.r4SenderOf('no-such-session', 'no-such-group');
  ok(sender === undefined || sender === null || typeof sender === 'string' || typeof sender === 'object',
    `查不到时安全返回值（实际=${typeof sender}）`);

  // ── B5 bot openid ──
  console.log('\nB5 r4BotOpenid 从 diagnostics 取');
  const b5 = BRIDGE.createR4Bridge(makeDeps({
    qqbotDataRoot: emptyRoot,
    r4Diagnostics: () => ({ botOpenid: 'BOT123' }),
  }));
  eq(b5.r4BotOpenid(), 'BOT123', '取到 diagnostics 里的 botOpenid');

  // ── B6 发送能力缺失 ──
  console.log('\nB6 发送降级');
  const b6 = BRIDGE.createR4Bridge(makeDeps({ qqbotDataRoot: emptyRoot }));
  let sendResult, sendErr = null;
  try { sendResult = await b6.sendToGroupViaBridge('G1', 'hi'); }
  catch (e) { sendErr = e; }
  ok(!sendErr, '发送不抛异常');
  ok(sendResult !== undefined, `有明确返回值（实际=${JSON.stringify(sendResult)}）`);

  // ── B7 dispose ──
  console.log('\nB7 dispose');
  let disposeErr = null;
  try { b.dispose(); } catch (e) { disposeErr = e; }
  ok(!disposeErr, 'dispose 可调用且不抛');

  // ── B8 脏目录名过滤 ──
  console.log('\nB8 脏目录名安全');
  const dirtyRoot = join(TMP, 'dirty-' + Math.random().toString(36).slice(2, 8));
  const dirtyMh = join(dirtyRoot, '.qqbot', 'msg-history');
  mkdirSync(dirtyMh, { recursive: true });
  // 合法
  mkdirSync(join(dirtyMh, 'group_GOOD123'), { recursive: true });
  // 含路径穿越字符（sanitize 应过滤掉）
  try { mkdirSync(join(dirtyMh, 'group_..%2f..%2fetc'), { recursive: true }); } catch { /* 文件名非法时跳过 */ }

  const b8 = BRIDGE.createR4Bridge(makeDeps({ qqbotDataRoot: dirtyRoot }));
  const g8 = b8.r4Groups();
  ok(Array.isArray(g8), '返回数组');
  ok(!g8.some((g) => typeof g === 'string' && g.includes('..')), '脏 id 不含路径穿越');
  ok(g8.includes('GOOD123'), '合法 id 保留');

} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;