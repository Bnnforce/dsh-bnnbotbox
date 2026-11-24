/**
 * 设置页端点的回归测试（宿主侧）。
 *
 * 为什么要有：这是唯一能把浏览器里改的东西写回宿主配置的通道，又带着鉴权与
 * 字段白名单 —— 它坏掉的表现是「点保存没反应」（页面 404/403）或
 * 「群友也能改配置」，两种都不会自己报错。
 *
 * 2026-11-24 实测教训（已固化进本测试）：
 *   · 用 ctx.get('webServer') 拿服务 → Cordis 代理直接抛，端点 404；
 *     必须 ctx.inject(['webServer'], cb)。
 *   · 口令若每次 apply 重新生成，保存一次（插件重启）后旧口令失效 → 第二次 403。
 *     所以口令存 globalThis，且本测试专门断言它跨调用稳定。
 */
import { Readable } from 'node:stream';
import {
  FIELDS, ROUTE_PATH, TOKEN_GLOBAL,
  createHandler, installSettingsRoute, isLoopback, pickFields,
  sanitizePatch, settingsToken,
} from '../../lib/settings-route.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => (cond ? (pass += 1, console.log('  ✅', msg)) : (fail += 1, console.log('  ❌', msg)));

function mkReq({ method = 'GET', remote = '127.0.0.1', token = settingsToken(), body = '' }) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = method;
  r.socket = { remoteAddress: remote };
  r.headers = token === null ? {} : { 'x-bnn-token': token };
  return r;
}
function mkRes() {
  const out = { status: 0, body: '', headers: {} };
  out.writeHead = (s, hd) => { out.status = s; out.headers = hd || {}; };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.end = (t) => { out.body = t || ''; };
  return out;
}
const json = (res) => { try { return JSON.parse(res.body); } catch { return null; } };

console.log('=== 纯函数');
ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'), '回环地址识别');
ok(!isLoopback('192.168.1.5') && !isLoopback('10.0.0.1'), '非回环拒绝');
ok(sanitizePatch({ enabled: false }).ok, '布尔合法');
ok(!sanitizePatch({ enabled: 'yes' }).ok, '布尔类型错误被拒');
ok(!sanitizePatch({ aaa: 1 }).ok, '未知字段被拒（不静默丢弃）');
ok(sanitizePatch({ memorySubdir: '  x/y  ' }).patch.memorySubdir === 'x/y', '字符串 trim');
ok(!sanitizePatch(null).ok && !sanitizePatch([]).ok, '非对象被拒');
const picked = pickFields({ enabled: true, autoCardEnabled: false, weird: 1 });
ok(!('weird' in picked), '只返回白名单字段');
ok(Object.keys(picked).length === FIELDS.length, '字段数一致：' + Object.keys(picked).length);

console.log('=== 口令');
const t1 = settingsToken();
const t2 = settingsToken();
ok(t1 === t2 && t1.length > 10, '口令跨调用稳定（模拟插件重启后仍可用）');

console.log('=== handler');
let saved = null;
const handler = createHandler({
  readResolved: () => ({ enabled: true, autoCardEnabled: null, memorySubdir: 'm' }),
  save: async (fn) => { saved = fn({ enabled: true, autoCardEnabled: null, memorySubdir: 'm' }); },
  token: t1,
});

let res = mkRes();
await handler(mkReq({ token: null }), res);
ok(res.status === 403, '无令牌 → 403');

res = mkRes();
await handler(mkReq({ remote: '192.168.1.5' }), res);
ok(res.status === 403, '非本机 → 403');

res = mkRes();
await handler(mkReq({}), res);
ok(res.status === 200 && json(res).ok === true, 'GET → 200');
ok(json(res).values.enabled === true && json(res).values.memorySubdir === 'm', 'GET 返回当前值');
ok(Array.isArray(json(res).fields) && json(res).fields.length === FIELDS.length, 'GET 返回字段元信息');

res = mkRes();
await handler(mkReq({ method: 'PUT' }), res);
ok(res.status === 405, 'PUT → 405');

res = mkRes();
await handler(mkReq({ method: 'POST', body: 'not json' }), res);
ok(res.status === 400, '坏 JSON → 400');

res = mkRes();
await handler(mkReq({ method: 'POST', body: JSON.stringify({ patch: { nope: 1 } }) }), res);
ok(res.status === 400, '未知字段 → 400');

res = mkRes();
await handler(mkReq({ method: 'POST', body: JSON.stringify({ patch: {} }) }), res);
ok(res.status === 400, '空补丁 → 400');

res = mkRes();
await handler(mkReq({ method: 'POST', body: JSON.stringify({ patch: { autoCardEnabled: false } }) }), res);
ok(res.status === 200 && saved && saved.autoCardEnabled === false, 'POST → 调用 save');
ok(saved.enabled === true && saved.memorySubdir === 'm', 'POST 保留未改动字段（浅合并语义正确）');

console.log('=== 安装（假 ctx，验证 inject 路径）');
let injectedDeps = null;
let mountCb = null;
let registered = null;
let indexInject = null;
const fakeWebCtx = {
  get: () => undefined,
  webServer: {
    register: (r) => { registered = r; return () => {}; },
  },
  on: (ev, cb) => { if (ev === 'webserver/index-inject') indexInject = cb; return () => {}; },
  effect: (fn) => { const d = fn(); return () => d?.(); },
};
const fakeCtx = {
  fiber: { entry: {} },
  inject: (deps, cb) => { injectedDeps = deps; mountCb = cb; cb(fakeWebCtx); },
};
installSettingsRoute(fakeCtx, () => ({ enabled: true }), { info: () => {}, warn: () => {} });
ok(JSON.stringify(injectedDeps) === JSON.stringify(['webServer']), "走 ctx.inject(['webServer']) —— 不是 ctx.get");
ok(registered && registered.kind === 'exact', '路由 kind=exact');
ok(registered && registered.path === ROUTE_PATH, '路由路径 = ' + ROUTE_PATH);
const table = [];
indexInject(table);
ok(table.some((r) => r.kind === 'global' && r.name === TOKEN_GLOBAL && r.value === t1), '口令以 global 注入页面（' + TOKEN_GLOBAL + '）');


console.log('=== 保存回执（重启竞速）');
// 保存会重启插件 ⇒ 响应可能与拆插件赛跑。慢保存要回 202，不能让人干等。
const slowHandler = createHandler({
  readResolved: () => ({ enabled: true }),
  save: () => new Promise(() => {}),           // 永不 resolve，模拟被重启打断
  token: t1,
});
let sres = mkRes();
const t0 = Date.now();
await slowHandler(mkReq({ method: 'POST', body: JSON.stringify({ patch: { enabled: false } }) }), sres);
const waited = Date.now() - t0;
ok(sres.status === 202, '慢保存 → 202（已提交，重启中）');
ok(json(sres).pending === true, '202 带 pending 标记（客户端据此换提示）');
ok(waited < 8000, '不会无限等（实测 ' + waited + 'ms）');

const failHandler = createHandler({
  readResolved: () => ({ enabled: true }),
  save: async () => { throw new Error('被上层覆盖'); },
  token: t1,
});
sres = mkRes();
await failHandler(mkReq({ method: 'POST', body: JSON.stringify({ patch: { enabled: false } }) }), sres);
ok(sres.status === 500 && /被上层覆盖/.test(json(sres).error), '保存被拒 → 500 且如实回报错误');
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
