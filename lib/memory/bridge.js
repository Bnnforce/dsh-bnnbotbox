/**
 * globalThis 桥 —— 让 QQBot 扩展包（.mjs）能调用 cordis Service
 *
 * 为什么需要这条桥（而不是 cordis Service）：
 *   · 插件 ↔ 插件：cordis 提供 ctx.get('qqMemory') / inject，服务发现天然成立；
 *   · 插件 ↔ QQBot 扩展包：扩展包是 QQBot 插件用 `import()` 动态加载的 .mjs，
 *     它的 `env` 由 **QQBot 插件**构造（{ dataRoot, peer, senderId … }），
 *     **根本拿不到 cordis 的 ctx**，也就没有 ctx.get()/inject 可言。
 *     唯一的共享介质是进程级全局对象 —— 所以插件把它挂到 globalThis，
 *     扩展包从 globalThis 取。这是「插件 ↔ 扩展包」这一跨宿主调用的唯一通路。
 *
 * 生命周期：插件 apply() 时 `installBridge(service)` 挂上，dispose 时调返回的 disposer 摘掉。
 *   桥里存 { service, at, version }：
 *     · version 单调递增 —— 每次插件（重新）挂载 +1，扩展包据此检测「是不是换了实例」，
 *       实例变了就丢掉自己缓存的旧引用（旧 service 可能已被 cordis 卸载/销毁）。
 *     · at 是挂载时刻（ms），便于诊断「桥是这次启动挂的，还是上次残留的」。
 *
 * 热重载要兜住的两类坑：
 *   ① 扩展包每次热重载都会重新 import —— 它会再次 getBridge()。
 *      这里**复用同一个桥对象**、只更新 service/version/at（不新建），
 *      这样扩展包手里已经拿到的桥引用继续有效，读到的也是新 service。
 *   ② 旧插件实例的 dispose 可能**晚于**新实例的 install 才执行 ——
 *      若 disposer 无条件 delete，就会把新接好的桥摘掉。
 *      所以每次 install 领一个 token，disposer 只在「自己仍是最后一次 install」时才真摘除。
 *
 * 约定：所有入口都 try/catch，**永不抛**。扩展包是别人家的代码，
 * 桥这边任何异常都不该把 QQBot 的消息处理链带崩；取不到桥时返回 undefined，
 * 由扩展包优雅降级（回「记忆不可用」而不是抛错）。
 */
export const BRIDGE_SYMBOL = Symbol.for('dsh.qq-memory.v1');
/**
 * 内部状态槽（单独一个 symbol，避免污染扩展包读到的桥对象）。
 *   · seq  —— 全局高水位，保证「插件重启后 version 继续 +1」而不是回到 1；
 *     放在 globalThis 而不放模块变量，正是因为插件重载会重新 import 本模块。
 *   · token —— 最后一次 install 的序号，disposer 用它判断自己是否已过期。
 */
const STATE_SYMBOL = Symbol.for('dsh.qq-memory.v1.state');
/** 取 globalThis 的可写视图（TS 里 globalThis 不能直接按 symbol 下标访问）。 */
function slot() {
    return globalThis;
}
/** 取/建内部状态；失败时退回一个临时对象（只影响版本单调性，不影响「不抛」）。 */
function stateOf() {
    try {
        const g = slot();
        const cur = g[STATE_SYMBOL];
        if (cur && typeof cur === 'object' && typeof cur.seq === 'number' && typeof cur.token === 'number') {
            return cur;
        }
        const fresh = { seq: 0, token: 0 };
        g[STATE_SYMBOL] = fresh;
        return fresh;
    }
    catch {
        return { seq: 0, token: 0 };
    }
}
/**
 * 挂上桥（幂等：已存在则复用并 +1 version）。返回摘除函数。
 *
 * · 重复调用 → 同一个桥对象上更新 service/at/version，扩展包无需重新取引用；
 * · 返回的 disposer 只在「自己是最后一次安装」时才真摘除，旧实例的 dispose 不会误摘新桥；
 * · 任何异常都被吞掉，disposer 一定返回一个函数（哪怕空操作）。
 */
export function installBridge(service) {
    let myToken = -1;
    let mine;
    try {
        const g = slot();
        const st = stateOf();
        // 复用还是新建：类型不对（被别人写坏/旧版本残留）就重建。
        let bridge = g[BRIDGE_SYMBOL];
        const prevVersion = bridge && typeof bridge === 'object' && typeof bridge.version === 'number' ? bridge.version : 0;
        if (!bridge || typeof bridge !== 'object') {
            bridge = { version: 0, at: 0 };
            g[BRIDGE_SYMBOL] = bridge;
        }
        // version 取「全局高水位 / 桥自带版本」的较大值再 +1 —— 插件重启不会让版本回退。
        st.seq = Math.max(st.seq, Number.isFinite(prevVersion) ? prevVersion : 0) + 1;
        st.token += 1;
        myToken = st.token;
        bridge.version = st.seq;
        bridge.at = Date.now();
        bridge.service = service; // 显式覆盖（含 undefined：表示「插件还没就绪」）
        mine = bridge;
    }
    catch {
        /* 挂桥失败也必须返回可调用的 disposer，永不抛 */
    }
    return () => {
        try {
            const g = slot();
            const st = stateOf();
            // ① 已被更新的一次 install 接管 → 什么都不做（这是防「旧 dispose 摘新桥」的关键）
            if (st.token !== myToken)
                return;
            // ② 桥已被替换/已摘除 → 也不做
            const cur = g[BRIDGE_SYMBOL];
            if (!cur || cur !== mine)
                return;
            delete g[BRIDGE_SYMBOL];
        }
        catch {
            /* 永不抛 */
        }
    };
}
/**
 * 取桥；取不到返回 undefined（扩展包应优雅降级）。
 *
 * 注意：调用方**不要缓存返回值**里的 service —— 每次用之前重新 getBridge()，
 * 桥会被插件重启替换（service 变了、version 变了），缓存旧 service 就是在用已销毁的对象。
 */
export function getBridge() {
    try {
        const b = slot()[BRIDGE_SYMBOL];
        if (!b || typeof b !== 'object')
            return undefined;
        // 只认结构完整的桥，别把别处误写的垃圾当桥用。
        if (typeof b.version !== 'number' || typeof b.at !== 'number')
            return undefined;
        return b;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=bridge.js.map