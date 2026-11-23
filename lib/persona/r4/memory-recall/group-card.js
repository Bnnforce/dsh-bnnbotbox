/**
 * 记忆联想 · 群档案 + 最近事件
 *
 * 两个轻量模块合在一处（都只是「列目录 + 读一篇」的简单包装，~100 行）：
 *   · `groupCardOf`  —— 本群档案（`entities/groups/*.md` 挑一篇）
 *   · `recentEventsOf` —— 最近 N 天的 `events/*.md`
 *
 * 纪律：所有失败降级为空，绝不抛（`开发规则` 四.4）。
 */
import { extractCurrentSection, clipText, clipBySegment } from './format.js';
/**
 * 取本群档案摘要。
 *
 * 为什么只取「第一篇」：
 *   `entities/groups/` 目录在本群通常只有 1 篇（本群自己）。
 *   实测示例群只有 `示例群.md` 一篇。取第一篇足够，且省 IO。
 *
 * @returns 摘要（已截断）；无档案 / 失败 → 空串
 */
export function groupCardOf(service, scope, maxChars, logger) {
    if (!service || typeof service.list !== 'function')
        return '';
    try {
        const listed = service.list(scope, 'entities/groups');
        if (!listed?.ok || !Array.isArray(listed.files))
            return '';
        const files = listed.files.filter((f) => typeof f === 'string' && f.endsWith('.md'));
        if (!files.length)
            return '';
        const read = service.read(scope, files[0]);
        if (!read?.ok || typeof read.text !== 'string')
            return '';
        const cur = extractCurrentSection(read.text);
        // 按分号整段截断，避免切在「已知成员：a、b、c、三...」这种半个名字处
        return clipBySegment(cur, maxChars);
    }
    catch (err) {
        logger?.warn?.(`[memory-recall] 群档案读取异常（已降级为空）：${err instanceof Error ? err.message : String(err)}`);
        return '';
    }
}
/**
 * 取最近 N 天内的事件摘要。
 *
 * 事件文件名格式（实测）：`events/2026-11-06-xxx.md` 或 `events/birthdays/MM-DD-名.md`
 * 这里只取 `events/` **顶层**的（`list` 会递归，但我们只要 `events/` 直下）。
 *
 * 判定「最近」的方式：
 *   ① 优先从文件名里的日期解析（`YYYY-MM-DD` 前缀）
 *   ② 解析不到 → 跳过（不猜）
 *
 * @returns 事件摘要列表（已截断，按日期新→旧）；失败 → 空数组
 */
export function recentEventsOf(service, scope, opts, logger) {
    if (!service || typeof service.list !== 'function')
        return [];
    try {
        const listed = service.list(scope, 'events');
        if (!listed?.ok || !Array.isArray(listed.files))
            return [];
        const days = Math.max(1, Math.floor(Number(opts.days) || 3));
        const maxItems = Math.max(0, Math.floor(Number(opts.maxItems) || 0));
        if (maxItems <= 0)
            return [];
        const cutoff = Number(opts.now) - days * 24 * 60 * 60 * 1000;
        // ① 取 events/ 直下 **以及单层子目录** 里的 .md，但排除 birthdays
        //
        // ⚠️ 2026-11-08 两轮修正：
        //   第一次：用正则 `/\/[^/]+\//` 判子目录 → 漏掉「单层子目录」（`birthdays/01-01-x.md`
        //           只有一个斜杠，正则要求前后各一个）→ birthdays 被当普通事件。
        //   第二次改成「切片后还含斜杠 → 丢」→ 又**过度**：把 `events/group/生日接龙-2026-10-27.md`
        //           这种**真实群事件**也丢了。实测该群 events/ 直下 0 个文件，
        //           唯一真实事件就在 events/group/ 里 → 最近事件段永远是空。
        //   现在：接受 `events/x.md` 和 `events/<单层>/x.md`，只**指名排除** birthdays。
        const EXCLUDED_EVENT_DIRS = ['birthdays'];
        const flat = listed.files
            .filter((f) => typeof f === 'string' && f.endsWith('.md'))
            .filter((f) => {
            const rest = f.slice('events/'.length);
            const slash = rest.indexOf('/');
            if (slash < 0)
                return true; // events/ 直下
            if (rest.indexOf('/', slash + 1) >= 0)
                return false; // 两层以上子目录 → 不要
            return !EXCLUDED_EVENT_DIRS.includes(rest.slice(0, slash)); // 排除 birthdays
        });
        // ② 解析日期
        const dated = flat
            .map((f) => {
            // ⚠️ 只在**文件名**里找日期：子目录名通常不带日期，但路径前缀里
            //    可能出现意外数字（如 `events/2026/`），限制在 basename 更稳。
            const base = f.split('/').pop() ?? '';
            const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(base);
            if (!m)
                return null;
            const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
            return Number.isFinite(at) ? { path: f, at } : null;
        })
            .filter((x) => Boolean(x))
            .filter((x) => x.at >= cutoff)
            .sort((a, b) => b.at - a.at) // 新的优先
            .slice(0, maxItems);
        // ③ 读内容取 Current 段
        const out = [];
        for (const item of dated) {
            const read = service.read(scope, item.path);
            if (!read?.ok || typeof read.text !== 'string')
                continue;
            const cur = extractCurrentSection(read.text);
            const txt = clipText(cur, opts.perItemChars);
            if (txt)
                out.push({ text: txt, at: item.at });
        }
        return out;
    }
    catch (err) {
        logger?.warn?.(`[memory-recall] 最近事件读取异常（已降级为空）：${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
