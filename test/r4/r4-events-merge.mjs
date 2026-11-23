/**
 * r4-events-merge — R4.3 D2「事件提取接入」测试（F1 的唯一生产者）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const L = new URL('../../lib/persona/r4/', import.meta.url).href;
const store = await import(L + 'events-store.js');
const close = await import(L + 'events-close.js');
const { DEFAULT_CONFIG } = await import(L + 'config.js');

const CFG = DEFAULT_CONFIG.events_config;
const NOW = 1_793_870_000_000;
const DAY = 86_400_000;
const USER = 'FADE0004FADE0004FADE0004FADE0004';
const GID = 'G_MAIN';

let checks = 0; let failed = 0;
function ok(cond, msg) { checks += 1; if (!cond) { failed += 1; console.error('  ✗', msg); } }

function freshRoot() { return mkdtempSync(join(tmpdir(), 'evm-')); }

// ① 新建事件
{
  const root = freshRoot();
  const added = store.mergeExtractedEvents({
    userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '周四期中考试，数学不会' }],
  });
  const file = store.readEventFile(USER, root);
  ok(added === 1, '① 新事件应新增 1 条');
  ok(file.events.length === 1, '① 事件表应 1 条');
  ok(file.events[0].type === 'exam', '① type 归一为 exam');
  ok(file.events[0].groupId === GID, '① 事件带 groupId');
  ok(file.events[0].status === 'open', '① 初始状态 open');
  ok(file.events[0].mentions.length === 1, '① 提及链 1 条');
  rmSync(root, { recursive: true, force: true });
}

// ② 同群同 type 关键词交集 → 追加 mention（不新增）
{
  const root = freshRoot();
  store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '周四期中考试' }] });
  const added2 = store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW + DAY, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试', '背答案'], summary: '明天就考试了，要背答案' }] });
  const file = store.readEventFile(USER, root);
  ok(added2 === 0, '② 同事件不应新增');
  ok(file.events.length === 1, '② 仍只有 1 条');
  ok(file.events[0].mentions.length === 2, '② 提及链应 2 条');
  ok(file.events[0].mentions[1].text.includes('背答案'), '② 最新提及内容正确');
  rmSync(root, { recursive: true, force: true });
}

// ③ 跨群不合并（同一用户两个群）
{
  const root = freshRoot();
  store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '群一：要考试' }] });
  const added = store.mergeExtractedEvents({ userId: USER, groupId: 'G_OTHER', root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '群二：要考试' }] });
  const file = store.readEventFile(USER, root);
  ok(added === 1, '③ 跨群应新建（不合并）');
  ok(file.events.length === 2, '③ 应 2 条事件');
  ok(file.events.filter((e) => e.groupId === 'G_OTHER').length === 1, '③ 群二有独立事件');
  rmSync(root, { recursive: true, force: true });
}

// ④ 坏输入 / 空输入 → 0，不抛
{
  const root = freshRoot();
  ok(store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG, extracted: null }) === 0, '④ null → 0');
  ok(store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG, extracted: [] }) === 0, '④ 空数组 → 0');
  ok(store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [null, 42, { summary: '' }] }) === 0, '④ 畸形项 → 0');
  ok(store.mergeExtractedEvents({ userId: '', groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', summary: 'x' }] }) === 0, '④ 空 userId → 0');
  rmSync(root, { recursive: true, force: true });
}

// ⑤ 单次最多 5 条
{
  const root = freshRoot();
  const many = Array.from({ length: 9 }, (_, i) => ({ type: 'other', keywords: [`话题${i}`], summary: `事件${i}` }));
  const added = store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG, extracted: many });
  ok(added === 5, '⑤ 单次最多收 5 条');
  rmSync(root, { recursive: true, force: true });
}

// ⑥ 闭环后不再合并（done 的事件不应被追加提及）
{
  const root = freshRoot();
  store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '要考试了' }] });
  const f1 = store.readEventFile(USER, root);
  const closed = close.markDone(f1.events, '终于考完了，期中考试结束了', NOW + DAY);
  store.writeEventFile({ ...f1, events: closed }, root, CFG);
  const added = store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW + 2 * DAY, config: CFG,
    extracted: [{ type: 'exam', keywords: ['期中考试'], summary: '考试相关的事' }] });
  ok(added === 1, '⑥ done 后再提应建新事件（不追加旧链）');
  rmSync(root, { recursive: true, force: true });
}

// ⑦ type 中文别名归一
{
  const root = freshRoot();
  store.mergeExtractedEvents({ userId: USER, groupId: GID, root, now: NOW, config: CFG,
    extracted: [{ type: '面试', keywords: ['面试'], summary: '下周面试' }] });
  const file = store.readEventFile(USER, root);
  ok(file.events[0].type === 'interview', '⑦ 中文别名「面试」→ interview');
  rmSync(root, { recursive: true, force: true });
}

console.log(`✅ r4-events-merge: ${checks - failed}/${checks} 通过`);
process.exit(failed === 0 ? 0 : 1);
