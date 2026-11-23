#!/usr/bin/env node
/**
 * fresh-env.mjs — 全新环境冒烟测试（**空机器人**）
 *
 * 回答一个具体问题：**别人拿到这个包，机器上什么都没有，能跑起来吗？**
 *
 * 模拟的最坏情况：
 *   · 没有人格卡（`人格/角色卡/` 不存在）
 *   · 没有人格配置（`persona-config.json` / `elysia.json` 不存在）
 *   · 没有 QQBot 数据根（`.qqbot/` 不存在）
 *   · 没有字典（敏感词 / 同义词 / 梗库）
 *
 * 期望行为（本测试断言的就是这个）：
 *   ✅ `apply()` 不抛异常 —— 插件能加载
 *   ✅ persona / memory 两个子模块都能启动
 *   ✅ 缺什么打 warn，并**降级**而不是崩
 *   ✅ 后台心跳因模型 ID 为空而关闭（主聊天不受影响）
 *   ✅ 人格目录为空时**不谎称存在某个人格**（历史 bug：曾硬编码兜底 '比安安'）
 *   ✅ 没人格时 personaCatalog 返回空目录，调用方可显式降级
 *
 * 用法：node test/install/fresh-env.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(HERE));

let pass = 0;
let fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) {
    pass += 1;
    console.log('  ✅ ' + msg);
  } else {
    fail += 1;
    console.log('  ❌ ' + msg + (detail ? ' — ' + detail : ''));
  }
};

console.log('═══ 全新环境冒烟（空机器人）═══\n');

/** 每次用干净的临时根，避免互相污染 */
function makeRoot(tag) {
  return mkdtempSync(join(tmpdir(), `bnn-fresh-${tag}-`));
}

/* ── S1：完全空环境 ─────────────────────────────────────────────── */
console.log('S1 什么都没有');
{
  const TMP = makeRoot('s1');
  // 故意指向**不存在**的目录：插件必须自己受着
  process.env.QQBOT_DATA_ROOT = join(TMP, 'qqbot');
  process.env.PERSONA_DATA_ROOT = join(TMP, 'persona');
  process.env.DSH_HOME = join(TMP, 'dshhome');

  try {
    const main = await import(`file://${PKG_ROOT}/lib/index.js`);

    const cfg = main.resolveConfig({});
    ok(cfg && typeof cfg === 'object', 'Config 空输入可解析');
    ok(Object.keys(cfg).length >= 50, `解析出 ${Object.keys(cfg).length} 个字段（含 memory 侧）`);

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
      provide: (n, v) => services.set(n, v ?? {}),
      effect: () => () => ({}),
      llm: {},
      systemPrompt: {},
      tools: { register: () => {} },
    };

    let err = null;
    try {
      await main.apply(ctx, { enabled: true });
    } catch (e) {
      err = e;
    }
    ok(!err, 'apply 在空环境不抛异常', err && String(err.message).slice(0, 100));

    ok(logs.some(([, m]) => /persona 模块已启动/.test(m)), 'persona 子模块启动');
    ok(logs.some(([, m]) => /memory 模块已启动/.test(m)), 'memory 子模块启动');

    const warns = logs.filter(([l]) => l === 'warn');
    ok(warns.length > 0, `缺料时有 ${warns.length} 条 warn（不是静默失败）`);

    // r4 配置在缺少 elysia.json 时必须回落默认，不能抛
    const r4 = await import(`file://${PKG_ROOT}/lib/persona/r4/config.js`);
    let r4cfg = null;
    let r4err = null;
    try {
      r4cfg = r4.loadConfig();
    } catch (e) {
      r4err = e;
    }
    ok(!r4err, 'r4 loadConfig 无不抛（缺 elysia.json）');
    ok(!!r4cfg && !!r4cfg.config, 'loadConfig 返回 { config, warnings, ... } 结构');
    ok(r4cfg?.config && 'heartbeat_config' in r4cfg.config, 'heartbeat_config 回落到默认值');
    ok(r4cfg?.backgroundEnabled === false, '模型 ID 为空 ⇒ 后台心跳关闭（不空转烧额度）');

    // ⓪ 内置最小人格：apply 之后必须已经铺到工作区，且能被 catalog 读到
    const personaDir = join(dirname(join(TMP, 'qqbot')), '人格');
    const cardPath = join(personaDir, '角色卡', '小忆.md');
    ok(existsSync(cardPath), 'apply 自动铺了内置最小人格（角色卡/小忆.md）');
    ok(existsSync(join(personaDir, 'persona-config.json')), 'apply 自动铺了 persona-config.json');

    const P0 = await import(`file://${PKG_ROOT}/lib/persona/persona.js`);
    const c0 = P0.personaCatalog([join(TMP, 'qqbot')]);
    ok(c0.defaultPersona === '小忆', 'catalog 现在真的能读到「小忆」（不再是空/比安安）', JSON.stringify(c0.defaultPersona));
    ok(c0.names.includes('小忆'), '人格列表含「小忆」');

    // 幂等：再 apply 一次不能覆盖用户改过的内容
    writeFileSync(cardPath, '# 我改过的内容\n', 'utf8');
    try {
      await main.apply(ctx, { enabled: true });
    } catch { /* 第二次 apply 的异常不影响本断言 */ }
    ok(
      readFileSync(cardPath, 'utf8').includes('我改过的内容'),
      '二次启动不覆盖已有角色卡（幂等）',
    );
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

/* ── S2：人格目录为空时的 catalog 行为 ─────────────────────────── */
console.log('\nS2 没有任何人格卡');
{
  const TMP = makeRoot('s2');
  const qqbotRoot = join(TMP, 'qqbot');
  const personaDir = join(TMP, '人格');
  mkdirSync(qqbotRoot, { recursive: true });

  process.env.QQBOT_DATA_ROOT = qqbotRoot;
  process.env.PERSONA_DATA_ROOT = join(TMP, 'persona');
  process.env.DSH_HOME = join(TMP, 'dshhome');

  try {
    const P = await import(`file://${PKG_ROOT}/lib/persona/persona.js`);

    // ① 全空：不许凭空造人格
    const c1 = P.personaCatalog([qqbotRoot]);
    ok(c1.defaultPersona === '', '全空 ⇒ defaultPersona 为空串（不谎称「比安安」）', JSON.stringify(c1.defaultPersona));
    ok(Array.isArray(c1.names) && c1.names.length === 0, '全空 ⇒ 人格列表为空');

    // ② 有角色卡但没配置：取第一张卡当默认
    mkdirSync(join(personaDir, '角色卡'), { recursive: true });
    writeFileSync(join(personaDir, '角色卡', '测试人格.md'), '# 测试人格\n');
    const c2 = P.personaCatalog([qqbotRoot]);
    ok(c2.defaultPersona === '测试人格', '有卡无配置 ⇒ 取第一张卡作默认', JSON.stringify(c2.defaultPersona));
    ok(c2.names.includes('测试人格'), '人格列表含该卡');

    // ③ 有配置：以配置为准
    writeFileSync(
      join(personaDir, 'persona-config.json'),
      JSON.stringify({ defaultPersona: '测试人格' }),
      'utf8',
    );
    const c3 = P.personaCatalog([qqbotRoot]);
    ok(c3.defaultPersona === '测试人格', '有配置 ⇒ 以配置为准');

    // ④ 群人格查询在无状态时不抛
    let gErr = null;
    let gName = null;
    try {
      gName = P.personaForGroup([qqbotRoot], 'FADE0002FADE0002FADE0002FADE0002');
    } catch (e) {
      gErr = e;
    }
    ok(!gErr, 'personaForGroup 无群状态时不抛', gErr && String(gErr.message).slice(0, 80));
    ok(typeof gName === 'string', `personaForGroup 返回字符串（"${gName ?? ''}"）`);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;
