/**
 * config — 合并配置（单一 schema 出口）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 本包由两个原插件合并而来：
 *   · lib/persona/  （原 dsh-anti-ai-persona）
 *   · lib/memory/   （原 dsh-qq-memory）
 *
 * 合并后**必须只对外暴露一套 Config**，否则会出现「两个插件各认一半字段」的
 * 割裂状态 —— 用户在某一边改的配置，另一边看不到。
 *
 * ── 为什么不能直接换回 `z.intersect` ──────────────────────────────────────
 *
 *   ❌ `z.intersect([PersonaConfig, MemoryConfig])`
 *      schemastery 的 `volatile()` 字段**要求固定的对象路径**，
 *      intersect 会把字段包进数组索引（`$.0.enabled`），触发：
 *        ValidationError: $.0.enabled volatile fields require a fixed object path
 *
 *   ✅ 现在的做法：**把两边的字段字典摊平进同一个 `z.object`**
 *      路径仍然是 `$.字段名`，volatile() 正常工作，也不需要 intersect。
 *
 * ── 字段冲突 ───────────────────────────────────────────────────────────────
 *
 *   重名：`enabled`、`qqbotDataRoot`（两边都有，语义相同）
 *   处理：persona 覆盖 memory（spread 顺序：memory 先、persona 后）
 *        —— persona 是主体，且它的默认值更贴合"整个包"的语义。
 *
 * ── 历史缺陷（2026-11-23 修复）──────────────────────────────────────────────
 *
 *   在此之前，本文件只写了 `export { PersonaConfig as Config }`，
 *   即对外 schema 只有 persona 的 32 个字段。
 *   后果：memory 独有的 **20 个字段**（memorySubdir / searchMaxHits /
 *   distillEnabled / autoCardEnabled …）根本不在 schema 里，
 *   用户在 DSH 设置面板里**看不到、也设不了**，只能改配置文件绕过。
 *   `resolveConfig` 虽然会把它们从 raw 里读出来，但 schema 校验阶段就已经丢了。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import z from '@deepseek-ai/schemastery';
import { Config as PersonaConfig, resolveConfig as resolvePersona } from './persona/config.js';
import { Config as MemoryConfig, resolveConfig as resolveMemory } from './memory/config.js';

/**
 * 对外唯一 Config schema。
 *
 * 构造方式：取两边的 `.dict`（字段 → schema 节点的映射）摊平后重新包一个
 * `z.object`。memory 在前、persona 在后 ⇒ 重名字段以 persona 为准。
 *
 * ⚠️ 改动这里之后请跑 `node test/run-all.mjs`：
 *    配置是插件的第一道门，schema 变形会让所有字段的默认值一起变。
 */
export const Config = z.object({
  ...MemoryConfig.dict,
  ...PersonaConfig.dict,
});

/**
 * 解析合并配置（拿到**已经过 schema 校验**的对象，或 loader 直接传的 raw）。
 *
 * 流程：
 *   1. persona 的 resolveConfig 处理它认识的字段
 *   2. memory 的 resolveConfig 处理它认识的字段
 *   3. 以 persona 结果为主，把 memory 独有字段补进去
 *
 * 两边都包 try：任一模块的配置坏了，另一个仍能正常工作（否则一个字段写错
 * 就直接让整个插件起不来 —— 这是合并前的真实痛点）。
 *
 * @param {object|undefined} raw 原始配置
 * @returns {object} 合并后的配置
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};

  let personaCfg = {};
  let memoryCfg = {};

  // 两个都独立 resolve，互不影响
  try {
    personaCfg = resolvePersona(input) ?? {};
  } catch {
    personaCfg = input;
  }

  try {
    memoryCfg = resolveMemory(input) ?? {};
  } catch {
    memoryCfg = {};
  }

  // 合并：persona 优先，memory 补缺
  const merged = { ...personaCfg };

  for (const [k, v] of Object.entries(memoryCfg)) {
    // 已存在且非 undefined 的取 persona 的（主体优先）
    if (merged[k] === undefined || merged[k] === null) {
      merged[k] = v;
    }
  }

  return merged;
}

export default { Config, resolveConfig };
