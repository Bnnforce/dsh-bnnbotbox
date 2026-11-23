/**
 * 记忆作用域 —— 统一架构里「谁的数据」的唯一表达
 *
 * 一个 scope = 一个记忆命名空间。按 QQ 语义只有两种：
 *   · group：群聊，id = 群 openid
 *   · c2c  ：私聊，id = 用户 openid
 *
 * 🔴 红线：**scope 只能由 persona 服务解析**（sessionId → groupId），
 *    本模块绝不能自己去读 session-groups.json。
 */
/** scope 的规范字符串形式，用于日志/诊断/缓存键。 */
export function scopeKey(scope) {
    if (!scope || !scope.type || !scope.id)
        return '';
    return `${scope.type}:${scope.id}`;
}
/**
 * 校验 scope 值是否安全。
 *
 * QQ openid 是十六进制大写串（群）或类似格式（用户），但我们不假设格式，
 * 只做**路径安全**校验：拒绝空、拒绝含路径分隔符/控制符/点段。
 */
export function isValidScopeId(id) {
    const s = String(id ?? '');
    if (!s || s.length > 128)
        return false;
    if (s === '.' || s === '..')
        return false;
    // 只允许「字母（含非 ASCII）/ 数字 / 下划线 / 连字符」。
    // QQ openid 实际是 [A-Za-z0-9_-]，这里放宽到 unicode 字母是为了测试与未来兼容；
    // 路径安全由「点、斜杠、空格、控制字符一律不在字符集内」保证。
    return /^[\p{L}\p{N}_-]+$/u.test(s);
}
/** 构造并校验一个 scope；不合法返回 null。 */
export function makeScope(type, id) {
    if (type !== 'group' && type !== 'c2c')
        return null;
    const s = String(id ?? '').trim();
    if (!isValidScopeId(s))
        return null;
    return { type, id: s };
}
/** 严格相等（用于断言与去重）。 */
export function scopeEquals(a, b) {
    if (!a || !b)
        return false;
    return a.type === b.type && a.id === b.id;
}
//# sourceMappingURL=scope.js.map