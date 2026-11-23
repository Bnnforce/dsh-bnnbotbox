/**
 * run-all.mjs — dsh-bnnbotbox 测试入口
 *
 * 检查项：
 *   ① 所有模块可导入
 *   ② Config 可解析
 *   ③ apply 可运行（mock ctx）
 *   ④ 两个子模块都被启动
 *   ⑤ 路径推导正确
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

const TMP = mkdtempSync(join(tmpdir(), 'bnnbotbox-test-'));
process.env.QQBOT_DATA_ROOT = TMP;
process.env.PERSONA_DATA_ROOT = join(TMP, 'persona');

console.log('═══ dsh-bnnbotbox 测试 ═══\n');

try {
  // ① 主入口
  const main = await import(`file://${PKG_ROOT}/lib/index.js`);
  ok(typeof main.apply === 'function', '主入口有 apply');
  ok(typeof main.Config === 'function', '主入口导出 Config');
  ok(Array.isArray(main.inject), `inject = [${main.inject.join(', ')}]`);

  // ② Config 解析
  const cfg = main.resolveConfig({ enabled: true });
  ok(cfg && typeof cfg === 'object', 'Config 可解析');
  ok(cfg.enabled === true, 'enabled 保留');

  // ③ shared 模块
  const paths = await import(`file://${PKG_ROOT}/lib/shared/paths.js`);
  ok(typeof paths.resolveQqbotDataRoot === 'function', 'shared/paths 可导入');
  ok(paths.resolveQqbotDataRoot() === TMP, '数据根走环境变量');

  const atomic = await import(`file://${PKG_ROOT}/lib/shared/atomic.js`);
  ok(typeof atomic.atomicWriteJson === 'function', 'shared/atomic 可导入');

  const testFile = join(TMP, 'atomic-test.json');
  const w = atomic.atomicWriteJson(testFile, { hello: 'world' });
  ok(w === true, '原子写成功（返回布尔 true）');

  // ④ apply 冒烟
  const logs = [];
  const services = new Map();
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      debug: () => {},
      error: () => {},
    },
    on: () => {},
    get: (k) => services.get(k),
    set: (k, v) => services.set(k, v),
    provide: (n) => services.set(n, {}),
    effect: () => () => {},
    llm: {},
    systemPrompt: {},
    tools: { register: () => {} },
  };

  let err = null;
  try {
    await main.apply(ctx, { enabled: true, qqbotDataRoot: TMP });
  } catch (e) { err = e; }
  ok(!err, `apply 不抛异常${err ? '：' + err.message.slice(0, 60) : ''}`);

  ok(logs.some(([, m]) => /persona 模块已启动/.test(m)), 'persona 模块启动');
  ok(logs.some(([, m]) => /memory 模块已启动/.test(m)), 'memory 模块启动');
  ok(logs.some(([, m]) => /启动完成/.test(m)), '主入口记录完成');

} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
