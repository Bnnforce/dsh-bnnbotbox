#!/usr/bin/env node
/**
 * r4-events-close — R4.3 F1「事件闭环」**接线**测试（P1 修复）。
 * 运行：node test-r4/r4-events-close.mjs
 *
 * 与 `r4-events.mjs` 的分工：
 *   · `r4-events.mjs` 测 `markDone` / `closeExpired` 这两个**纯函数**本身；
 *   · 本文件测「谁在生产里调它们、结果是否真的落盘」——也就是 P1 缺陷的修复面：
 *       ① `expireStaleEvents`：读前惰性过期 + 原子写回 + 幂等；
 *       ② `closeEventsByText`：完结信号 → done + 落盘 + 防误判；
 *       ③ `mergeExtractedEvents`：不再把新提及合并进**超期 open** 事件。
 *
 * 数据隔离：每个小段用 `mkdtemp` 建独立数据根，结束统一删除，**绝不碰生产数据**。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('../../lib/persona/r4/events-store.js');

const {
  readEventFile,
  writeEventFile,
  expireStaleEvents,
  closeEventsByText,
  mergeExtractedEvents,
} = store;

const DAY = 86_400_000;
const NOW = Date.now();

/** 与 `DEFAULT_CONFIG.events_config` 定稿一致。 */
const CFG = {
  window_days: 3,
  cooldown_days: 2,
  expire_days: 4,
  max_per_user: 30,
  max_candidates: 3,
  model_judge: false,
  tau_days: 3,
};

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

const roots = [];
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'r4-evclose-'));
  roots.push(dir);
  return dir;
}

/** 构造一条合法事件（可覆盖任意字段）。 */
function evt(over = {}) {
  return {
    id: 'evt_default',
    userId: 'u1',
    groupId: 'g1',
    type: 'exam',
    keywords: ['考试'],
    summary: '要考试',
    mentions: [{ at: NOW - DAY, text: '明天要考试' }],
    status: 'open',
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    lastReferencedAt: 0,
    ...over,
  };
}

function seed(root, userId, events, config = CFG) {
  return writeEventFile({ version: 1, userId, events }, root, config);
}

/** 按 id 取事件（找不到返回 undefined，交给断言报错）。 */
function byId(root, userId, id) {
  return readEventFile(userId, root).events.find((event) => event.id === id);
}

try {
  /* ══════════ ① expireStaleEvents：超期 open → expired 并落盘 ══════════ */
  {
    const root = tempRoot();
    ok(seed(root, 'u1', [
      evt({
        id: 'old_open',
        createdAt: NOW - 5 * DAY,
        updatedAt: NOW - 5 * DAY,
        mentions: [{ at: NOW - 5 * DAY, text: '五天前说要考试' }],
      }),
      evt({
        id: 'fresh_open',
        createdAt: NOW - 2 * DAY,
        updatedAt: NOW - 2 * DAY,
        mentions: [{ at: NOW - 2 * DAY, text: '两天前说要考试' }],
      }),
      evt({ id: 'old_done', status: 'done', createdAt: NOW - 9 * DAY, updatedAt: NOW - DAY }),
    ]), '① 种子写入成功');

    eq(expireStaleEvents('u1', root, NOW, CFG), 1, '① 只把超期 open 置 expired（返回 1）');
    eq(byId(root, 'u1', 'old_open')?.status, 'expired', '① 5 天前的 open → expired（已落盘）');
    eq(byId(root, 'u1', 'fresh_open')?.status, 'open', '① 未超期保持 open');
    eq(byId(root, 'u1', 'old_done')?.status, 'done', '① done 不被改状态');
    eq(byId(root, 'u1', 'old_open')?.updatedAt, NOW - 5 * DAY, '① 纯状态迁移，不改 updatedAt');

    eq(expireStaleEvents('u1', root, NOW, CFG), 0, '① 幂等：第二次调用无变化、不重复写');
  }

  /* ══════════ ② expireStaleEvents：边界与兜底 ══════════ */
  {
    const edgeRoot = tempRoot();
    seed(edgeRoot, 'u1', [evt({ id: 'edge', createdAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY })]);
    eq(expireStaleEvents('u1', edgeRoot, NOW, CFG), 0, '② 恰好 expire_days（4 天）不判过期（严格大于）');

    const fallbackRoot = tempRoot();
    seed(fallbackRoot, 'u1', [evt({ id: 'old', createdAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY })]);
    eq(
      expireStaleEvents('u1', fallbackRoot, NOW, { ...CFG, expire_days: Number.NaN }),
      1,
      '② 配置非法 → 回落默认 4 天，仍能过期',
    );

    const emptyRoot = tempRoot();
    eq(expireStaleEvents('u404', emptyRoot, NOW, CFG), 0, '② 无事件表 → 0，不抛');
    eq(expireStaleEvents('___', emptyRoot, NOW, CFG), 0, '② 非法 userId → 0，不抛');
  }

  /* ══════════ ③ closeEventsByText：完结信号 → done 并落盘 ══════════ */
  {
    const root = tempRoot();
    ok(seed(root, 'u1', [evt({
      id: 'evt_exam',
      keywords: ['四级'],
      summary: '要考四级',
      createdAt: NOW - DAY,
      updatedAt: NOW - DAY,
      mentions: [{ at: NOW - DAY, text: '明天要考四级' }],
    })]), '③ 种子写入成功');

    eq(closeEventsByText('u1', '今天四级考完了，终于结束了', root, NOW, CFG), 1, '③ 完结信号 → 关闭 1 条（返回 1）');
    const closed = byId(root, 'u1', 'evt_exam');
    eq(closed?.status, 'done', '③ 状态已落盘为 done');
    ok(String(closed?.closeWhy ?? '').includes('考完'), '③ closeWhy 记录本地判定依据');
    eq(closed?.updatedAt, NOW, '③ updatedAt 更新为 now');

    eq(closeEventsByText('u1', '今天四级考完了，终于结束了', root, NOW, CFG), 0, '③ 幂等：已闭环的不重复关');
    eq(byId(root, 'u1', 'evt_exam')?.status, 'done', '③ 重复调用后仍是 done');
  }

  /* ══════════ ④ closeEventsByText：防误判（模型不可信，只认本地词表）══════════ */
  {
    const root = tempRoot();
    seed(root, 'u1', [
      evt({ id: 'no_done_word', keywords: ['四级'] }),
      evt({ id: 'no_keyword', keywords: ['四级'] }),
      evt({ id: 'wrong_type', type: 'project', keywords: ['项目'] }),
    ]);

    eq(closeEventsByText('u1', '四级还要继续复习', root, NOW, CFG), 0, '④ 没有完成词 → 不关');
    eq(byId(root, 'u1', 'no_done_word')?.status, 'open', '④ 无完成词保持 open');

    eq(closeEventsByText('u1', '考完了', root, NOW, CFG), 0, '④ 有完成词但事件关键词不出现 → 不关（防误判）');
    eq(byId(root, 'u1', 'no_keyword')?.status, 'open', '④ 关键词不命中保持 open');

    eq(closeEventsByText('u1', '项目考完了', root, NOW, CFG), 0, '④ 类型不匹配的完成词 → 不关');
    eq(byId(root, 'u1', 'wrong_type')?.status, 'open', '④ project 事件不被 exam 完成词关掉');

    eq(closeEventsByText('u1', '   ', root, NOW, CFG), 0, '④ 空正文 → 0，不抛');
    eq(closeEventsByText('___', '四级考完了', root, NOW, CFG), 0, '④ 非法 userId → 0，不抛');
  }

  /* ══════════ ⑤ mergeExtractedEvents：不再吸收超期 open 事件 ══════════ */
  {
    const root = tempRoot();
    seed(root, 'u1', [evt({
      id: 'stale_open',
      keywords: ['四级'],
      summary: '五天前要考四级',
      createdAt: NOW - 5 * DAY,
      updatedAt: NOW - 5 * DAY,
      mentions: [{ at: NOW - 5 * DAY, text: '五天前要考四级' }],
    })]);

    const added = mergeExtractedEvents({
      userId: 'u1',
      groupId: 'g1',
      root,
      now: NOW,
      config: CFG,
      extracted: [{ type: 'exam', keywords: ['四级'], summary: '四级又来了' }],
    });

    const file = readEventFile('u1', root);
    const old = file.events.find((event) => event.id === 'stale_open');
    eq(added, 1, '⑤ 超期 open 不再被合并 → 新建 1 条');
    eq(file.events.length, 2, '⑤ 事件表 2 条（旧链 + 新链）');
    eq(old?.status, 'expired', '⑤ 旧链在合并前被置 expired');
    eq(old?.mentions.length, 1, '⑤ 旧链提及链未被追加（不再吸走新提及）');
    eq(file.events.filter((event) => event.status === 'open').length, 1, '⑤ 只有新链是 open');
  }

  /* ══════════ ⑥ 未超期的 open 仍正常合并（排除 ⑤ 的过度修正）══════════ */
  {
    const root = tempRoot();
    seed(root, 'u1', [evt({
      id: 'fresh_open',
      keywords: ['四级'],
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - 2 * DAY,
      mentions: [{ at: NOW - 2 * DAY, text: '两天前要考四级' }],
    })]);

    const added = mergeExtractedEvents({
      userId: 'u1',
      groupId: 'g1',
      root,
      now: NOW,
      config: CFG,
      extracted: [{ type: 'exam', keywords: ['四级', '复习'], summary: '四级还没考' }],
    });

    const file = readEventFile('u1', root);
    eq(added, 0, '⑥ 未超期 → 仍合并（不新增）');
    eq(file.events.length, 1, '⑥ 仍只有 1 条');
    eq(file.events[0]?.mentions.length, 2, '⑥ 提及链追加到 2 条');
    eq(file.events[0]?.status, 'open', '⑥ 未超期保持 open');
  }

  /* ══════════ ⑦ 闭环后的写入链：done 事件不再吸收新提及 ══════════ */
  {
    const root = tempRoot();
    seed(root, 'u1', [evt({ id: 'evt_done', keywords: ['四级'], createdAt: NOW - DAY, updatedAt: NOW - DAY })]);
    eq(closeEventsByText('u1', '四级考完了', root, NOW, CFG), 1, '⑦ 先闭环 1 条');

    const added = mergeExtractedEvents({
      userId: 'u1',
      groupId: 'g1',
      root,
      now: NOW + DAY,
      config: CFG,
      extracted: [{ type: 'exam', keywords: ['四级'], summary: '又提起四级' }],
    });
    eq(added, 1, '⑦ done 后再提 → 建新事件（不追加旧链）');
    eq(readEventFile('u1', root).events.length, 2, '⑦ 事件表 2 条');
  }

  /* ══════════ 汇总 ══════════ */
  console.log(`✅ r4-events-close：${checks} 项断言全部通过`);
} finally {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}
