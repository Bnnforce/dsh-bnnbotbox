#!/usr/bin/env node
/**
 * R4.3 批次 C — F3 关系里程碑 + F2 lastMentionedTags 兼容结构 测试。
 *
 * 运行：node test-r4/r4-milestones.mjs（需先由 Lead 统一 build 出 lib/）
 *
 * 覆盖（任务书 ①~⑦ + first_topic 补充）：
 *   ① 冷启动 <3 天不产出
 *   ② 认识 N 天能产出（文案不含 Lv/等级字样）
 *   ③ 同一事实 14 天内不重复
 *   ④ 不同 kind 互不影响
 *   ⑤ lastMentionedTags 旧数字格式读成 {at,count:1}
 *   ⑥ 新格式写入后 count 累加
 *   ⑦ 坏文件不抛错
 *   ⑧ first_topic：画像 tag 匹配 / 首次出现时间记录 / 优先级
 *
 * 数据根一律 mkdtemp 隔离，绝不碰生产目录。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { milestoneFor } = await import('../../lib/persona/r4/milestones.js');
const { tagMentionStats, recordTagMention } = await import('../../lib/persona/r4/profile-store.js');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const GID = 'g1';
const UID = 'u1';

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

/** 本文件创建的所有临时数据根，退出时统一清理。 */
const roots = [];

function newRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'r4-milestones-'));
  roots.push(dir);
  return dir;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 造一份合法的关系记录（可附加 firstMetAt / messageCount / topicFirstSeen 扩展字段）。 */
function seedRelationship(root, extras = {}) {
  writeJson(join(root, 'state', 'relationships', `${GID}.json`), {
    [UID]: {
      level: 'L2',
      score: 5,
      lastDecayAt: NOW,
      updatedAt: NOW,
      scoreCooldowns: { reply: 0, mention: 0, bot: 0 },
      temporaryAttitude: '',
      temporaryAttitudeExpiresAt: 0,
      ...extras,
    },
  });
}

/** 造一份画像索引（lastMentionedTags 用旧数字格式，刻意验证向后兼容）。 */
function seedIndex(root, tags) {
  writeJson(join(root, 'elysia', 'profiles', 'index.json'), {
    [UID]: { lastMentionedTags: tags, coldStartUntil: 0 },
  });
}

function callMilestone(root, now = NOW, topics) {
  const input = { groupId: GID, userId: UID, root, now };
  if (topics !== undefined) input.topics = topics;
  return milestoneFor(input);
}

try {
  /* ══════════════ ① 冷启动 <3 天不产出 ══════════════ */
  {
    const root = newRoot();
    // 即使消息数很大，认识才 2 天也绝不硬编亲密。
    seedRelationship(root, { firstMetAt: NOW - 2 * DAY, messageCount: 100 });
    eq(callMilestone(root), null, '① 认识 2 天（<3 天冷启动）→ 不产出');

    // 冷启动期连冷却表都不该写（否则冷启动结束后的第一次会被自己挡掉）。
    let cooldownText = '';
    try {
      cooldownText = readFileSync(join(root, 'state', 'phrase-cooldown.json'), 'utf8');
    } catch {
      /* 文件不存在是预期 */
    }
    eq(cooldownText.trim(), '', '① 冷启动期不写冷却表');
  }

  /* ══════════════ ② 认识 N 天能产出 ══════════════ */
  {
    const root = newRoot();
    seedRelationship(root, { firstMetAt: NOW - 5 * DAY });
    const fact = callMilestone(root);
    ok(fact, '② 认识 5 天 → 有事实');
    eq(fact.kind, 'days_known', '② kind = days_known');
    ok(fact.text.includes('5 天'), '② 文案含真实天数（5 天）');
    ok(!/Lv|等级|level/i.test(fact.text), '② 文案不含 Lv/等级 字样');
    ok(Number.isFinite(fact.at) && fact.at > 0, '② at 是有效时间戳');
  }

  /* ══════════════ ③ 同一事实 14 天内不重复 ══════════════ */
  {
    const root = newRoot();
    seedRelationship(root, { firstMetAt: NOW - 10 * DAY });
    eq(callMilestone(root)?.kind, 'days_known', '③ 第 1 次 → days_known');
    eq(callMilestone(root, NOW + DAY), null, '③ 第 2 天同一事实冷却中 → null');

    const later = callMilestone(root, NOW + 15 * DAY);
    eq(later?.kind, 'days_known', '③ 15 天后冷却结束 → 可再次产出');
    ok(later.text.includes('25 天'), '③ 文案按真实天数重算（25 天）');
  }

  /* ══════════════ ④ 不同 kind 互不影响 ══════════════ */
  {
    const root = newRoot();
    seedRelationship(root, { firstMetAt: NOW - 10 * DAY, messageCount: 7 });

    eq(callMilestone(root)?.kind, 'days_known', '④ 第 1 条：days_known 优先');
    const second = callMilestone(root);
    eq(second?.kind, 'message_count', '④ days_known 冷却后 → message_count 仍可产出');
    ok(second.text.includes('7 次'), '④ 消息数文案正确（7 次）');
    eq(callMilestone(root), null, '④ 两种 kind 都在冷却 → null');
  }

  /* ══════════════ ⑤ 旧数字格式读取兼容 ══════════════ */
  eq(
    tagMentionStats({ lastMentionedTags: { 猫图: 1_793_500_000_000 }, coldStartUntil: 0 }, '猫图'),
    { at: 1_793_500_000_000, count: 1 },
    '⑤ 旧数字格式 → {at, count:1}',
  );
  eq(
    tagMentionStats({ lastMentionedTags: { 猫图: { at: 1_793_500_000_000, count: 3 } }, coldStartUntil: 0 }, '猫图'),
    { at: 1_793_500_000_000, count: 3 },
    '⑤ 新对象格式 → 正常读',
  );
  eq(
    tagMentionStats({ lastMentionedTags: {}, coldStartUntil: 0 }, '猫图'),
    { at: 0, count: 0 },
    '⑤ tag 缺失 → {0,0}',
  );
  eq(tagMentionStats(undefined, '猫图'), { at: 0, count: 0 }, '⑤ entry 缺失 → {0,0}');
  eq(
    tagMentionStats({ lastMentionedTags: { 猫图: '坏值' }, coldStartUntil: 0 }, '猫图'),
    { at: 0, count: 0 },
    '⑤ 坏值 → {0,0}（不抛）',
  );

  /* ══════════════ ⑥ 新格式写入后 count 累加 ══════════════ */
  {
    const root = newRoot();
    const indexPath = join(root, 'elysia', 'profiles', 'index.json');
    writeJson(indexPath, {
      [UID]: { lastMentionedTags: { 猫图: NOW - 5 * DAY }, coldStartUntil: 12345 },
      u2: { lastMentionedTags: { 追番: NOW }, coldStartUntil: 9 },
    });

    eq(
      recordTagMention({ root, userId: UID, tag: '猫图', now: NOW }),
      true,
      '⑥ 首次写入成功',
    );
    let raw = readJson(indexPath);
    eq(
      tagMentionStats(raw[UID], '猫图'),
      { at: NOW, count: 2 },
      '⑥ 旧数字按 count=1 读 → 累加成 2',
    );
    eq(raw[UID].coldStartUntil, 12345, '⑥ 保留 coldStartUntil');
    eq(
      raw.u2,
      { lastMentionedTags: { 追番: NOW }, coldStartUntil: 9 },
      '⑥ 其它用户条目原样保留',
    );

    eq(
      recordTagMention({ root, userId: UID, tag: '猫图', now: NOW + 1000 }),
      true,
      '⑥ 第二次写入成功',
    );
    raw = readJson(indexPath);
    eq(
      tagMentionStats(raw[UID], '猫图'),
      { at: NOW + 1000, count: 3 },
      '⑥ count 继续累加到 3',
    );
    eq(
      recordTagMention({ root, userId: UID, tag: '新标签', now: NOW }),
      true,
      '⑥ 新 tag 写入成功',
    );
    raw = readJson(indexPath);
    eq(
      tagMentionStats(raw[UID], '新标签'),
      { at: NOW, count: 1 },
      '⑥ 新 tag 从 count=1 开始',
    );
    eq(
      recordTagMention({ root, userId: UID, tag: '', now: NOW }),
      false,
      '⑥ 空 tag → false（不抛）',
    );
  }

  /* ══════════════ ⑦ 坏文件不抛错 ══════════════ */
  {
    const root = newRoot();
    const relPath = join(root, 'state', 'relationships', `${GID}.json`);
    mkdirSync(dirname(relPath), { recursive: true });
    writeFileSync(relPath, '{not json', 'utf8');
    const indexPath = join(root, 'elysia', 'profiles', 'index.json');
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, 'broken', 'utf8');
    writeFileSync(join(root, 'state', 'milestone-cache.json'), '[[[', 'utf8');

    let threw = false;
    let fact = null;
    try {
      fact = callMilestone(root, NOW, ['猫图']);
    } catch {
      threw = true;
    }
    eq(threw, false, '⑦ 坏关系/索引/缓存文件不抛');
    eq(fact, null, '⑦ 坏文件 → null');

    let writeThrew = false;
    let wrote = null;
    try {
      wrote = recordTagMention({ root, userId: UID, tag: '猫图', now: NOW });
    } catch {
      writeThrew = true;
    }
    eq(writeThrew, false, '⑦ 坏索引下写入不抛');
    eq(typeof wrote, 'boolean', '⑦ 坏索引写入返回布尔值');
  }

  // 非法入参同样只返回 null，不抛。
  eq(
    milestoneFor({ groupId: '', userId: UID, root: newRoot(), now: NOW }),
    null,
    '⑦ 非法 groupId → null',
  );
  eq(
    milestoneFor({ groupId: GID, userId: '', root: newRoot(), now: NOW }),
    null,
    '⑦ 非法 userId → null',
  );
  eq(
    milestoneFor({ groupId: GID, userId: UID, root: newRoot(), now: Number.NaN }),
    null,
    '⑦ 非法 now → null',
  );
  ok(
    (() => {
      try {
        milestoneFor({ groupId: GID, userId: UID, root: newRoot(), now: NOW, topics: '不是数组' });
        return true;
      } catch {
        return false;
      }
    })(),
    '⑦ topics 非数组不抛',
  );

  /* ══════════════ ⑧ first_topic（补充） ══════════════ */
  {
    const root = newRoot();
    seedIndex(root, { 猫图: NOW });
    // 第一次观测：冷启动 + 记录 firstMetAt / topic 首次出现时间。
    eq(callMilestone(root, NOW, ['猫图']), null, '⑧ 首次观测（冷启动）→ null');

    const cached = readJson(join(root, 'state', 'milestone-cache.json'));
    const user = cached.users[`${GID}:${UID}`];
    ok(user && user.firstMetAt > 0, '⑧ 冷启动期已固定 firstMetAt');
    eq(user.topicFirstSeen['猫图'], NOW, '⑧ 冷启动期已记录 topic 首次出现时间');

    const second = callMilestone(root, NOW + 4 * DAY, ['猫图']);
    eq(second?.kind, 'first_topic', '⑧ 4 天后 → first_topic 优先于 days_known');
    ok(second.text.includes('「猫图」'), '⑧ 文案带话题名');
    ok(second.text.includes('4 天前'), '⑧ 文案带真实天数');
    ok(!/Lv|等级|level/i.test(second.text), '⑧ 不含等级播报');

    const third = callMilestone(root, NOW + 5 * DAY, ['猫图']);
    eq(third?.kind, 'days_known', '⑧ first_topic 冷却中 → 退到 days_known');
  }

  {
    const root = newRoot();
    seedIndex(root, { 追番: NOW });
    eq(callMilestone(root, NOW, ['猫图']), null, '⑧ 话题不匹配画像 tag → 首次观测仍冷启动');
    const fact = callMilestone(root, NOW + 4 * DAY, ['猫图']);
    eq(fact?.kind, 'days_known', '⑧ 话题不匹配画像 tag → 不出 first_topic');
  }

  /* ══════════════ ⑨ 跨群隔离（补充） ══════════════ */
  {
    const root = newRoot();
    seedRelationship(root, { firstMetAt: NOW - 10 * DAY });
    eq(callMilestone(root)?.kind, 'days_known', '⑨ 群 g1 认识 10 天 → 可产出');
    eq(
      milestoneFor({ groupId: 'g2', userId: UID, root, now: NOW }),
      null,
      '⑨ 另一个群对同一用户仍是陌生（冷启动）→ null',
    );
    eq(callMilestone(root), null, '⑨ 跨群调用不影响 g1 的冷却');
  }
} finally {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
}

console.log(`r4-milestones: passed ${checks} checks`);
