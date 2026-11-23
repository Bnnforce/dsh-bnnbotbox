/**
 * run-card-audit — 人物卡格式体检单测
 *
 * 为什么需要（真机教训）：示例群 `张三丰.md` 缺 `openid` + `## Current`，
 * 导致该群记忆联想**每轮静默跳过**（`recall:skip no-items`）—— 没报错、没日志，
 * 只能翻数据才发现。本模块就是为了把这种静默失效变成**可见告警**。
 *
 * 纪律：全程临时目录，**不碰生产记忆库**；末尾校验生产目录 mtime 未变。
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const TMP = mkdtempSync(join(tmpdir(), 'cardaudit-'));
const LIB = new URL('../../', import.meta.url).pathname.replace(/\/$/, '') + '/lib/memory/card-audit.js';
const A = await import(`file://${LIB}`);

console.log('人物卡格式体检测试\n');

// ══ T1 auditCardText（纯函数）═══════════════════════════════════════════
console.log('T1 auditCardText 单卡判定');
{
  const good = '# 群成员-好卡\n\n## Current\n- 群成员：好卡；openid：ABCDEF0123456789ABCDEF0123456789。\n';
  eq(A.auditCardText(good).length, 0, '标准卡 → 无问题');

  const noOpenid = '# 群成员-X\n\n## Current\n- 群成员：X。\n';
  ok(A.auditCardText(noOpenid).includes('openid'), '缺 openid → 检出');
  ok(!A.auditCardText(noOpenid).includes('current'), '缺 openid 但 Current 在 → 不误报 current');

  const noCurrent = '# 群成员-Y\n- openid：11112222333344445555666677778888\n';
  ok(A.auditCardText(noCurrent).includes('current'), '缺 Current → 检出');
  ok(!A.auditCardText(noCurrent).includes('openid'), '缺 Current 但 openid 在 → 不误报 openid');

  // 某个坏卡的真实样子
  const broken = '# 张三丰\n- 主人评价：嘴特别欠\n- 主人补充：扬言要吃水泥\n';
  eq(A.auditCardText(broken).length, 2, '该类坏卡 → 两项都检出');

  // 边界：空内容 / 只有标题
  eq(A.auditCardText('').length, 2, '空内容 → 两项都缺');
  eq(A.auditCardText('# 只有标题\n').length, 2, '只有标题 → 两项都缺');

  // 全角冒号也要认（实测数据里有全角）
  ok(A.auditCardText('# x\n\n## Current\n- openid：ABCDEF0123456789\n').length === 0,
    '全角冒号的 openid 也认');
  // 大小写不敏感（Current / current）
  ok(A.auditCardText('# x\n\n## current\n- openid：ABCDEF0123456789\n').length === 0,
    '小写 current 也认');
}

// ══ T2 auditMemoryCards（全库扫描）══════════════════════════════════════
console.log('\nT2 auditMemoryCards 全库扫描');
{
  const root = join(TMP, 'gm');
  const p1 = join(root, 'groups', 'GID_A', 'entities', 'people');
  const p2 = join(root, 'groups', 'GID_B', 'entities', 'people');
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });

  writeFileSync(join(p1, '好卡.md'),
    '# 群成员-好卡\n\n## Current\n- 群成员：好卡；openid：ABCDEF0123456789ABCDEF0123456789。\n', 'utf8');
  writeFileSync(join(p1, '缺openid.md'),
    '# 群成员-缺openid\n\n## Current\n- 群成员：缺openid。\n', 'utf8');
  writeFileSync(join(p2, '全缺.md'), '# 全缺\n- 主人评价：xxx\n', 'utf8');

  const r = A.auditMemoryCards(root);
  eq(r.scanned, 3, '扫描到 3 张卡');
  eq(r.issues.length, 2, '检出 2 张问题卡');
  ok(r.issues.some((i) => i.path.endsWith('缺openid.md') && i.missing.includes('openid')),
    '缺openid 被检出且标记 openid');
  ok(r.issues.some((i) => i.path.endsWith('全缺.md') && i.missing.length === 2),
    '全缺卡两项都标记');
  ok(!r.issues.some((i) => i.path.endsWith('好卡.md')), '好卡不误报');
  ok(r.issues.every((i) => typeof i.groupId === 'string' && i.groupId.length > 0),
    '每条问题都带 groupId');
}

// ══ T3 降级与健壮性 ═══════════════════════════════════════════════════
console.log('\nT3 健壮性（绝不抛）');
{
  let threw = false;
  try {
    const r = A.auditMemoryCards(join(TMP, '不存在的目录'));
    eq(r.scanned, 0, '目录不存在 → scanned=0');
    eq(r.issues.length, 0, '目录不存在 → issues 空');
  } catch { threw = true; }
  eq(threw, false, '目录不存在不抛');

  // 没有 people 目录的群（只有 groups/xxx 空壳）
  const root2 = join(TMP, 'gm2');
  mkdirSync(join(root2, 'groups', 'EMPTY_GID'), { recursive: true });
  threw = false;
  try {
    const r = A.auditMemoryCards(root2);
    eq(r.issues.length, 0, '群无 people 目录 → 不算问题');
  } catch { threw = true; }
  eq(threw, false, '群无 people 目录不抛');

  // 隐藏目录要跳过
  const root3 = join(TMP, 'gm3');
  mkdirSync(join(root3, 'groups', '.hidden', 'entities', 'people'), { recursive: true });
  writeFileSync(join(root3, 'groups', '.hidden', 'entities', 'people', 'bad.md'), '# bad\n', 'utf8');
  const r3 = A.auditMemoryCards(root3);
  ok(!r3.issues.some((i) => i.groupId === '.hidden'), '隐藏目录被跳过');
}

// ══ T4 生产数据零污染 ═══════════════════════════════════════════════════
console.log('\nT4 生产数据零污染');
{
  let nowMtime = null;
  try { nowMtime = statSync(PROD).mtimeMs; } catch { nowMtime = null; }
  eq(nowMtime, prodMtime, '生产记忆库 mtime 未变（体检是只读的）');
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / 失败 ${fail}`);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
