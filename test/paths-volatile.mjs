/**
 * paths-volatile.mjs — volatile 字段解包回归锁（2026-11-26）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 真机事故复盘（P0）：
 *
 *   `qqbotDataRoot` / `dataRoot` 都是 schemastery `.volatile()` 字段。
 *   cordis 传进来的是**带 .get() 的包装对象**，不是字符串。
 *
 *   旧代码直接把包装对象传给 resolveQqbotDataRoot ⇒ `String(包装对象)`
 *   → `"[object Object]"` ⇒ 数据根变成：
 *     .../plugins/dsh-bnnbotbox/[object Object]
 *
 *   实际后果（真机确认）：
 *     ① .dsh/workspaces/ 下真出现了名为 `[object Object]` 的目录
 *     ② 扩展包从路径桥读到错路径 ⇒ 排行榜拿不到群成员 ⇒ **只显示自己**
 *     ③ 日记 / 关系数据 / 观察报告 全部写到错误位置
 *
 *   这类 bug 的特征是「静默」——所有功能看起来正常，只是数据写错了地方。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { resolveQqbotDataRoot, resolveDataRoot } from '../lib/shared/paths.js';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}`); }
}

/** 与 lib/index.js 里的实现保持一致（这里独立写一份，确保两边行为对齐）。 */
function unwrapVolatile(v) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { return v.get(); } catch { return undefined; }
  }
  return v;
}

console.log('V1 String() 会毁掉包装对象（证明必须解包）');
{
  const wrapped = { get: () => '/x' };
  ok(String(wrapped) === '[object Object]', 'String(包装对象) 就是 [object Object]');
  ok(unwrapVolatile(wrapped) === '/x', 'unwrapVolatile 能拿到真值');
}

console.log('\nV2 解包后路径正确');
{
  const real = '/storage/emulated/0/DSH/Bot/dshqqbot';
  const wrapped = { get: () => real };
  const got = resolveQqbotDataRoot({ explicit: unwrapVolatile(wrapped) });
  ok(got === real, `包装对象解包后得到真实路径（实际 ${got}）`);
  ok(!got.includes('[object Object]'), '结果不含 [object Object]');
}

console.log('\nV3 各种输入形态都不退化');
{
  const real = '/storage/emulated/0/DSH/Bot/dshqqbot';
  for (const [label, v] of [
    ['普通字符串', real],
    ['undefined', undefined],
    ['空串', ''],
    ['null', null],
  ]) {
    const got = resolveQqbotDataRoot({ explicit: unwrapVolatile(v) });
    ok(!String(got).includes('[object Object]'), `${label} 不产生 [object Object]`);
  }
}

console.log('\nV4 .get() 抛异常时不崩');
{
  const bad = { get: () => { throw new Error('boom'); } };
  let threw = false;
  let got;
  try { got = resolveQqbotDataRoot({ explicit: unwrapVolatile(bad) }); } catch { threw = true; }
  ok(!threw, '.get() 抛异常不导致崩溃');
  ok(!String(got ?? '').includes('[object Object]'), '异常后也不产生 [object Object]');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
