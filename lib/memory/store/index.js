/**
 * 记忆存储层 —— 按 scope 隔离的 Markdown 记忆库（唯一 IO 入口）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 数据布局（**复用现有目录，零迁移**）：
 *
 *   {qqbotDataRoot}/.qqbot-extensions/data/group-memory/
 *   ├── groups/<gid>/          ← group scope
 *   ├── private/<openid>/      ← c2c scope
 *   └── global/                ← 全局（只读给群友，主人可写）
 *
 * 每层内部目录（白名单见 guard.ts）：
 *   entities/ events/ preferences/ experiences/ groups/ mechanisms/
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 纪律（《审查标准》强制项）：
 *   · 所有 readFileSync 包 try-catch，坏文件静默降级（绝不阻塞主聊天）
 *   · 所有写走 atomicWriteText（临时文件 + rename）
 *   · 所有路径走 checkRelativePath（防穿透）
 *   · 搜索有条数上限（防爆 context）
 *   · 单文件读取有字节上限（防超大文件拖死）
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkDirPath, checkRelativePath, isInside } from './guard.js';
import { atomicWriteText } from '../../shared/atomic.js';
const DEFAULTS = {
    globalDirName: 'global',
    searchMaxHits: 30,
    searchLineMaxChars: 240,
    readMaxBytes: 256 * 1024,
    writeMaxBytesPerEntry: 64 * 1024,
    writeMaxEntriesPerScope: 500,
    globalPublicFiles: ['entities/bot/identity.md', 'entities/people/<owner>.md'],
};
/** 递归收集目录下的 .md 文件（只读，异常吞掉）。 */
function walkMd(dir, base, depth = 0) {
    if (depth > 6)
        return [];
    const out = [];
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const e of entries) {
        // ⚠️ 跳过内部目录（`.trash` 回收站、`.tmp` 临时文件等），否则 forget 掉的文件
        //    又会从 list/search 里冒出来（2026-11-06 测试 T13 抓到的真 bug）。
        if (e.name.startsWith('.'))
            continue;
        const abs = join(dir, e.name);
        const rel = `${base}/${e.name}`;
        if (e.isDirectory()) {
            out.push(...walkMd(abs, rel, depth + 1));
        }
        else if (e.isFile() && /\.md$/i.test(e.name)) {
            out.push({ abs, rel });
        }
    }
    return out;
}
export class MemoryStore {
    o;
    constructor(options) {
        this.o = {
            memoryRoot: options.memoryRoot,
            globalDirName: options.globalDirName ?? DEFAULTS.globalDirName,
            searchMaxHits: options.searchMaxHits ?? DEFAULTS.searchMaxHits,
            searchLineMaxChars: options.searchLineMaxChars ?? DEFAULTS.searchLineMaxChars,
            readMaxBytes: options.readMaxBytes ?? DEFAULTS.readMaxBytes,
            writeMaxBytesPerEntry: options.writeMaxBytesPerEntry ?? DEFAULTS.writeMaxBytesPerEntry,
            writeMaxEntriesPerScope: options.writeMaxEntriesPerScope ?? DEFAULTS.writeMaxEntriesPerScope,
            globalPublicFiles: options.globalPublicFiles ?? DEFAULTS.globalPublicFiles,
            logger: options.logger,
        };
    }
    // ── scope → 绝对根 ─────────────────────────────────────────────────────
    /**
     * scope 的绝对根目录。
     *
     * 🔴 2026-11-06 修（T11 抓到的真 bug）：此前的实现直接 `scope.type` / `scope.id`，
     *   外部传入伪造 scope（如 `{groupId:'../../etc'}`，没有 `type`/`id`）时
     *   `join(root, 'groups', undefined)` 会抛 `The "path" argument must be of type string`。
     *   现在**先校验**：非法 scope 退回 memoryRoot 下的一个隔离空目录
     *   （`._invalid/<hash>`），保证后续 read/search 拿到「空结果」而不是崩。
     */
    scopeRoot(scope) {
        const type = String(scope?.type ?? '');
        const id = String(scope?.id ?? '');
        if ((type !== 'group' && type !== 'c2c') || !id) {
            // 非法 scope：返回一个永不存在的隔离目录（读不到任何东西，写不出去）
            const tag = safeTag(`${type}|${id}`);
            return join(this.o.memoryRoot, '._invalid', tag);
        }
        if (type === 'group')
            return join(this.o.memoryRoot, 'groups', id);
        return join(this.o.memoryRoot, 'private', id);
    }
    /** global 层根目录。 */
    globalRoot() {
        return join(this.o.memoryRoot, this.o.globalDirName);
    }
    /** 确保 scope 根存在（写之前调）。 */
    ensureScopeRoot(scope) {
        const root = this.scopeRoot(scope);
        try {
            mkdirSync(root, { recursive: true });
        }
        catch { /* ignore */ }
        return root;
    }
    // ── 搜索 ────────────────────────────────────────────────────────────────
    /**
     * 把查询串切成「检索词」。
     *
     * 🔴 2026-11-08 修（真机实测到的 bug，证据见下）：
     *   此前是**整串字面子串匹配** —— `query="群友A 生日"` 会去找包含
     *   「群友A 生日」这五个**连续字符**的行，于是必然 0 条
     *   （真实数据里「群友A」和「生日」从不相邻，它们在同一个文件的不同行）。
     *   后果：模型收到「本群没有匹配的记忆」后，退回旧工具 `group_birthday`，
     *   等于新记忆工具在实际使用中**等于不可用**。
     *
     * 现在：按空白 / 常见分隔符切词，**任一命中即算命中**，按命中词数排序。
     * 不引入分词库的理由：记忆库是本地小文件（~30 个），线性扫 + 切词够用且零依赖。
     */
    queryTerms(query) {
        const raw = String(query ?? '').trim().toLowerCase();
        if (!raw)
            return [];
        // 空白 + 中英文逗号/顿号/斜杠/加号/竖线 都当分隔符
        const terms = raw
            .split(/[\s,，、/／+＋|｜]+/u)
            .map((t) => t.trim())
            .filter((t) => t.length > 0 && t.length <= 40);
        const seen = new Set();
        const out = [];
        for (const t of terms) {
            if (seen.has(t))
                continue;
            seen.add(t);
            out.push(t);
        }
        return out;
    }
    /**
     * 一行文字的命中词数（0 = 不命中）。
     *
     * 返回**词数**而不只是布尔，是为了让「群友A + 生日」两词都中的行
     * 排在只中一个词的行前面 —— 这才是模型要的「最相关」。
     */
    termScore(line, terms) {
        if (!terms.length)
            return 1; // 空查询 = 视为命中（返回全部）
        const t = line.toLowerCase();
        let n = 0;
        for (const term of terms)
            if (t.includes(term))
                n += 1;
        return n;
    }
    /**
     * 路径（文件名）的加分。
     *
     * 为什么需要它（2026-11-08 真机实测）：查「群友A 生日」时，
     * `群友D-群友A忆.md` 和 `群友A.md` 的正文都含「生日」、路径都含「群友A」，
     * 纯词数打分**并列**，于是「名字里含『群友A』字的另一个人」排在正主前面。
     *
     * 解决办法：把 basename 按 `-`/`_`/`.`/空白 切成「名字段」，
     *   · 有某段**精确等于**检索词 → 这个文件就是正主（+4/词）
     *   · 只是**子串包含** → 只是沾边（+1/词）
     * 这样 `群友A.md`（段 = 「群友A」）得 4 分，`群友D-群友A忆.md`（段 = 「群友D」「群友A忆」，
     * 没有一段等于「群友A」）只得到 1 分，正主自然置顶。
     */
    pathBonus(relPath, terms) {
        if (!terms.length)
            return 0;
        const base = String(relPath ?? '').split('/').pop() ?? '';
        const stem = base.replace(/\.md$/iu, '').toLowerCase();
        // 切成名字段（「11-11-群友A」→ ['11','11','群友A']；「群友D-群友A忆」→ ['群友D','群友A忆']）
        const segments = stem.split(/[-_.\s]+/u).filter(Boolean);
        let bonus = 0;
        for (const term of terms) {
            if (segments.includes(term))
                bonus += 4; // 精确等于某段 → 正主
            else if (stem.includes(term))
                bonus += 1; // 仅子串 → 沾边
        }
        return bonus;
    }
    /**
     * 在「本 scope + global 白名单」里搜关键词。
     *
     * 匹配语义：查询按分隔符切词，**任一词命中即算命中**，按命中词数降序排列。
     *
     * @param query 空串 = 返回全部（仍受 maxHits 限制）
     */
    search(scope, query) {
        const q = String(query ?? '').trim().toLowerCase();
        const max = this.o.searchMaxHits;
        // 🔴 2026-11-06 修（P1-5，真机审查发现「search 饥饿」）：
        //   此前本地搜索会**吃满全部 max 配额**（`if (hits.length >= max) break`），
        //   于是 `if (hits.length < max)` 的 global 分支**永远进不去** ——
        //   活跃群（28 个文件）搜个空串就占满 30 条，一条 global 都搜不到。
        //   而且**越活跃的群越搜不到 global**（反直觉）。
        //   修法：本地只吃 80% 配额，恒定给 global 留 20%（至少 1 条）。
        const localBudget = Math.max(1, Math.min(max - 1, Math.ceil(max * 0.8)));
        const terms = this.queryTerms(q);
        // ① 本 scope（受 localBudget 约束，给 global 留余量）
        //
        // ⚠️ 收集阶段**先不截断**：要按命中词数排序后才能取前 localBudget 条，
        //    否则先扫到的文件会占满配额（「按文件遍历顺序」不等于「按相关度」）。
        const scored = [];
        const root = this.scopeRoot(scope);
        let order = 0;
        for (const f of walkMd(root, '')) {
            const text = this.readSafe(f.abs);
            if (text === null)
                continue;
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (!t)
                    continue;
                // ★ 文件名加分见 `pathBonus`：把名字段切开做**精确匹配**，
                //   避免「群友D-群友A忆」（名字里含「群友A」字）盖过正主「群友A.md」。
                //
                // ⚠️ 文件名加分**只是加分，不能单独构成入选理由**：否则「群友A.md」里的
                //   每一行（包括完全无关的行）都会因为路径含「群友A」而被塞进结果，把预算冲爆。
                //   所以先要求 lineScore > 0（这一行真的含检索词），再用加分排序。
                const lineScore = this.termScore(t, terms);
                if (lineScore <= 0)
                    continue;
                const score = lineScore + this.pathBonus(f.rel, terms);
                scored.push({
                    hit: { path: f.rel.replace(/^\//, ''), line: trunc(t, this.o.searchLineMaxChars), fromGlobal: false },
                    score,
                    order: order++,
                });
            }
        }
        scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
        const hits = scored.slice(0, localBudget).map((x) => x.hit);
        // ② global 白名单（只读，且只对群友开放的几个文件）
        if (hits.length < max) {
            const gRoot = this.globalRoot();
            for (const rel of this.o.globalPublicFiles) {
                if (hits.length >= max)
                    break;
                const chk = checkRelativePath(gRoot, rel);
                if (!chk.ok)
                    continue;
                if (!existsSync(chk.abs))
                    continue;
                const text = this.readSafe(chk.abs);
                if (text === null)
                    continue;
                for (const line of text.split('\n')) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    if (this.termScore(t, terms) <= 0)
                        continue;
                    hits.push({ path: `global/${rel}`, line: trunc(t, this.o.searchLineMaxChars), fromGlobal: true });
                    if (hits.length >= max)
                        break;
                }
            }
        }
        return hits;
    }
    // ── 读取 ────────────────────────────────────────────────────────────────
    /** 读一个记忆文件（本 scope 或 global 白名单）。 */
    read(scope, relPath) {
        let rel = String(relPath ?? '').trim();
        // 🔴 2026-11-06 修（P0-2，真机审查抓到）：`search()` 返回的 global 命中 path 形如
        //   `global/entities/bot/identity.md`，但本方法此前不认这个前缀 ——
        //   `checkRelativePath` 的白名单只允许 `entities/ events/ …`，于是 `global/` 必被拒。
        //   后果：**模型照着 search 返回的 path 去 read，100% 失败**（往返断裂）���
        //   修法：先剥 `global/` 前缀并记标记，直接走 global 分支。
        const GLOBAL_PREFIX = 'global/';
        if (rel.startsWith(GLOBAL_PREFIX)) {
            return this.readFromGlobal(rel.slice(GLOBAL_PREFIX.length));
        }
        // 先当本 scope 处理
        const root = this.scopeRoot(scope);
        const chk = checkRelativePath(root, rel);
        if (chk.ok && existsSync(chk.abs)) {
            const text = this.readSafe(chk.abs);
            if (text === null)
                return { ok: false, reason: '读取失败（文件不可读或过大）' };
            return { ok: true, text, path: chk.rel };
        }
        // 再当 global 白名单处理
        const gRoot = this.globalRoot();
        const gChk = checkRelativePath(gRoot, rel);
        if (gChk.ok && existsSync(gChk.abs)) {
            const relFromGlobal = gChk.rel;
            if (!this.o.globalPublicFiles.includes(relFromGlobal)) {
                return { ok: false, reason: '该 global 文件不对群友开放' };
            }
            const text = this.readSafe(gChk.abs);
            if (text === null)
                return { ok: false, reason: '读取失败（文件不可读或过大）' };
            return { ok: true, text, path: `${GLOBAL_PREFIX}${relFromGlobal}` };
        }
        // 给明确原因（而不是笼统的「不存在」）
        if (!chk.ok && !gChk.ok)
            return { ok: false, reason: chk.reason };
        return { ok: false, reason: '记忆文件不存在' };
    }
    // ── 列出 ────────────────────────────────────────────────────────────────
    /** 列出本 scope 下的 .md 文件（可按子目录过滤）。 */
    list(scope, relDir = '') {
        const root = this.scopeRoot(scope);
        const dir = String(relDir ?? '').trim();
        let base = root;
        if (dir) {
            const chk = checkDirPath(root, dir);
            if (!chk.ok)
                return { ok: false, reason: chk.reason };
            base = chk.abs;
        }
        if (!existsSync(base))
            return { ok: true, files: [] };
        const prefix = dir ? dir.replace(/\/$/, '') : '';
        const files = walkMd(base, '').map((f) => {
            const rel = f.rel.replace(/^\//, '');
            return prefix ? `${prefix}/${rel}` : rel;
        });
        return { ok: true, files };
    }
    // ── 写入（仅主人）──────────────────────────────────────────────────────
    /** 新增/覆盖一条记忆（原子写）。 */
    remember(scope, relPath, content) {
        const body = String(content ?? '');
        if (!body.trim())
            return { ok: false, reason: '内容为空' };
        if (body.length > this.o.writeMaxBytesPerEntry) {
            return { ok: false, reason: `单条内容过大（>${this.o.writeMaxBytesPerEntry} 字符）` };
        }
        const root = this.ensureScopeRoot(scope);
        const chk = checkRelativePath(root, String(relPath ?? ''));
        if (!chk.ok)
            return { ok: false, reason: chk.reason };
        // 容量上限（防无限增长）
        try {
            const existing = walkMd(root, '').length;
            if (!existsSync(chk.abs) && existing >= this.o.writeMaxEntriesPerScope) {
                return { ok: false, reason: `本群记忆条目已达上限 ${this.o.writeMaxEntriesPerScope}，请先整理` };
            }
        }
        catch { /* ignore */ }
        try {
            mkdirSync(dirname(chk.abs), { recursive: true });
        }
        catch { /* ignore */ }
        const r = atomicWriteText(chk.abs, body);
        if (!r.ok)
            return { ok: false, reason: `写入失败: ${r.error}` };
        return { ok: true, path: chk.rel };
    }
    /** 删除一条记忆（移动到 `.trash/`，不直接删）。 */
    forget(scope, relPath, nowMs = Date.now()) {
        const root = this.scopeRoot(scope);
        const chk = checkRelativePath(root, String(relPath ?? ''));
        if (!chk.ok)
            return { ok: false, reason: chk.reason };
        if (!existsSync(chk.abs))
            return { ok: false, reason: '记忆文件不存在' };
        try {
            const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
            const trashDir = join(root, '.trash', stamp);
            mkdirSync(trashDir, { recursive: true });
            const target = join(trashDir, chk.rel.replace(/\//g, '__'));
            renameSync(chk.abs, target);
            const relTrash = `.trash/${stamp}/${chk.rel.replace(/\//g, '__')}`;
            return { ok: true, path: chk.rel, trash: relTrash };
        }
        catch (err) {
            return { ok: false, reason: `删除失败: ${err instanceof Error ? err.message : String(err)}` };
        }
    }
    // ── 内部工具 ────────────────────────────────────────────────────────────
    /**
     * 从 global 层读一个「已剥掉 global/ 前缀」的相对路径。
     *
     * 只在 `read()` 里被两条路径调用：
     *   ① 调用方明确带 `global/` 前缀（这是 `search()` 返回的形态）
     *   ② 本 scope 找不到、退而查 global
     * 两者都必须**过 globalPublicFiles 白名单**，否则等于把 global/ 全盘开放给群友。
     */
    readFromGlobal(relNoPrefix) {
        const rel = String(relNoPrefix ?? '').trim();
        if (!rel)
            return { ok: false, reason: '空路径' };
        const gRoot = this.globalRoot();
        const gChk = checkRelativePath(gRoot, rel);
        if (!gChk.ok)
            return { ok: false, reason: gChk.reason };
        if (!this.o.globalPublicFiles.includes(gChk.rel)) {
            return { ok: false, reason: '该 global 文件不对群友开放' };
        }
        if (!existsSync(gChk.abs))
            return { ok: false, reason: '记忆文件不存在' };
        const text = this.readSafe(gChk.abs);
        if (text === null)
            return { ok: false, reason: '读取失败（文件不可读或过大）' };
        return { ok: true, text, path: `global/${gChk.rel}` };
    }
    /** 安全读文件：try-catch + 大小上限 + 边界复核。返回 null = 读不到。 */
    readSafe(abs) {
        try {
            if (!existsSync(abs))
                return null;
            const st = statSync(abs);
            if (!st.isFile())
                return null;
            if (st.size > this.o.readMaxBytes) {
                this.o.logger?.warn?.(`[qq-memory] 文件过大跳过: ${abs} (${st.size} > ${this.o.readMaxBytes})`);
                return null;
            }
            const raw = readFileSync(abs, 'utf8');
            // ★ 2026-11-06 修（T9 抓到的真 bug）：坏文件里的二进制残留（\u0000 等控制字符）
            //   会随 readFileSync 一起返回，模型收到的是乱码。
            //   这里统一剥掉 C0/C1 控制字符（保留 \n \t），届谓「静默降级」。
            return sanitizeText(raw);
        }
        catch (err) {
            this.o.logger?.warn?.(`[qq-memory] 读取失败: ${abs} ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
}
/**
 * 清洗读到的文本：去掉控制字符（保留换行/制表符），并把 BOM 移除。
 * 目的是让模型永远拿不到二进制残留。
 */
function sanitizeText(raw) {
    const s = String(raw ?? '');
    // 移除 UTF-8 BOM
    const noBom = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    // 去掉除 \t \n \r 之外的所有 C0 控制字符与 U+FFFD 替换符
    return noBom
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
        .replace(/\uFFFD/g, '');
}
/** 把任意字符串压成一个安全的短标签（用于隔离目录名，绝不参与路径解析）。 */
function safeTag(input) {
    let h = 0;
    for (let i = 0; i < input.length; i += 1) {
        h = (h * 31 + input.charCodeAt(i)) >>> 0;
    }
    return String(h).padStart(10, "0");
}
function trunc(s, max) {
    const t = String(s ?? '');
    return t.length <= max ? t : `${t.slice(0, max)}…`;
}
/** 便捷导出：白名单前缀（供配置层展示）。 */
export { isInside };
//# sourceMappingURL=index.js.map