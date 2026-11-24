/**
 * 设置页端点的回归测试（宿主侧）。
 *
 * 为什么要有：这是唯一能把浏览器里改的东西写回宿主配置的通道，
 * 又带着鉴权与字段白名单 —— 它坏掉的表现是「点保存没反应」或
 * 「群友也能改配置」，两种都不会自己报错。
 */
import { installSettingsRoute, sanitizePatch, pickFields, isLoopback, FIELDS } from '../../lib/settings-route.js';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  ✅', m)) : (fail++, console.log('  ❌', m));

console.log('=== 纯函数');
ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'), '回环地址识别');
ok(!isLoopback('192.168.1.5') && !isLoopback('10.0.0.1'), '非回环拒绝');
ok(sanitizePatch({ enabled: false }).ok, '布尔合法');
ok(!sanitizePatch({ enabled: 'yes' }).ok, '布尔类型错误被拒');
ok(!sanitizePatch({ aaa: 1 }).ok, '未知字段被拒（不静默丢弃）');
ok(sanitizePatch({ memorySubdir: '  x/y  ' }).patch.memorySubdir === 'x/y', '字符串 trim');
const picked = pickFields({ enabled: true, autoCardEnabled: false, weird: 1 });
ok(!('weird' in picked), '只返回白名单字段');
ok(Object.keys(picked).length === FIELDS.length, '字段数一致：' + Object.keys(picked).length);

console.log('=== 端点（假 ctx）');
let savedPatch = null;
let routeHandler = null, tokenInject = null;
const fakeCtx = {
  get: (name) => (name === 'configEditor' ? { edit: async (entry, fn) => { savedPatch = fn({ enabled: true }); } } : undefined),
  fiber: { entry: {} },
  webServer: {
    register: (r) => { routeHandler = r.handler; return () => {}; },
    tapIndex: (fn) => { tokenInject = fn; return () => {}; },
  },
};
const dispose = installSettingsRoute(fakeCtx, () => ({ enabled: true, autoCardEnabled: null }));
ok(typeof routeHandler === 'function', '路由已注册');
ok(typeof tokenInject === 'function', 'index 注入已注册');
ok(dispose instanceof Function, '返回 disposer');

// 从注入的 HTML 里抠出 token
const html = tokenInject('<!doctype html><html><head><title>x</title></head><body></body></html>');
const m = /__DSH_BNNBOTBOX_TOKEN__=(".*?")/.exec(html);
const TOKEN = m ? JSON.parse(m[1]) : '';
ok(!!TOKEN, 'token 已注入 index（' + TOKEN.slice(0, 8) + '…）');

function mkReq({ method = 'GET', remote = '127.0.0.1', token = TOKEN, body = '' }) {
  const { Readable } = require('node:stream');
}
// 用流模拟
import { Readable } from 'node:stream';
function mkReq2(method, remote, tok, body) {
  const r = Readable.from(body ? [Buffer.from(body)] : []);
  r.method = method;
  r.socket = { remoteAddress: remote };
  r.headers = tok === null ? {} : { 'x-bnn-token': tok };
  return r;
}
function mkRes() {
  const out = { status: 0, body: '', headers: {} };
  out.writeHead = (s, hd) => { out.status = s; out.headers = hd || {}; };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.end = (t) => { out.body = t || ''; };
  return out;
}

// ① 无令牌
let res = mkRes();
await routeHandler(mkReq2('GET', '127.0.0.1', null, ''), res);
ok(res.status === 403, '无令牌 → 403');

// ② 非本机
res = mkRes();
await routeHandler(mkReq2('GET', '192.168.1.5', TOKEN, ''), res);
ok(res.status === 403, '非本机 → 403');

// ③ GET 正常
res = mkRes();
await routeHandler(mkReq2('GET', '127.0.0.1', TOKEN, ''), res);
ok(res.status === 200 && JSON.parse(res.body).ok, 'GET → 200');
ok(JSON.parse(res.body).values.enabled === true, 'GET 返回当前值');
ok(Array.isArray(JSON.parse(res.body).fields), 'GET 返回字段元信息');

// ④ POST 非法字段
res = mkRes();
await routeHandler(mkReq2('POST', '127.0.0.1', TOKEN, JSON.stringify({ patch: { nope: 1 } })), res);
ok(res.status === 400, 'POST 未知字段 → 400');

// ⑤ POST 正常
res = mkRes();
await routeHandler(mkReq2('POST', '127.0.0.1', TOKEN, JSON.stringify({ patch: { autoCardEnabled: false } })), res);
ok(res.status === 200 && savedPatch && savedPatch.autoCardEnabled === false, 'POST → 走 configEditor.edit');
ok(savedPatch.enabled === true, 'POST 保留未改动的原值（浅合并语义正确）');

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
