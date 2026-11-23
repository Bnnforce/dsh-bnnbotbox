#!/usr/bin/env node
/**
 * R4.3 F1 记忆关联（事件表 / 旧事召回 / 事件闭环）— 测试。
 * 运行：node test-r4/r4-events.mjs
 *
 * 覆盖（任务书 ①-⑨ + 事件表写入的两条清理规则）：
 *   ① 写入后能读回                         ② 跨群不召回（最高优先级红线）
 *   ③ 跨用户不召回                         ④ 时间窗口外不召回
 *   ⑤ 冷却中不召回                         ⑥ 时间衰减（近的分数高）
 *   ⑦ markDone 生效                        ⑧ closeExpired 生效
 *   ⑨ 坏文件 / 空目录 / 非法身份不抛错      ⑩ 超过 max_per_user 淘汰最旧
 *   ⑪ done 超过 expire_days 在写入时清理
 *
 * 数据隔离：每个小段用 `mkdtemp` 建独立数据根，结束统一删除，**绝不碰生产数据**。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const store = await import('../../lib/persona/r4/events-store.js');
const recallMod = await import('../../lib/persona/r4/events-recall.js');
const closeMod = await import('../../lib/persona/r4/events-close.js');

const { readEventFile, writeEventFile, eventsPath } = store;
const { recallEvents } = recallMod;
const { markDone, closeExpired } = closeMod;

const DAY = 86_400_000;
const NOW = Date.now();

/** 与 `DEFAULT_CONFIG.events_config` 定稿一致（任务书：参数定稿，不要改）。 */
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

/* ───────── 隔离根目录 ───────── */
const roots = [];
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'r4-events-'));
  roots.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 测试清理失败不影响结论 */ }
  }
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

/** 直接写一张事件表。 */
function seed(root, userId, events, config = CFG) {
  return writeEventFile({ version: 1, userId, events }, root, config);
}

/** 简化召回调用。 */
function recall(root, over = {}) {
  return recallEvents({
    groupId: 'g1',
    userId: 'u1',
    text: '考试',
    now: NOW,
    config: CFG,
    root,
    ...over,
  });
}

try {
  /* ══════════ ① 写入后能读回 ══════════ */
  {
    const root = tempRoot();
    ok(seed(root, 'u1', [evt({ id: 'evt_1', keywords: ['考试', '四级'], summary: '四级考试' })]), '① 写入返回 true');

    const file = readEventFile('u1', root);
    eq(file.version, 1, '① 版本保留');
    eq(file.userId, 'u1', '① 用户保留');
    eq(file.events.length, 1, '① 读回 1 条');
    const got = file.events[0];
    eq(got.id, 'evt_1', '① id 一致');
    eq(got.type, 'exam', '① type 一致');
    eq(got.keywords, ['考试', '四级'], '① 关键词一致');
    eq(got.summary, '四级考试', '① 摘要一致');
    eq(got.mentions.length, 1, '① 提及链一致');
    eq(got.status, 'open', '① 状态一致');
    eq(got.lastReferencedAt, 0, '① 冷却时间一致');

    // 不存在的用户 → 空表，不抛
    const missing = readEventFile('u404', root);
    eq(missing.events, [], '① 缺失文件 → 空表');
    eq(missing.version, 1, '① 缺失文件版本仍合法');
  }

  /* ══════════ ② 跨群不召回（最关键）══════════ */
  {
    const root = tempRoot();
    // 事件属于 u1，但归属群是 g2
    ok(seed(root, 'u1', [evt({ id: 'evt_g2', groupId: 'g2' })]), '② 种子写入成功');

    eq(recall(root, { groupId: 'g1' }), null, '② 跨群不召回（g2 事件不在 g1 出现）');
    const sameGroup = recall(root, { groupId: 'g2' });
    ok(sameGroup && sameGroup.eventId === 'evt_g2', '② 同群仍可召回（排除误判）');

    // 同一用户、两个群各一条：g1 只能拿到 g1 的那条
    const root2 = tempRoot();
    seed(root2, 'u1', [
      evt({ id: 'evt_a', groupId: 'g1', summary: '群 A 的事' }),
      evt({ id: 'evt_b', groupId: 'g2', summary: '群 B 的事' }),
    ]);
    const hitA = recall(root2, { groupId: 'g1' });
    const hitB = recall(root2, { groupId: 'g2' });
    eq(hitA?.eventId, 'evt_a', '② 群 A 只召回群 A 事件');
    eq(hitB?.eventId, 'evt_b', '② 群 B 只召回群 B 事件');
  }

  /* ══════════ ③ 跨用户不召回 ══════════ */
  {
    // (a) 别的用户文件里的事件，读不到
    const root = tempRoot();
    seed(root, 'u2', [evt({ id: 'evt_u2', userId: 'u2' })]);
    eq(recall(root, { userId: 'u1' }), null, '③ 不读别的用户文件');

    // (b) 文件里混入他人记录（模拟文件被拷贝/污染）→ recall 的 userId 双重校验拦住
    const root2 = tempRoot();
    seed(root2, 'u1', [evt({ id: 'evt_foreign', userId: 'u2' })]);
    eq(recall(root2, { userId: 'u1' }), null, '③ 文件内他人记录不召回');
    const own = recall(root2, { userId: 'u2' });
    eq(own, null, '③ 也不能借 u1 的文件召回（文件按 userId 读）');
  }

  /* ══════════ ④ 时间窗口外不召回 ══════════ */
  {
    const oldRoot = tempRoot();
    seed(oldRoot, 'u1', [evt({
      id: 'evt_old',
      createdAt: NOW - 4 * DAY,
      updatedAt: NOW - 4 * DAY,
      mentions: [{ at: NOW - 4 * DAY, text: '四天前说要考试' }],
    })]);
    eq(recall(oldRoot), null, '④ 4 天前创建（>3 天）不召回');

    const inRoot = tempRoot();
    seed(inRoot, 'u1', [evt({
      id: 'evt_in',
      createdAt: NOW - 2 * DAY,
      updatedAt: NOW - 2 * DAY,
      mentions: [{ at: NOW - 2 * DAY, text: '两天前说要考试' }],
    })]);
    eq(recall(inRoot)?.eventId, 'evt_in', '④ 窗口内可召回（排除误判）');
  }

  /* ══════════ ⑤ 冷却中不召回 ══════════ */
  {
    const coolingRoot = tempRoot();
    seed(coolingRoot, 'u1', [evt({
      id: 'evt_cooling',
      lastReferencedAt: NOW - 1 * DAY,
    })]);
    eq(recall(coolingRoot), null, '⑤ 1 天前引用过（冷却 2 天）不召回');

    const freshRoot = tempRoot();
    seed(freshRoot, 'u1', [evt({
      id: 'evt_fresh',
      lastReferencedAt: NOW - 3 * DAY,
    })]);
    eq(recall(freshRoot)?.eventId, 'evt_fresh', '⑤ 冷却已过可召回（排除误判）');
  }

  /* ══════════ 状态过滤：只召回 open ══════════ */
  {
    const root = tempRoot();
    seed(root, 'u1', [
      evt({ id: 'evt_done', status: 'done' }),
      evt({ id: 'evt_expired', status: 'expired' }),
    ]);
    eq(recall(root), null, '只召回 open 事件（done / expired 排除）');
  }

  /* ══════════ ⑥ 时间衰减（近的分数高）══════════ */
  {
    const root = tempRoot();
    // 两条关键词完全相同（基础分相同），只有时间不同 → 衰减决定胜负
    seed(root, 'u1', [
      evt({
        id: 'evt_near',
        summary: '近的旧事',
        createdAt: NOW - 0.2 * DAY,
        updatedAt: NOW - 0.2 * DAY,
        mentions: [{ at: NOW - 0.2 * DAY, text: '刚考完试' }],
      }),
      evt({
        id: 'evt_far',
        summary: '远的旧事',
        createdAt: NOW - 2.5 * DAY,
        updatedAt: NOW - 2.5 * DAY,
        mentions: [{ at: NOW - 2.5 * DAY, text: '两天半前考试' }],
      }),
    ]);
    const hit = recall(root);
    eq(hit?.eventId, 'evt_near', '⑥ 关键词相同时，近的分数更高');
    eq(hit?.summary, '刚考完试', '⑥ 注入摘要取最新 mention 文本');
    eq(hit?.daysAgo, 0, '⑥ daysAgo 按最新 mention 四舍五入');
  }

  /* ══════════ ⑦ markDone 生效 ══════════ */
  {
    // 正例：exam + 关键词命中 + 完成词
    const events = [evt({ id: 'evt_exam', type: 'exam', keywords: ['四级'] })];
    const closed = markDone(events, '四级考完了，稳了', NOW);
    ok(closed !== events, '⑦ 返回新数组');
    eq(closed[0].status, 'done', '⑦ 命中完成词 + 关键词 → done');
    ok(closed[0].closeWhy.includes('考完'), '⑦ closeWhy 记录依据');
    eq(closed[0].updatedAt, NOW, '⑦ updatedAt 更新为 now');
    eq(events[0].status, 'open', '⑦ 不原地改入参');

    // 反例 1：完成词在，但没有事件关键词
    const noKeyword = markDone([evt({ keywords: ['四级'] })], '考完了', NOW);
    eq(noKeyword[0].status, 'open', '⑦ 关键词不命中 → 不关（防误判）');

    // 反例 2：类型不匹配（project 的完成词不适用于 exam 事件）
    const wrongType = markDone([evt({ type: 'project', keywords: ['项目'] })], '项目考完了', NOW);
    eq(wrongType[0].status, 'open', '⑦ 类型不匹配的完成词 → 不关');

    // 反例 3：已 done 的事件不重复处理
    const alreadyDone = markDone([evt({ status: 'done', keywords: ['四级'] })], '四级考完了', NOW);
    eq(alreadyDone[0].status, 'done', '⑦ done 事件保持 done');

    // 一次最多关 1 条
    const many = [
      evt({ id: 'evt_m1', keywords: ['四级'] }),
      evt({ id: 'evt_m2', keywords: ['四级', '六级'] }),
    ];
    const one = markDone(many, '四级六级都考完了', NOW);
    eq(one.filter((item) => item.status === 'done').length, 1, '⑦ 一次最多关 1 条');
    eq(one[1].status, 'done', '⑦ 关关键词命中更多的那条');

    // project 完成词
    const project = markDone([evt({ type: 'project', keywords: ['项目'] })], '项目上线了', NOW);
    eq(project[0].status, 'done', '⑦ project 上线 → done');
  }

  /* ══════════ ⑧ closeExpired 生效 ══════════ */
  {
    const oldOpen = evt({ id: 'evt_open_old', createdAt: NOW - 5 * DAY });
    const freshOpen = evt({ id: 'evt_open_new', createdAt: NOW - 3 * DAY });
    const oldDone = evt({ id: 'evt_done', status: 'done', createdAt: NOW - 9 * DAY });
    const input = [oldOpen, freshOpen, oldDone];

    const out = closeExpired(input, NOW, CFG);
    ok(out !== input, '⑧ 返回新数组');
    eq(out[0].status, 'expired', '⑧ 超过 expire_days 的 open → expired');
    eq(out[1].status, 'open', '⑧ 未超期保持 open');
    eq(out[2].status, 'done', '⑧ done 不改状态');
    eq(oldOpen.status, 'open', '⑧ 不原地改入参');

    // 边界：恰好在 expire_days 上不判过期（严格大于）
    const edge = evt({ id: 'evt_edge', createdAt: NOW - 4 * DAY });
    eq(closeExpired([edge], NOW, CFG)[0].status, 'open', '⑧ 恰好 4 天不判过期（> 才过期）');
  }

  /* ══════════ ⑨ 坏文件 / 空目录 / 非法身份不抛错 ══════════ */
  {
    const root = tempRoot();

    // 空目录
    eq(readEventFile('u1', root).events, [], '⑨ 空目录 → 空表');
    eq(recall(root), null, '⑨ 空目录召回 → null');

    // 损坏 JSON
    mkdirSync(join(root, 'state', 'events'), { recursive: true });
    writeFileSync(eventsPath('u1', root), '{ 这不是 JSON');
    eq(readEventFile('u1', root).events, [], '⑨ 损坏 JSON → 空表');
    eq(recall(root), null, '⑨ 损坏 JSON 召回 → null，不抛');

    // 版本不符
    writeFileSync(eventsPath('u1', root), JSON.stringify({ version: 99, userId: 'u1', events: [evt()] }));
    eq(readEventFile('u1', root).events, [], '⑨ version 不符 → 空表');

    // events 不是数组
    writeFileSync(eventsPath('u1', root), JSON.stringify({ version: 1, userId: 'u1', events: 'nope' }));
    eq(readEventFile('u1', root).events, [], '⑨ events 不是数组 → 空表');

    // 单条字段不合法 → 只丢坏的那条
    writeFileSync(eventsPath('u1', root), JSON.stringify({
      version: 1,
      userId: 'u1',
      events: [
        { id: 'bad_missing_fields' },
        { ...evt({ id: 'bad_type' }), type: 'unknown_type' },
        { ...evt({ id: 'bad_time' }), createdAt: 'yesterday' },
        evt({ id: 'evt_ok' }),
      ],
    }));
    eq(readEventFile('u1', root).events.map((item) => item.id), ['evt_ok'], '⑨ 只保留合法记录');

    // 非法身份（净化后为空/全下划线）：读不抛、写返回 false
    eq(readEventFile('___', root).events, [], '⑨ 非法 userId 读 → 空表');
    eq(writeEventFile({ version: 1, userId: '___', events: [evt()] }, root), false, '⑨ 非法 userId 写 → false');
    eq(eventsPath('___', root), '', '⑨ 非法 userId 路径 → 空串');

    // 路径穿越：净化后必须仍落在 state/events 目录内（不得逃逸）
    const traversalPath = eventsPath('../evil', root);
    ok(traversalPath.startsWith(join(root, 'state', 'events')), '⑨ 路径穿越被净化到 events 目录内');
    eq(traversalPath.includes('..'), false, '⑨ 净化后的路径不含 ..');

    eq(writeEventFile(null, root), false, '⑨ 非对象写入 → false');
    eq(writeEventFile({ version: 1, userId: 'u1', events: null }, root), false, '⑨ events 非法写入 → false');

    // 闭环函数对空数组 / 脏入参也不抛
    eq(markDone([], '考完了', NOW), [], '⑨ markDone 空数组 → []');
    eq(closeExpired([], NOW, CFG), [], '⑨ closeExpired 空数组 → []');
    eq(markDone(null, '考完了', NOW), [], '⑨ markDone 非数组 → []');
    eq(closeExpired(null, NOW, CFG), [], '⑨ closeExpired 非数组 → []');
  }

  /* ══════════ ⑩ 超过 max_per_user → 淘汰最旧 ══════════ */
  {
    const root = tempRoot();
    const cfg = { ...CFG, max_per_user: 3 };
    const events = [0, 1, 2, 3].map((i) => evt({
      id: `evt_${i}`,
      createdAt: NOW - (10 - i) * DAY,
      updatedAt: NOW - (10 - i) * DAY,
      mentions: [{ at: NOW - (10 - i) * DAY, text: `第 ${i} 件` }],
    }));
    ok(writeEventFile({ version: 1, userId: 'u1', events }, root, cfg), '⑩ 超限写入成功');

    const file = readEventFile('u1', root);
    eq(file.events.length, 3, '⑩ 只保留 max_per_user 条');
    eq(file.events.map((item) => item.id), ['evt_1', 'evt_2', 'evt_3'], '⑩ 淘汰最旧（createdAt 最小）');
  }

  /* ══════════ ⑪ done 超过 expire_days → 写入时清理 ══════════ */
  {
    const root = tempRoot();
    const events = [
      evt({ id: 'done_old', status: 'done', createdAt: NOW - 10 * DAY, updatedAt: NOW - 5 * DAY }),
      evt({ id: 'done_new', status: 'done', createdAt: NOW - 10 * DAY, updatedAt: NOW - 1 * DAY }),
      evt({ id: 'open_old', status: 'open', createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY }),
    ];
    ok(writeEventFile({ version: 1, userId: 'u1', events }, root, CFG), '⑪ 写入成功');

    const ids = readEventFile('u1', root).events.map((item) => item.id);
    ok(!ids.includes('done_old'), '⑪ 过期 done 被删除');
    ok(ids.includes('done_new'), '⑪ 未过期 done 保留');
    ok(ids.includes('open_old'), '⑪ open 不受 done 清理影响（交给 closeExpired）');
  }

  /* ══════════ 汇总 ══════════ */
  console.log(`✅ r4-events：${checks} 项断言全部通过`);
} finally {
  cleanup();
}
