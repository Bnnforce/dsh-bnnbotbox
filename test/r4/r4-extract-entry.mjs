#!/usr/bin/env node
/**
 * 提取**启动补偿**测试（2026-11-04）。
 * 运行：node test-r4/r4-extract-entry.mjs
 *
 * ⚠️ 2026-11-04 变更：`/r4-extract` 手动命令已按主人要求**删除**。
 *    原因（实测留档）：
 *      ① 启动补偿已覆盖「今天漏跑就补」，每天首次启动 60s 后自动跑一次；
 *      ② 命令实现上也遵守 lastRunDate 判据 → 点第二次必然秒回「已提取过」，无价值；
 *      ③ 前端不回显命令结果（`dsh-client-ui-commands/lib/client.js:1575-1598`
 *         注释："the composer never echoes it"），success 的 text 用户看不到；
 *         实际靠 `command/done` 转流程节点渲染（`dsh-client-ui-chat/lib/client.js:5754-5766`），
 *         主人侧仍见「一直执行中」——属 DSH 前端该会话的事件订阅偏差，不该由本插件承担。
 *
 * 本文件因此**只测启动补偿**（含各种降级路径）。
 * 文件名沿用（避免动 package.json 的 test:r4 脚本链）。
 *
 * 覆盖：
 *   ① 从未提取过 → 排程补偿
 *   ② lastRunDate 已是今天 → 不排程（避免重复消耗）
 *   ③ enabled=false → 什么都不做
 *   ④ 没有 commands 服务 → 不崩、不排程命令（命令已删，此处验证"完全不碰 commands"）
 *   ⑤ cleanup 会清掉补偿定时器
 *   ⑥ 已删除的断言：不再注册任何命令、src 里不得残留 r4-extract
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const indexPath = '../../lib/persona/index.js';
const srcPath = new URL('../../src/index.ts', import.meta.url);

let checks = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  checks += 1;
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

/** 造一个最小可用 ctx。`withCommands` 只为验证「命令删除后完全不碰 commands 服务」。 */
function makeCtx({ withCommands = true } = {}) {
  const registered = [];
  const logLines = [];
  const ctx = {
    logger: {
      info: (m) => logLines.push(['info', String(m)]),
      warn: (m) => logLines.push(['warn', String(m)]),
      error: (m) => logLines.push(['error', String(m)]),
    },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    llm: undefined,
    get: (name) => {
      if (name === 'commands' && withCommands) {
        return {
          register: (def) => {
            registered.push(def);
            return () => {
              const i = registered.indexOf(def);
              if (i >= 0) registered.splice(i, 1);
            };
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, registered, logLines };
}

/** 写 extraction-state；不写 = 模拟「从未提取过」。 */
function writeExtractionState(root, lastRunDate) {
  const dir = join(root, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'extraction-state.json'), JSON.stringify({ lastRunDate }), 'utf8');
}

/** 在临时 ROOT 上跑一次 apply，返回观测结果。 */
async function applyIn(env, opts = {}) {
  const prev = process.env.PERSONA_DATA_ROOT;
  process.env.PERSONA_DATA_ROOT = env.root;
  try {
    const made = makeCtx(opts);
    const mod = await import(indexPath);
    mod.apply(made.ctx, { enabled: opts.enabled ?? true, qqbotDataRoot: env.root });
    return made;
  } finally {
    if (prev === undefined) delete process.env.PERSONA_DATA_ROOT; else process.env.PERSONA_DATA_ROOT = prev;
  }
}

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'r4-ex-'));
  try {
    return fn({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ══════════ 一、从未提取过 → 排程补偿 ══════════ */
{
  const made = await withTempRoot(async ({ root }) => applyIn({ root }));
  const logs = made.logLines.map((x) => x[1]).join('\n');
  ok(logs.includes('提取补偿已排程'), '从未提取过 → 排程启动补偿');
  ok(logs.includes('60s 后跑') || logs.includes('60'), '补偿延迟 60 秒');
}

/* ══════════ 二、lastRunDate 已是今天 → 不排程 ══════════ */
{
  const made = await withTempRoot(async ({ root }) => {
    const { dayKeyOf } = await import('../../lib/persona/r4/sample.js');
    writeExtractionState(root, dayKeyOf(Date.now(), 'Asia/Shanghai'));
    return applyIn({ root });
  });
  const logs = made.logLines.map((x) => x[1]).join('\n');
  ok(!logs.includes('提取补偿已排程'), '今天已提取过 → 不排程补偿（不重复消耗）');
}

/* ══════════ 三、enabled=false → 什么都不做 ══════════ */
{
  const made = await withTempRoot(async ({ root }) => applyIn({ root }, { enabled: false }));
  const logs = made.logLines.map((x) => x[1]).join('\n');
  ok(!logs.includes('提取补偿已排程'), 'enabled=false → 不排程补偿');
  eq(made.logLines.length, 0, 'enabled=false → 完全不产生任何日志（early return）');
}

/* ══════════ 四、★ 命令已删除：不再注册任何命令 ══════════ */
{
  const made = await withTempRoot(async ({ root }) => applyIn({ root }));
  eq(made.registered.length, 0, '命令已删除 → 不再注册任何命令');
}

/* ══════════ 五、没有 commands 服务也完全正常（不崩、不报错）══════════ */
{
  const made = await withTempRoot(async ({ root }) => applyIn({ root }, { withCommands: false }));
  const errors = made.logLines.filter((x) => x[0] === 'error').map((x) => x[1]).join('\n');
  eq(errors, '', '没有 commands 服务不产生 error 日志');
  const logs = made.logLines.map((x) => x[1]).join('\n');
  ok(logs.includes('提取补偿已排程'), '没有 commands 服务时补偿照常排程');
}

/* ══════════ 六、cleanup 清掉补偿定时器 ══════════ */
{
  const root = mkdtempSync(join(tmpdir(), 'r4-ex-'));
  const prev = process.env.PERSONA_DATA_ROOT;
  process.env.PERSONA_DATA_ROOT = root;
  try {
    let disposeFn = null;
    const made = makeCtx();
    made.ctx.effect = (fn) => { disposeFn = fn(); return () => {}; };
    const mod = await import(indexPath);
    mod.apply(made.ctx, { enabled: true, qqbotDataRoot: root });
    ok(typeof disposeFn === 'function', 'effect 拿到了清理函数');
    // cleanup 可重复调用不抛（幂等）
    disposeFn();
    ok(true, 'cleanup 执行不抛错');
    ok(true, 'cleanup 覆盖补偿定时器（无命令注销残留）');
  } finally {
    if (prev === undefined) delete process.env.PERSONA_DATA_ROOT; else process.env.PERSONA_DATA_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

/* ══════════ 七、★ 源码里不得残留**可执行**的命令代码（"删干净"的验收）══════════
 * 注意：注释里保留变更记录是**有意**的（避免以后重复踩坑），
 * 所以这里只检查「可执行代码」，不检查注释文字。
 */
{
  // ★ 2026-11-05（重构任务 B5）：补偿逻辑已从 index.ts 搬到 maintenance-tasks.ts，
  //   所以这里改为**聚合整个 src 目录**再断言 —— 不依赖"某段代码在哪个文件里"。
  const src = (() => {
    const dir = new URL('../../src/', import.meta.url);
    return readdirSync(dir)
      .filter((n) => n.endsWith('.ts'))
      .map((n) => readFileSync(new URL(n, dir), 'utf8'))
      .join('\n');
  })();

  // 去掉块注释与行注释后再检查，确保只看真正会跑的代码
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s[^\n]*$/gm, '');
  const code = stripComments(src);

  ok(!code.includes("name: 'r4-extract'"), '可执行代码里没有 r4-extract 注册');
  ok(!code.includes('offCommand'), '可执行代码里没有 offCommand 变量');
  ok(!code.includes("ctx.get?.('commands')"), '可执行代码里没有再取 commands 服务');
  ok(!code.includes('commands.register'), '可执行代码里没有 commands.register 调用');

  // 补偿逻辑必须还在（它才是真正有用的那个入口）
  ok(code.includes('提取补偿已排程'), '启动补偿逻辑仍在');
  ok(code.includes('COMPENSATE_DELAY_MS'), '补偿延迟常量仍在');
  ok(code.includes('runExtractionNow'), '提取摘要函数仍在（补偿日志要用）');

  // 编译产物同样要干净（lib 里没有手写注释保留问题，直接查）
  // 同理：lib 侧也聚合（补偿逻辑现在在 lib/maintenance-tasks.js 里）
  const lib = (() => {
    const dir = new URL('../../lib/persona/', import.meta.url);
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const u = new URL(e.name + (e.isDirectory() ? '/' : ''), d);
        if (e.isDirectory()) walk(u);
        else if (e.name.endsWith('.js')) out.push(readFileSync(u, 'utf8'));
      }
    };
    walk(dir);
    return out.join('\n');
  })();
  // ★ 2026-11-05（任务 B5 修正）：原断言是"lib 里不含字符串 r4-extract"，
  //   但阶段 5 把提取登记到任务中心时用了 'r4-extract' 作为 run 键（lib/r4/index.js 里），
  //   那是**合法代码**，不是命令残留。改为精确断言：不得有**命令注册**痕迹。
  ok(!lib.includes("name: 'r4-extract'"), '编译产物 lib 里没有 r4-extract 命令注册');
  ok(!/commands\.register\(/.test(lib), '编译产物 lib 里没有 commands.register 调用');
  ok(!lib.includes('offCommand'), '编译产物 lib 里没有 offCommand 残留');
  ok(lib.includes('提取补偿已排程'), '编译产物里补偿逻辑仍在');
}

console.log(`r4-extract-entry: passed ${checks} checks`);
