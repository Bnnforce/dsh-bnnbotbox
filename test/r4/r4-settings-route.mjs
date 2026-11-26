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
  FIELDS, ROUTE_PATH, TOKEN_GLOBAL, HANDSHAKE_PATH,
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
// ★ 2026-11-25：autoCardEnabled 是 memory 侧字段，现在按来源写进 config.memory
//   （见 settings-route 的 source 分流）。旧断言只看顶层，已随实现更新。
ok(res.status === 200 && saved && saved.memory && saved.memory.autoCardEnabled === false,
  'POST → 调用 save（memory 字段写入 config.memory）');
ok(saved.enabled === true && saved.memorySubdir === 'm', 'POST 保留未改动字段（浅合并语义正确）');

console.log('=== 安装（假 ctx，验证 inject 路径）');
let injectedDeps = null;
let mountCb = null;
const routes = [];
let indexInject = null;
const fakeWebCtx = {
  get: () => undefined,
  webServer: {
    register: (r) => { routes.push(r); return () => {}; },
  },
  effect: (fn) => { const d = fn(); return () => d?.(); },
};
const fakeCtx = {
  fiber: { entry: {} },
  // ★ 2026-11-26：注入监听现在挂**外层 ctx**（官方写法），所以这里要能接 on。
  on: (ev, cb) => { if (ev === 'webserver/index-inject') indexInject = cb; return () => {}; },
  inject: (deps, cb) => { injectedDeps = deps; mountCb = cb; cb(fakeWebCtx); },
};
installSettingsRoute(fakeCtx, () => ({ enabled: true }), { info: () => {}, warn: () => {} });
ok(JSON.stringify(injectedDeps) === JSON.stringify(['webServer']), "走 ctx.inject(['webServer']) —— 不是 ctx.get");

// 两条路由：配置 + 同源握手
const cfgRoute = routes.find((r) => r.path === ROUTE_PATH);
const hsRoute = routes.find((r) => r.path === HANDSHAKE_PATH);
ok(routes.length === 2, '注册两条路由（实际 ' + routes.length + '）');
ok(cfgRoute && cfgRoute.kind === 'exact', '配置路由 kind=exact');
ok(cfgRoute && cfgRoute.path === ROUTE_PATH, '配置路由路径 = ' + ROUTE_PATH);
ok(hsRoute && hsRoute.kind === 'exact', '握手路由已注册（' + HANDSHAKE_PATH + '）');

ok(typeof indexInject === 'function', '注入监听挂在外层 ctx');
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
// ── 同源握手（2026-11-26 新增）─────────────────────────────────────────
console.log('=== 同源握手（注入失效时的兜底）');
{
  // 背景：真机上设置页曾报「读不到配置：缺少有效令牌」——
  //   HTML 注入的 window.__DSH_BNNBOTBOX_TOKEN__ 在某些宿主上拿不到。
  //   兜底方案：页面用同源标记换口令。
  const M2 = await import('../../lib/settings-route.js');

  ok(typeof M2.isSameOriginPage === 'function', '导出 isSameOriginPage');
  ok(typeof M2.createHandshakeHandler === 'function', '导出 createHandshakeHandler');
  ok(M2.HANDSHAKE_PATH === '/bnnbotbox/handshake', '握手路径正确');

  // 判定：谁能换口令
  ok(M2.isSameOriginPage({ headers: { 'sec-fetch-site': 'same-origin' } }) === true,
    '同源页面可以换');
  ok(M2.isSameOriginPage({ headers: { 'sec-fetch-site': 'none' } }) === true,
    '地址栏直开可以换');
  ok(M2.isSameOriginPage({ headers: { 'sec-fetch-site': 'cross-site' } }) === false,
    '跨站页面被拒');
  ok(M2.isSameOriginPage({ headers: { referer: 'http://127.0.0.1:4145/s' } }) === true,
    'Referer 本机可以换');
  ok(M2.isSameOriginPage({ headers: { referer: 'http://evil.example/x' } }) === false,
    'Referer 外网被拒');
  ok(M2.isSameOriginPage({ headers: {} }) === false,
    '裸 curl（无浏览器标记）被拒');

  // 端点行为
  const hs = M2.createHandshakeHandler({ token: 'tk-abc' });
  // 直接构造最小 req（mkReq 会覆盖 headers，这里要精确控制浏览器的头）
  const reqOf = (headers, remote = '127.0.0.1') => {
    const r = Readable.from([]);
    r.method = 'GET';
    r.socket = { remoteAddress: remote };
    r.headers = headers;
    return r;
  };
  const r1 = mkRes();
  await hs(reqOf({ 'sec-fetch-site': 'same-origin' }), r1);
  ok(r1.status === 200 && json(r1).token === 'tk-abc', '同源请求拿到口令');
  const r2 = mkRes();
  await hs(reqOf({}), r2);
  ok(r2.status === 403, '非浏览器请求拿不到口令');
  const r3 = mkRes();
  await hs(reqOf({ 'sec-fetch-site': 'same-origin' }, '10.0.0.9'), r3);
  ok(r3.status === 403, '非本机即便同源标记也拒');
}

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
