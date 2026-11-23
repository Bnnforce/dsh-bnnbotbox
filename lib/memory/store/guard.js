/**
 * 路径守卫 —— 防穿透的唯一入口（审查标准「防穿透与安全」强制项）
 *
 * 威胁模型（全部必须挡住）：
 *   ① `../../其他群/xxx.md`     —— 相对路径穿越
 *   ② `/etc/passwd`             —— 绝对路径
 *   ③ `entities/../../secret`   —— 中段穿越
 *   ④ 符号链接指向 scope 之外    —— realpath 越界
 *   ⑤ 空字节 / 控制字符 / 超长路径
 *   ⑥ 不在白名单目录下的文件（如 `global/` 的敏感内容）
 *
 * 设计原则：**默认拒绝**。只有同时满足「格式合法 + 落在白名单前缀 + 解析后仍在 scope 根内」才放行。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
/** 记忆文件允许的顶层目录（与现 group_memory 口径一致）。 */
export const ALLOWED_PREFIXES = [
    'entities/',
    'events/',
    'preferences/',
    'experiences/',
    'groups/',
    'mechanisms/',
];
/** 相对路径最大长度（防超长路径攻击）。 */
const MAX_REL_LEN = 200;
/**
 * 校验一个「相对 scope 根」的记忆路径。
 *
 * @param scopeRoot scope 的绝对根目录（已由调用方按 group/c2c 算好）
 * @param relPath   调用方给的相对路径（如 `entities/people/群友A.md`）
 * @param expect    期望目标类型：`file`（默认，读写）或 `dir`（列目录）
 *
 * 🔴 2026-11-06 修：此前**没有 expect 参数**，一律按 `isFile()` 判 →
 *   `list(scope, 'events/birthdays')` 因为是目录而被拒（"目标不是普通文件"），
 *   生日档列表因此永远为空。这是真 bug（实测 `store.list(sc,'events/birthdays')` 报错）。
 */
export function checkRelativePath(scopeRoot, relPath, expect = 'file') {
    const raw = String(relPath ?? '');
    // ① 基础格式
    if (!raw.trim())
        return { ok: false, reason: '空路径' };
    if (raw.length > MAX_REL_LEN)
        return { ok: false, reason: `路径过长（>${MAX_REL_LEN}）` };
    // 空字节 / 控制字符
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(raw))
        return { ok: false, reason: '路径含控制字符' };
    // 反斜杠在 Android 上是普通字符，但统一按分隔符处理更安全
    const normalized = raw.replace(/\\/g, '/');
    // ② 绝对路径：直接拒
    if (normalized.startsWith('/'))
        return { ok: false, reason: '不允许绝对路径' };
    // ③ 点段：`..` 一律拒（不做「规范化后判断」，因为那会放过 `a/../../b`）
    const segments = normalized.split('/');
    if (segments.some((s) => s === '..'))
        return { ok: false, reason: '不允许 .. 路径段' };
    if (segments.some((s) => s === '' && normalized !== '/')) {
        // `a//b` 这种：只报警不拒也行；这里直接拒，减少歧义
        if (normalized.includes('//'))
            return { ok: false, reason: '路径含空段' };
    }
    // ④ 白名单前缀
    const hit = ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
    if (!hit) {
        return { ok: false, reason: `不在白名单目录（只允许 ${ALLOWED_PREFIXES.join(' / ')}）` };
    }
    // ⑤ 解析成绝对路径并复核边界
    const abs = resolve(join(scopeRoot, normalized));
    if (!isInside(scopeRoot, abs)) {
        return { ok: false, reason: '解析后越出 scope 根目录' };
    }
    // ⑥ 目标若已存在：用 realpath 复核（防符号链接逃逸）
    try {
        if (existsSync(abs)) {
            const st = statSync(abs);
            const real = realpathSync(abs);
            if (!isInside(realScopeRoot(scopeRoot), real)) {
                return { ok: false, reason: '符号链接指向 scope 之外' };
            }
            // 按期望类型校验（file=读写；dir=列目录）。⚠️ 目录场景不能要求 isFile()
            if (expect === 'file' && !st.isFile()) {
                return { ok: false, reason: '目标不是普通文件' };
            }
            if (expect === 'dir' && !st.isDirectory()) {
                return { ok: false, reason: '目标不是目录' };
            }
        }
    }
    catch (err) {
        return { ok: false, reason: `路径检查失败: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, abs, rel: normalized };
}
/** 目标是否严格落在根目录之内（不是根本身）。 */
export function isInside(root, target) {
    const r = resolve(root);
    const t = resolve(target);
    return t.startsWith(r + sep) || t === r;
}
/** scope 根的 realpath（根可能还不存在，那就用原值）。 */
function realScopeRoot(root) {
    try {
        return realpathSync(resolve(root));
    }
    catch {
        return resolve(root);
    }
}
/** 校验目录名（用于 list 的 dir 参数）。 */
export function checkDirPath(scopeRoot, relDir) {
    const d = String(relDir ?? '').trim();
    if (!d)
        return { ok: true, abs: resolve(scopeRoot), rel: '' };
    // ⚠️ expect='dir'：目录场景不能套用「必须是普通文件」的校验
    //    （否则 list(scope,'events/birthdays') 会被拒 → 生日档永远列不出来）
    return checkRelativePath(scopeRoot, d.endsWith('/') ? d : `${d}/`, 'dir');
}
/** 白名单前缀快照（供配置覆盖时使用）。 */
export function allowedPrefixes(custom) {
    if (Array.isArray(custom) && custom.length) {
        return custom.map((p) => (p.endsWith('/') ? p : `${p}/`)).filter(Boolean);
    }
    return [...ALLOWED_PREFIXES];
}
//# sourceMappingURL=guard.js.map