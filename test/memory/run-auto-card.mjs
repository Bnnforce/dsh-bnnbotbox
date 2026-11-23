/**
 * run-auto-card — 自动建档（群卡/人物卡骨架）单测
 *
 * 为什么需要（2026-11-09 实测结构缺口）：
 *   画像层（`elysia/profiles/*.md`）每天 03:00 由 `r4-extract` **自动**生成 33 个人；
 *   而 `entities/people/*.md` / `entities/groups/*.md` 在全仓库**零自动写入**
 *   （`remember` 仅主人主动调用，生产环境调用次数实测 = 0）。
 *   结果：7 个群只有 1 个群卡、19 个关系人只有 5 篇人物卡 → 记忆联想大面积静默降级。
 *
 * 本模块是本轮补上的「自动建档」：只写**可从本机数据观测到的事实**，不写信评价。
 *
 * 纪律：全程临时目录，**不碰生产记忆库**；末尾校验生产目录 mtime 未变。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}）`); }

// ══ 生产数据快照（测试隔离红线）══════════════════════════════════════
const PROD = ((process.env.QQBOT_DATA_ROOT || '') + '/.qqbot-extensions/data/group-memory');
let prodMtime = null;
try { prodMtime = statSync(PROD).mtimeMs; } catch { /* 无生产目录也无妨 */ }

const TMP = mkdtempSync(join(tmpdir(), 'autocard-'));
const LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/memory/auto-card.js';
const A = await import(`file://${LIB}`);

const GID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GID_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const UID_1 = '11111111111111111111111111111111';
const UID_2 = '22222222222222222222222222222222';
const UID_3 = '33333333333333333333333333333333';

console.log('自动建档测试\n');

// ══ T1 sanitizeCardName（纯函数：路径安全）══════════════════════════════
console.log('T1 sanitizeCardName 路径安全');
{
  eq(A.sanitizeCardName('群友A', UID_1), '群友A', '普通昵称原样保留');
  eq(A.sanitizeCardName('张三丰', UID_1), '张三丰', '多字昵称');
  // 零宽字符昵称（实测真实存在：`⁡⁣​⁠⁣⁣`）
  const zw = A.sanitizeCardName('⁡⁣​⁠⁣⁣', UID_1);
  ok(!/[\u200B-\u200F\u2060-\u2064\uFEFF]/u.test(zw), '零宽字符被清除', `得到=${JSON.stringify(zw)}`);
  ok(zw.startsWith('成员-'), '纯零宽昵称 → 用 openid 尾号兜底', `得到=${JSON.stringify(zw)}`);
  eq(zw, `成员-${UID_1.slice(-6)}`, '兜底名 = 成员-<openid 后6位>');

  // 路径穿越
  ok(!A.sanitizeCardName('../../etc/passwd', UID_1).includes('/'), '不含斜杠');
  ok(!A.sanitizeCardName('../../etc/passwd', UID_1).includes('.'), '不含英文句点');
  ok(!A.sanitizeCardName('a\\b', UID_1).includes('\\'), '不含反斜杠');
  ok(!A.sanitizeCardName('a/b', UID_1).includes('/'), '不含正斜杠');
  // 控制字符
  ok(!/[\u0000-\u001F]/u.test(A.sanitizeCardName(`a${String.fromCharCode(0)}b`, UID_1)), '不含控制字符');
  // 超长
  const long = '很'.repeat(100);
  ok(A.sanitizeCardName(long, UID_1).length <= 40, '超长昵称被截断到 40 字');
  // 空串
  eq(A.sanitizeCardName('', UID_1), `成员-${UID_1.slice(-6)}`, '空昵称 → 兜底');
  eq(A.sanitizeCardName(null, UID_1), `成员-${UID_1.slice(-6)}`, 'null → 兜底');
  // 保留中文标点/全角括号（真实昵称里有）
  const withParen = A.sanitizeCardName('阿巴阿巴(黑泽)', UID_1);
  ok(withParen.includes('阿巴阿巴'), '保留中文', `得到=${JSON.stringify(withParen)}`);
}

// ══ T1b displayNameOf（展示名清洗：零宽昵称不能变成空条目）══════════════
console.log('\nT1b displayNameOf 展示名清洗');
{
  // 实测真实昵称：6 个字符全是零宽，肉眼完全不可见
  const ZW = '⁡⁣​⁠⁣⁣';
  eq([...ZW].length, 6, '（前提）该昵称是 6 个零宽字符');
  const d = A.displayNameOf(ZW, UID_1);
  eq(d, `成员-${UID_1.slice(-6)}`, '★ 纯零宽昵称 → 兜底成成员-尾号（不留空条目）');
  eq(A.displayNameOf('李四', UID_1), '李四', '正常昵称原样');
  eq(A.displayNameOf('  多  空格  ', UID_1), '多 空格', '空白折叠');
  eq(A.displayNameOf('', UID_1), `成员-${UID_1.slice(-6)}`, '空串 → 兜底');
  // 群卡的「已知成员」行不能出现空条目（`、` 相邻）
  const text = A.buildGroupCardText({
    groupName: 'G', gid: GID_A,
    members: [
      { openid: UID_1, name: ZW, count: 30, firstAt: 1 },
      { openid: UID_2, name: '李四', count: 29, firstAt: 2 },
    ],
    now: 1,
  });
  ok(!text.includes('、、'), '★ 已知成员里没有空条目（不会出现连续顿号）');
  ok(!/[\u200B-\u200F\u2060-\u2064]/u.test(text), '★ 群卡正文里没有零宽字符');

  // ★ 标题不能二次加前缀（实测拼出过 `# 群成员-成员-318B82`）
  const zwCard = A.buildPersonCardText({
    name: ZW, openid: UID_1, groupName: 'G', gid: GID_A, count: 1, firstAt: 1, now: 1,
  });
  ok(!zwCard.includes('成员-成员-'), '★ 兜底名不会被标题二次包装成「成员-成员-」');
  eq(zwCard.split('\n')[0], `# 群成员-${UID_1.slice(-6)}`, '零宽昵称卡的标题 = 群成员-尾号');
  const normalCard = A.buildPersonCardText({
    name: '群友A', openid: UID_2, groupName: 'G', gid: GID_A, count: 1, firstAt: 1, now: 1,
  });
  eq(normalCard.split('\n')[0], '# 群成员-群友A', '普通昵称卡的标题不变');
  ok(!zwCard.includes('群成员：；'), '★ 正文里没有空名字');
}

// ══ T2 buildGroupCardText（纯函数：只有可观测事实）═══════════════════════console.log('\nT2 buildGroupCardText');
{
  const members = [
    { openid: UID_1, name: '张三丰', count: 85, firstAt: 1793885812325 },
    { openid: UID_2, name: '李四', count: 29, firstAt: 1793931504479 },
    { openid: UID_3, name: '群友A', count: 132, firstAt: 1793882968239 },
  ];
  const text = A.buildGroupCardText({ groupName: '测试群', gid: GID_A, members, now: 1794185402521 });
  ok(text.startsWith('# 群-测试群'), '标题含群名');
  ok(text.includes('## Current'), '含 Current 段（记忆联想靠它取正文）');
  ok(text.includes(`openid：${GID_A}`), '含群 openid');
  ok(text.includes('张三丰'), '含成员名');
  ok(text.includes('## History'), '含 History 段');
  // 按发言数降序：群友A(132) 应排在 李四(29) 前面
  const idxBnn = text.indexOf('群友A');
  const idxXin = text.indexOf('李四');
  ok(idxBnn < idxXin, '成员按发言数降序排列');
  // 读写契约：能被 extractCurrentSection 抽出（模拟 persona 侧）
  const cur = text.slice(text.indexOf('## Current'), text.indexOf('## History'));
  ok(cur.length > 0, 'Current 段非空');
  // 上限：超过 12 人时用「等」收尾
  const many = Array.from({ length: 20 }, (_, i) => ({
    openid: String(i).padEnd(32, '0'), name: `人${i}`, count: 20 - i, firstAt: 1,
  }));
  const t2 = A.buildGroupCardText({ groupName: '大群', gid: GID_B, members: many, now: 1 });
  ok(t2.includes('等'), '超过 12 人 → 用「等」收尾');
  // 没有成员时不该出现「已知成员」这一行（避免空列表噪音）
  const t3 = A.buildGroupCardText({ groupName: '空群', gid: GID_B, members: [], now: 1 });
  ok(!t3.includes('已知成员'), '无成员 → 不写「已知成员」行');
  ok(t3.includes('## Current'), '无成员也仍含 Current');
}

// ══ T3 buildPersonCardText（纯函数：openid + Current 必须齐）═════════════
console.log('\nT3 buildPersonCardText');
{
  const text = A.buildPersonCardText({
    name: '群友A', openid: UID_1, groupName: '测试群', gid: GID_A,
    count: 85, firstAt: 1793885812325, now: 1794185402521,
  });
  ok(text.startsWith('# 群成员-群友A'), '标题格式与现有卡一致');
  ok(text.includes(`openid：${UID_1}`), '★ 含 openid（记忆联想靠它匹配人）');
  ok(text.includes('## Current'), '★ 含 Current 段');
  // 反向验证：这张卡必须能被 card-audit 判为合格（两个模块口径一致）
  ok(true, '（T5 用真实 audit 交叉验证口径）');
  const noGroup = A.buildPersonCardText({
    name: 'X', openid: UID_2, groupName: '', gid: GID_B,
    count: 3, firstAt: 1, now: 2,
  });
  ok(noGroup.includes(`群 openid：${GID_B}`), '群名缺失 → 写群 openid');
  // 计数事实必须是可观测的整数，不能是 NaN
  ok(!/NaN/u.test(text), '不含 NaN');
}

// ══ T4 pickNewPeople（纯函数：四级判据）════════════════════════════════
console.log('\nT4 pickNewPeople 挑选判据');
{
  const members = [
    { openid: UID_1, name: '常说话的', count: 50, firstAt: 1 },
    { openid: UID_2, name: '偶尔说话', count: 6, firstAt: 2 },
    { openid: UID_3, name: '只看不说', count: 2, firstAt: 3 },  // 低于 minMessages
    { openid: '44444', name: 'Q群管家', count: 100, firstAt: 4 }, // ignoreNames
    { openid: '55555', name: '已有卡的人', count: 99, firstAt: 5 }, // 已存在 openid
  ];
  const cfg = { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: ['Q群管家'] };
  const existing = new Set(['55555']);
  const { picked, ineligible, overCap } = A.pickNewPeople({ members, existingOpenids: existing, cfg });
  eq(picked.length, 2, '只剩 2 个符合条件');
  ok(picked[0].openid === UID_1, '按发言数降序：最高者第一');
  ok(!picked.some((p) => p.openid === UID_3), '低于 minMessages 不建');
  ok(!picked.some((p) => p.name === 'Q群管家'), 'ignoreNames 不建');
  ok(!picked.some((p) => p.openid === '55555'), '已存在 openid 不建');
  eq(ineligible, 3, '3 人因证据不足/忽略/已存在而落选');
  eq(overCap, 0, '未超上限 → overCap=0');

  // 上限裁剪：10 人里发言数 10..1，阈值 5 → 够格 6 人（10/9/8/7/6/5），取前 3
  const many = Array.from({ length: 10 }, (_, i) => ({ openid: `u${i}`, name: `n${i}`, count: 10 - i, firstAt: i }));
  const r2 = A.pickNewPeople({ members: many, existingOpenids: new Set(), cfg: { ...cfg, maxPerGroup: 3 } });
  eq(r2.picked.length, 3, 'maxPerGroup 生效');
  eq(r2.overCap, 3, '够格 6 人、只取 3 → 超上限 3 人');
  eq(r2.ineligible, 4, '发言数 4/3/2/1 低于阈值 5 → 4 人落选');

  // minMessages=1 时「说过一句」也算
  const r3 = A.pickNewPeople({
    members: [{ openid: 'u', name: 'n', count: 1, firstAt: 1 }],
    existingOpenids: new Set(),
    cfg: { ...cfg, minMessages: 1 },
  });
  eq(r3.picked.length, 1, 'minMessages=1 → 发过一句就建');
}

// ══ T5 openidOfCard 与 card-audit 口径一致（防「体检过但联想挂」）═══════
console.log('\nT5 openidOfCard ↔ card-audit 口径一致');
{
  const AUDIT_LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/memory/card-audit.js';
  const AUD = await import(`file://${AUDIT_LIB}`);
  const text = A.buildPersonCardText({
    name: '群友A', openid: UID_1, groupName: '测试群', gid: GID_A,
    count: 85, firstAt: 1793885812325, now: 1794185402521,
  });
  // ① 自动生成的卡必须能通过体检（否则「自动建档了但体检报警」= 自相矛盾）
  eq(AUD.auditCardText(text).length, 0, '自动生成的人物卡通过体检（缺项为空）');
  // ② 体检模块的 openid 正则与 auto-card 的一致
  eq(A.openidOfCard(text), UID_1, 'openidOfCard 能抽回 openid');
  // ③ 反面：没 openid 的卡抽不出（不能假装有）
  eq(A.openidOfCard('# 群成员-X\n\n## Current\n- 无\n'), '', '无 openid → 空串');
  eq(AUD.auditCardText('# 群成员-X\n\n## Current\n- 无\n').includes('openid'), true, '无 openid 的卡体检会报警');
}

// ══ T6 runAutoCards 端到端（临时目录）══════════════════════════════════
console.log('\nT6 runAutoCards 端到端');
{
  const root = join(TMP, 'qqbot');
  const memRoot = join(TMP, 'mem');
  mkdirSync(join(root, '.qqbot', 'msg-history', `group_${GID_A}`), { recursive: true });
  mkdirSync(join(root, '.qqbot', 'msg-history', `group_${GID_B}`), { recursive: true });
  mkdirSync(join(root, '表情包'), { recursive: true });
  mkdirSync(join(memRoot, 'groups', GID_A), { recursive: true });
  mkdirSync(join(memRoot, 'groups', GID_B), { recursive: true });

  // groups.json
  writeFileSync(join(root, '.qqbot', 'groups.json'), JSON.stringify({
    [GID_A]: { name: 'A 测试群' },
    [GID_B]: { name: 'B 测试群' },
  }), 'utf8');

  // 成员台账
  writeFileSync(join(root, '表情包', 'group-members.jsonl'), [
    JSON.stringify({ ts: 100, gid: GID_A, mid: UID_1, name: '张三丰' }),
    JSON.stringify({ ts: 200, gid: GID_A, mid: UID_2, name: '李四' }),
    JSON.stringify({ ts: 300, gid: GID_B, mid: UID_3, name: '群友A' }),
  ].join('\n'), 'utf8');

  // 消息历史：UID_1 说 8 条（够），UID_2 说 2 条（不够）
  const linesA = [];
  for (let i = 0; i < 8; i++) linesA.push(JSON.stringify({ s: UID_1, n: '张三丰', t: 1000 + i, x: `m${i}` }));
  for (let i = 0; i < 2; i++) linesA.push(JSON.stringify({ s: UID_2, n: '李四', t: 2000 + i, x: `m${i}` }));
  // ★ bot 自己要说 10 条（> 阈值 5）—— 只有这样，「跳过 self」的守卫被删掉时测试才会变红。
  //   （2026-11-09 变异测试发现：只放 1 条 bot 消息时，删守卫测试照样全绿 = 假通过。）
  for (let i = 0; i < 10; i++) linesA.push(JSON.stringify({ s: 'self', n: '机器人', t: 3000 + i, x: `bot${i}`, me: true }));
  writeFileSync(join(root, '.qqbot', 'msg-history', `group_${GID_A}`, '2026-11-09.jsonl'), linesA.join('\n'), 'utf8');

  const linesB = [];
  for (let i = 0; i < 20; i++) linesB.push(JSON.stringify({ s: UID_3, n: '群友A', t: 4000 + i, x: `b${i}` }));
  writeFileSync(join(root, '.qqbot', 'msg-history', `group_${GID_B}`, '2026-11-09.jsonl'), linesB.join('\n'), 'utf8');

  const cfg = { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: ['Q群管家'] };
  const report = A.runAutoCards({ memoryRoot: memRoot, qqbotRoot: root, config: cfg, now: 1794185402521, timeZone: 'Asia/Shanghai' });

  eq(report.scannedGroups, 2, '扫了 2 个群');
  eq(report.groupsCreated.length, 2, '两个群都建了群卡');
  eq(report.peopleCreated.length, 2, '只有 2 人达标（UID_1 8条 / UID_3 20条）');
  ok(report.peopleCreated.some((p) => p.name === '张三丰'), 'UID_1 建了卡');
  ok(!report.peopleCreated.some((p) => p.name === '李四'), 'UID_2 仅 2 条 < 5 → 不建');
  eq(report.failed, 0, '无失败');

  // 落盘校验
  const cardA = join(memRoot, 'groups', GID_A, 'entities', 'people', '张三丰.md');
  ok(existsSync(cardA), '人物卡文件已落盘');
  const body = readFileSync(cardA, 'utf8');
  ok(body.includes(`openid：${UID_1}`), '落盘内容含 openid');
  ok(body.includes('## Current'), '落盘内容含 Current');
  // bot 自己没有出现在人物卡里
  ok(!existsSync(join(memRoot, 'groups', GID_A, 'entities', 'people', '机器人.md')), 'bot 自己不建卡');
  // 群卡
  const gcard = join(memRoot, 'groups', GID_A, 'entities', 'groups', 'A 测试群.md');
  ok(existsSync(gcard), '群卡已落盘');
  const gbody = readFileSync(gcard, 'utf8');
  ok(gbody.includes('张三丰'), '群卡含「已知成员」昵称（不写 openid，省注入预算）');
  ok(!gbody.includes(UID_1), '群卡不暴露成员 openid（隐私 + 省预算）');
}

// ══ T7 幂等 + 绝不覆盖已有卡 ════════════════════════════════════════════
console.log('\nT7 幂等与「绝不改写主人数据」');
{
  const root = join(TMP, 'qqbot');
  const memRoot = join(TMP, 'mem');
  const cfg = { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: [] };

  // 第一遍已建过 → 第二遍必须零新增
  const r2 = A.runAutoCards({ memoryRoot: memRoot, qqbotRoot: root, config: cfg, now: 2, timeZone: 'Asia/Shanghai' });
  eq(r2.groupsCreated.length, 0, '第二遍不重复建群卡');
  eq(r2.peopleCreated.length, 0, '第二遍不重复建人物卡');

  // 主人手写的卡：内容含评价 → 自动建档绝不能覆盖
  const ownPath = join(memRoot, 'groups', GID_A, 'entities', 'people', '张三丰.md');
  const handWritten = '# 群成员-张三丰\n\n## Current\n- 群成员：张三丰；openid：' + UID_1 + '。\n- 主人评价：嘴特别欠。\n';
  writeFileSync(ownPath, handWritten, 'utf8');
  const r3 = A.runAutoCards({ memoryRoot: memRoot, qqbotRoot: root, config: cfg, now: 3, timeZone: 'Asia/Shanghai' });
  eq(r3.peopleCreated.length, 0, '已有卡（主人手写）→ 不新建');
  eq(readFileSync(ownPath, 'utf8'), handWritten, '★ 主人手写内容逐字节未被改写');
}

// ══ T7b writeCardOnce 直接验证「绝不覆盖」守卫 ═══════════════════════════
//
// 为什么要单独测（2026-11-09 变异测试发现）：只在 runAutoCards 里间接验证，
// **删掉「已存在就返回 exists」这个守卫，测试照样全绿** —— 因为第二次 run 时
// 文件已存在，走的是「新建→失败」而不是「拒绝写」路径，行为恰好相同。
// 所以必须直接对 `writeCardOnce` 做一次「先写、再改、再写」的验证。
console.log('\nT7b writeCardOnce 守卫直接验证');
{
  const dir = join(TMP, 'guard-test');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'x.md');

  const r1 = A.writeCardOnce(p, '第一版');
  eq(r1, 'created', '首次 → created');
  eq(readFileSync(p, 'utf8'), '第一版', '内容写入');

  const r2 = A.writeCardOnce(p, '第二版');
  eq(r2, 'exists', '★ 已存在 → 返回 exists');
  eq(readFileSync(p, 'utf8'), '第一版', '★ 原有内容逐字节未被覆盖');

  // 反向证明这个断言真的有效：手工覆盖后守卫确实会「看不到」新内容
  writeFileSync(p, '主人改过的', 'utf8');
  const r3 = A.writeCardOnce(p, '又来一版');
  eq(r3, 'exists', '仍然拒绝写');
  eq(readFileSync(p, 'utf8'), '主人改过的', '★ 主人改过的内容也未被覆盖');
}

// ══ T8 dryRun 不落盘 ════════════════════════════════════════════════════
console.log('\nT8 dryRun 只算不写');
{
  const root = join(TMP, 'qqbot');
  const dryMem = join(TMP, 'mem-dry');
  mkdirSync(join(dryMem, 'groups', GID_A), { recursive: true });
  const cfg = { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: [] };
  const r = A.runAutoCards({ memoryRoot: dryMem, qqbotRoot: root, config: cfg, now: 1, dryRun: true, timeZone: 'Asia/Shanghai' });
  eq(r.dryRun, true, '报告标记 dryRun');
  ok(r.groupsCreated.length > 0, 'dryRun 也统计「会建几个」');
  ok(!existsSync(join(dryMem, 'groups', GID_A, 'entities')), '★ dryRun 真的没落盘');
}

// ══ T8b 「零新建也要留痕」（可观测性）═══════════════════════════════════
//
// 为什么（2026-11-09 重启验证抓到的真问题）：
//   初版 `reportAutoCards` 在「没有任何新建」时直接 return，不落盘。
//   结果重启后想确认「启动补跑到底跑没跑」，**日志里什么都没有** ——
//   分不清「跑了但无事可做」和「压根没跑」。这正是本项目反复踩的静默失效。
//   修法：每一轮都落盘，用 event 区分 run / noop。
// 这里直接验证 tasks.js 的落盘行为（用 DSH_HOME 隔离，不污染真实诊断目录）。
console.log('\nT8b 零新建也落盘（noop 留痕）');
{
  const TASKS_LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/memory/tasks.js';
  const T = await import(`file://${TASKS_LIB}`);
  eq(typeof T.registerMaintenanceTask, 'function', 'tasks.js 导出 registerMaintenanceTask');
  // 用独立的一套数据，确保「零新建」：
  //   ① 只用 UID_1（已在 fixture 里预建人物卡）
  //   ② 群卡也预建 → 群卡不会再新建
  const logHome = join(TMP, 'home-noop');
  const memOk = join(TMP, 'mem-noop');
  const qqOk = join(TMP, 'qqbot-noop');
  mkdirSync(join(memOk, 'groups', GID_A, 'entities', 'people'), { recursive: true });
  mkdirSync(join(memOk, 'groups', GID_A, 'entities', 'groups'), { recursive: true });
  writeFileSync(join(memOk, 'groups', GID_A, 'entities', 'people', '张三丰.md'),
    '# 群成员-张三丰\n\n## Current\n- 群成员：张三丰；openid：' + UID_1 + '。\n', 'utf8');
  writeFileSync(join(memOk, 'groups', GID_A, 'entities', 'groups', 'NOOP群.md'),
    '# 群-NOOP群\n\n## Current\n- 群：NOOP群；openid：' + GID_A + '。\n', 'utf8');
  // qqbot 侧：只有 UID_1 说话（已建卡），且群名逻辑上不存在（群卡已预建，无所谓）
  mkdirSync(join(qqOk, '.qqbot', 'msg-history', `group_${GID_A}`), { recursive: true });
  const noopLines = [];
  for (let i = 0; i < 8; i++) noopLines.push(JSON.stringify({ s: UID_1, n: '张三丰', t: 1 + i }));
  writeFileSync(join(qqOk, '.qqbot', 'msg-history', `group_${GID_A}`, 'x.jsonl'), noopLines.join('\n'), 'utf8');

  let report;
  try {
    report = A.runAutoCards({
      memoryRoot: memOk, qqbotRoot: qqOk,
      config: { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: [] },
      now: 1,
    });
  } catch { /* ignore */ }
  eq(report.groupsCreated.length + report.peopleCreated.length, 0, '（前提）这一轮零新建');

  // 关键断言：tasks.js 的源码里，零新建分支必须有 appendFileSync（不是直接 return）
  const src = readFileSync(TASKS_LIB, 'utf8');
  const fnStart = src.indexOf('function reportAutoCards');
  const fnBody = src.slice(fnStart, fnStart + 4000); // 放大切片：run 分支在 noop 之后
  ok(fnBody.includes('if (!created)'), '零新建有独立分支');
  ok(fnBody.includes("event: 'noop'"), '★ 零新建分支写入 event=noop（可验证「跑过但没活干」）');
  ok(fnBody.includes("event: 'run'"), '有新建分支写入 event=run');
  // 反向：零新建分支里不能是「直接 return 不落盘」
  const noopStart = fnBody.indexOf('if (!created)');
  const runAt = fnBody.indexOf("event: 'run'");
  const noopBlock = fnBody.slice(noopStart, runAt > noopStart ? runAt : fnBody.length);
  ok(noopBlock.includes('appendFileSync'), '★ 零新建分支真的 appendFileSync（不是只 return）');
  ok(noopBlock.includes('trigger'), '★ noop 记录带 trigger（能区分 startup / interval）');
}

// ══ T9 降级：数据源缺失/损坏绝不影响主流程 ══════════════════════════════
console.log('\nT9 降级（永不抛）');
{
  // 没有 groups.json / 没有台账 / 没有消息历史 → 不炸，报告为空
  const emptyMem = join(TMP, 'mem-empty');
  const emptyQq = join(TMP, 'qq-empty');
  mkdirSync(join(emptyMem, 'groups', GID_A), { recursive: true });
  mkdirSync(emptyQq, { recursive: true });
  const cfg = { enabled: true, groupEnabled: true, minMessages: 5, maxPerGroup: 30, ignoreNames: [] };
  let threw = false;
  let r;
  try {
    r = A.runAutoCards({ memoryRoot: emptyMem, qqbotRoot: emptyQq, config: cfg, now: 1 });
  } catch (e) { threw = true; }
  ok(!threw, '数据源全缺 → 不抛异常');
  ok(r && r.scannedGroups >= 1, '仍扫到群目录');
  // 没有 groups.json → 群名兜底成「未命名群-尾号」，不能是空的
  const gDir = join(emptyMem, 'groups', GID_A, 'entities', 'groups');
  if (existsSync(gDir)) {
    const names = readdirSync(gDir);
    eq(names.length, 1, '空数据也建了 1 张群卡（群目录存在即有卡位）');
    const body = readFileSync(join(gDir, names[0]), 'utf8');
    ok(body.includes('未命名群'), '群名缺失 → 用「未命名群」兜底（不写空标题）');
    ok(!body.includes('# 群-\n'), '标题不是空的');
  } else {
    ok(false, '空数据也应有群卡目录');
  }

  // enabled=false → 直接空报告
  const rOff = A.runAutoCards({ memoryRoot: emptyMem, qqbotRoot: emptyQq, config: { ...cfg, enabled: false }, now: 1 });
  eq(rOff.scannedGroups, 0, 'enabled=false → 不扫');

  // memoryRoot 不存在 → 空报告，不抛
  const rNo = A.runAutoCards({ memoryRoot: join(TMP, 'nope'), qqbotRoot: emptyQq, config: cfg, now: 1 });
  eq(rNo.scannedGroups, 0, 'memoryRoot 不存在 → 空报告');

  // 损坏的 groups.json（非法 JSON）→ 不炸
  mkdirSync(join(emptyQq, '.qqbot'), { recursive: true });
  writeFileSync(join(emptyQq, '.qqbot', 'groups.json'), '{ 这不是合法 json', 'utf8');
  let threw2 = false;
  try { A.runAutoCards({ memoryRoot: emptyMem, qqbotRoot: emptyQq, config: cfg, now: 1 }); } catch { threw2 = true; }
  ok(!threw2, '★ groups.json 损坏 → 不抛');

  // 损坏的消息历史行 → 跳过坏行，不炸
  mkdirSync(join(emptyQq, '.qqbot', 'msg-history', `group_${GID_A}`), { recursive: true });
  writeFileSync(join(emptyQq, '.qqbot', 'msg-history', `group_${GID_A}`, 'x.jsonl'),
    'not json\n' + JSON.stringify({ s: UID_1, n: '好行', t: 1 }) + '\n{坏行', 'utf8');
  let threw3 = false;
  try { A.runAutoCards({ memoryRoot: emptyMem, qqbotRoot: emptyQq, config: cfg, now: 1 }); } catch { threw3 = true; }
  ok(!threw3, '★ 消息历史坏行 → 跳过不抛');
}

// ══ 测试隔离校验（红线）════════════════════════════════════════════════
console.log('\n测试隔离校验');
try {
  rmSync(TMP, { recursive: true, force: true });
  ok(!existsSync(TMP), '临时目录已清理');
} catch { ok(false, '临时目录清理失败'); }
if (prodMtime !== null) {
  try {
    const now = statSync(PROD).mtimeMs;
    ok(Math.abs(now - prodMtime) < 1, '★ 生产记忆库 mtime 未变（测试未污染）', `实际=${now} 期望=${prodMtime}`);
  } catch { ok(false, '生产记忆库不可读'); }
}

console.log(`\n${fail === 0 ? '✅ 通过' : '❌ 失败'} ${pass} / ${fail}`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
