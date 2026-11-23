import z from '@deepseek-ai/schemastery';
/**
 * dsh-qq-memory 配置（全部参数外置，代码里不写魔法数字 —— 《开发规则》§四.1）
 *
 * 注意：`.volatile()` 表示该字段变化不触发插件重载（设置面板改完立即生效需重启本插件时再看）。
 * 与 persona 插件保持同一风格。
 */
export const Config = z.object({
    enabled: z.boolean().default(true).volatile()
        .description('启用按群隔离的 QQ 记忆库'),
    qqbotDataRoot: z.string().default('').volatile()
        .description('QQBot 数据根；留空=自动探测（优先 qqbot 设置里的 dataRoot，其次 {WORKSPACE_ROOT}/Bot/dshqqbot）'),
    memorySubdir: z.string().default('.qqbot-extensions/data/group-memory').volatile()
        .description('记忆库相对 qqbotDataRoot 的子目录（默认复用现有目录，零迁移）'),
    searchMaxHits: z.number().min(1).max(200).default(30).volatile()
        .description('搜索最多返回多少条命中（防爆 context）'),
    searchLineMaxChars: z.number().min(20).max(2000).default(240).volatile()
        .description('搜索结果单行最大字符数'),
    readMaxBytes: z.number().min(1024).max(50 * 1024 * 1024).default(256 * 1024).volatile()
        .description('单文件读取上限（字节，超过跳过并 warn）'),
    writeMaxBytesPerEntry: z.number().min(1024).max(10 * 1024 * 1024).default(64 * 1024).volatile()
        .description('单条记忆写入上限（字符）'),
    writeMaxEntriesPerScope: z.number().min(10).max(10000).default(500).volatile()
        .description('单个群/私聊最多多少条记忆（防无限增长）'),
    ownerWriteOnly: z.boolean().default(true).volatile()
        .description('写操作仅限主人（群友只能搜/读/列）'),
    ownersFallback: z.array(z.string()).default([]).volatile()
        .description('主人 openid 兜底白名单（persona 服务拿不到白名单时才用）'),
    globalPublicFiles: z.array(z.string()).default(['entities/bot/identity.md', 'entities/people/<owner>.md']).volatile()
        .description('global/ 层对群友开放只读的文件（相对路径）'),
    enableMaintenanceTask: z.boolean().default(true).volatile()
        .description('登记记忆维护任务到任务中心'),
    maintenanceEveryMs: z.number().min(60000).max(24 * 3600 * 1000).default(6 * 3600 * 1000).volatile()
        .description('记忆维护任务的节律（毫秒，默认 6 小时）'),
    autoCardEnabled: z.boolean().default(true).volatile()
        .description('自动建档：按本机群消息/成员台账，为缺失的群卡与人物卡建**骨架**（只写可观测事实，绝不改已有卡）'),
    autoCardGroupEnabled: z.boolean().default(true).volatile()
        .description('自动建档是否包含**群卡**（false = 只建人物卡）'),
    autoCardMinMessages: z.number().min(1).max(1000).default(5).volatile()
        .description('至少在本群说过多少条话，才自动建人物卡（防给一见而过的陌生人建垃圾卡）'),
    // ── 记忆沉淀（2026-11-15 A-Phase 3，默认关闭）─────────────────────────────
    //   为什么默认关：这是唯一会**新增 LLM 调用**的能力，必须先单群试点看成本与质量。
    // ★ 2026-11-17 改为默认开启：工业化产品不能有「写了但不跑」的功能
    //   安全兜底：distillGroupIds 白名单（空=全部，建议先单群试点）
    distillEnabled: z.boolean().default(true).volatile()
        .description('记忆沉淀：定时从群聊提炼事实写入人物卡 History（默认关闭，试点用）'),
    distillGroupIds: z.array(z.string()).default([]).volatile()
        .description('沉淀试点白名单（群 openid；空=全部。建议先只填一个群）'),
    distillMaxMessages: z.number().min(5).max(200).default(50).volatile()
        .description('单次单群最多处理多少条消息'),
    distillMaxHistory: z.number().min(3).max(100).default(20).volatile()
        .description('每人卡 History 段最多保留多少条事实'),
    autoCardMaxPerGroup: z.number().min(1).max(200).default(30).volatile()
        .description('每个群一次最多自动新建几篇人物卡（防一次建几百张拖垮记忆索引）'),
    autoCardIgnoreNames: z.array(z.string()).default(['Q群管家', 'QQ群管家', '群管家']).volatile()
        .description('不自动建档的昵称（服务号/机器人）'),
});
/**
 * 把 schemastery 的输出规整成纯接口对象（缺失字段补默认值）。
 *
 * 🔴 2026-11-06 真机踩到的坑（务必保留这段注释）：
 *   schemastery 的 `.volatile()` 字段在**没有显式配置**时，`validate()` 输出的是 `{}` **空对象**，
 *   `volatile()` 的语义是 "a schema whose output supports get(), including when the field is absent"
 *   —— 必须调 `.get()` 才拿到真实值，直接读属性只有 `{}`。
 *   官方插件（`dsh-bash-local`）一律写 `config.timeoutMs.get()`，源码可查。
 *
 *   于是 `String({})` → `"[object Object]"`，
 *   `memoryRoot` 变成 `.../dshqqbot/[object Object]`（不存在的路径）→ 搜索永远返回空，
 *   而且**不报错**，极难发现。实测证据：boot.log 里 `memoryRoot:".../dshqqbot/[object Object]"`。
 *
 *   🔴 2026-11-06 二次修复（审查发现的 P0-1）：
 *     第一次只加了类型守卫（把 `{}` 当缺失 → 走默认值），**默认值救回来了但用户配置仍在丢**：
 *     实测 `Config({enabled:true, searchMaxHits:50})` → 输出仍是 30。
 *     正确修法：**先 unwrap（有 .get() 就调用）**，拿到真实值再走类型守卫。
 *     这一步同时解决了「显式配置不生效」——那才是真正的用户可见 bug。
 */
export function unwrapVolatile(v) {
    // schemastery volatile 字段的包装对象带 get()
    if (v && typeof v === 'object' && typeof v.get === 'function') {
        try {
            return v.get();
        }
        catch {
            return undefined;
        }
    }
    return v;
}
function asStr(v, fallback) {
    const raw = unwrapVolatile(v);
    if (typeof raw === 'string')
        return raw.trim() === '' ? fallback : raw;
    if (typeof raw === 'number' && Number.isFinite(raw))
        return String(raw);
    return fallback; // 对象/数组/undefined/null 一律视为缺失
}
function asNum(v, fallback, min = -Infinity, max = Infinity) {
    const raw = unwrapVolatile(v);
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function asBool(v, fallback) {
    const raw = unwrapVolatile(v);
    if (typeof raw === 'boolean')
        return raw;
    return fallback;
}
function asStrArr(v, fallback) {
    const raw = unwrapVolatile(v);
    if (!Array.isArray(raw))
        return fallback;
    const out = raw.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    return out.length ? out : fallback;
}
export function resolveConfig(input) {
    const i = (input ?? {});
    return {
        enabled: asBool(i.enabled, true),
        qqbotDataRoot: asStr(i.qqbotDataRoot, ''),
        memorySubdir: asStr(i.memorySubdir, '.qqbot-extensions/data/group-memory'),
        searchMaxHits: asNum(i.searchMaxHits, 30, 1, 200),
        searchLineMaxChars: asNum(i.searchLineMaxChars, 240, 20, 2000),
        readMaxBytes: asNum(i.readMaxBytes, 256 * 1024, 1024, 50 * 1024 * 1024),
        writeMaxBytesPerEntry: asNum(i.writeMaxBytesPerEntry, 64 * 1024, 1024, 10 * 1024 * 1024),
        writeMaxEntriesPerScope: asNum(i.writeMaxEntriesPerScope, 500, 10, 10000),
        ownerWriteOnly: asBool(i.ownerWriteOnly, true),
        ownersFallback: asStrArr(i.ownersFallback, []),
        globalPublicFiles: asStrArr(i.globalPublicFiles, ['entities/bot/identity.md', 'entities/people/<owner>.md']),
        enableMaintenanceTask: asBool(i.enableMaintenanceTask, true),
        maintenanceEveryMs: asNum(i.maintenanceEveryMs, 6 * 3600 * 1000, 60_000, 24 * 3600 * 1000),
        autoCardEnabled: asBool(i.autoCardEnabled, true),
        autoCardGroupEnabled: asBool(i.autoCardGroupEnabled, true),
        autoCardMinMessages: asNum(i.autoCardMinMessages, 5, 1, 1000),
        distillEnabled: asBool(i.distillEnabled, true),
        distillGroupIds: (() => {
            const raw = unwrapVolatile(i.distillGroupIds);
            return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
        })(),
        distillMaxMessages: asNum(i.distillMaxMessages, 50, 5, 200),
        distillMaxHistory: asNum(i.distillMaxHistory, 20, 3, 100),
        autoCardMaxPerGroup: asNum(i.autoCardMaxPerGroup, 30, 1, 200),
        autoCardIgnoreNames: asStrArr(i.autoCardIgnoreNames, ['Q群管家', 'QQ群管家', '群管家']),
    };
}
//# sourceMappingURL=config.js.map