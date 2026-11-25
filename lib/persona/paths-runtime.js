/**
 * paths-runtime — 运行时路径解析（persona 侧适配层）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2026-11-20 合并：**发现逻辑已收敛到 shared/paths.js**，本文件只保留
 * persona 特有的「根列表」概念。
 *
 * 原实现（合并前）自己有一整套候选链（配置 → discover → env → homedir），
 * 与 shared/paths.js 重复。现在：
 *   · `resolvedQqbotRoot` → 直接委托 `resolveQqbotRootTiered`
 *   · `personaRoots`      → persona 特有（人格/guideline 查找用），保留
 *
 * 为什么 personaRoots 不迁到 shared：
 *   它依赖 `discoverQqbotDataRoots()`（analyzer.js），而 analyzer 是 persona
 *   的业务模块。shared 不该反向依赖业务层。
 *
 * ⚠️ 与 `session-map` 的分界（红线 R3）：
 *   `session-groups.json` 的读取与缓存**只能**发生在 session-map，
 *   本文件**绝不**碰那个文件。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { resolveQqbotRootTiered, expandHomeSafe } from '../shared/paths.js';
import { discoverQqbotDataRoots } from './analyzer.js';

/**
 * 解析真实 qqbot 数据根。
 *
 * 语义（保持不变）：
 *   · 配置值**有效** → 用它
 *   · 配置值无效 → 自动发现（并在日志里提示）
 *   · 永不抛错
 *
 * 实现：委托 shared/paths.js 的统一候选链。
 *
 * 背景（2026-11-03 修的致命问题）：配置默认值是 `~/.dsh-qqbot`（本机不存在），
 * 导致 `listHistorySessions()` 恒返 `[]`、R4 全程空转且不报错。
 * 这个探测函数就是那次修复的核心 —— **不要退回"直接用配置值"**。
 *
 * @param {object} config
 * @param {object} [logger]
 * @returns {string}
 */
export function resolvedQqbotRoot(config, logger) {
  const configured = String(config?.qqbotDataRoot ?? '').trim();
  const resolved = resolveQqbotRootTiered(configured);

  // 配置值与实际解析不一致 → 提示（原行为保留）
  try {
    if (configured && expandHomeSafe(configured) !== resolved) {
      logger?.warn?.(
        `[bnnbotbox] qqbotDataRoot 配置值无效（${configured}），已自动解析为 ${resolved}`
        + '（R4/分析/复盘都用这个真实根；建议在设置面板把 qqbotDataRoot 改成该路径）',
      );
    }
  } catch { /* 日志失败不影响主链 */ }

  return resolved;
}

/**
 * 创建路径运行时（启动时解析一次，配置/目录不会在运行中变）。
 *
 * @param {object} config
 * @param {object} [logger]
 * @returns {{qqbotDataRoot: string, personaRoots: () => string[]}}
 */
export function createRuntimePaths(config, logger) {
  const qqbotDataRoot = resolvedQqbotRoot(config, logger);

  /**
   * 人格/guideline 查找用的根列表（首个 = 解析出的真实根）。
   *
   * 2026-11-03：原先直接拿可能是 `~/.dsh-qqbot` 的错误配置值当首个候选，
   * 导致 `personaForGroup` / `readGuidelineSync` 也一起找错目录。
   *
   * @returns {string[]}
   */
  const personaRoots = () => {
    const roots = [qqbotDataRoot, ...discoverQqbotDataRoots()];
    return roots.filter((r, i) => r && roots.indexOf(r) === i);
  };

  return { qqbotDataRoot, personaRoots };
}