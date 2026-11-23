/**
 * paths-runtime — 运行时路径解析（从 `index.ts` 拆出，重构任务 B1）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 职责边界（**只做环境探测，不持有任何状态、不注册监听**）：
 *   ① `resolvedQqbotRoot()` —— qqbot 数据根自动探测
 *   ② `personaRoots()`      —— 人格/guideline 查找用的根列表
 *
 * 为什么单独拆出来：这两块是**纯环境探测**（读配置 + 试文件是否存在），
 * 没有状态机、没有监听、没有定时器 —— 是整次拆分里风险最低的一块。
 *
 * ⚠️ 与 `session-map.ts` 的分界（红线 R3）：
 *   `session-groups.json` 的**读取与缓存只能**发生在 `session-map.ts`，
 *   本文件**绝不**碰那个文件。
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverQqbotDataRoots, expandHome } from './analyzer.js';

/** 本模块只依赖的最小上下文（不 import AppConfig，避免与 config 循环）。 */
export interface PathsRuntimeConfig {
  qqbotDataRoot: string;
}

export interface RuntimePaths {
  /** 真实 qqbot 数据根（已探测，可能不等于配置值）。 */
  readonly qqbotDataRoot: string;
  /** 人格/guideline 查找根列表（首个 = `qqbotDataRoot`，已去重）。 */
  personaRoots: () => string[];
}

export interface PathsRuntimeLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * 解析真实 qqbot 数据根。
 *
 * 候选顺序（首个命中即用）：
 *   ① 配置值
 *   ② `discoverQqbotDataRoots()` 自动发现
 *   ③ 硬编码 `{WORKSPACE_ROOT}/Bot/dshqqbot`
 *   ④ `~/.dsh-qqbot`
 *
 * 判据：该目录下 `.qqbot/msg-history` 是目录 → 采用；退一步，`.qqbot` 存在也算。
 * **永不抛错**（全部包 try）。
 *
 * 背景（2026-11-03 修的致命问题）：配置默认值是 `~/.dsh-qqbot`（本机不存在），
 * 导致 `listHistorySessions()` 恒返 `[]`、R4 全程空转且不报错。
 * 这个探测函数就是那次修复的核心 —— **不要退回"直接用配置值"**。
 */
export function resolvedQqbotRoot(config: PathsRuntimeConfig, logger?: PathsRuntimeLogger): string {
  const candidates: string[] = [];
  const push = (v: unknown): void => {
    const s = String(v ?? '').trim();
    if (!s) return;
    const full = expandHome(s);
    if (!candidates.includes(full)) candidates.push(full);
  };
  push(config.qqbotDataRoot);
  for (const r of discoverQqbotDataRoots()) push(r);
  push(process.env.BOT_DATA_ROOT || '');
  push(join(homedir(), '.dsh-qqbot'));

  for (const c of candidates) {
    try {
      if (statSync(join(c, '.qqbot', 'msg-history')).isDirectory()) return c;
    } catch { /* 不是这个 */ }
  }
  // 退一步：只要 `.qqbot` 目录在也算（历史可能还没产生）
  for (const c of candidates) {
    try {
      if (statSync(join(c, '.qqbot')).isDirectory()) return c;
    } catch { /* 不是这个 */ }
  }
  return expandHome(config.qqbotDataRoot);
}

/**
 * 创建路径运行时（启动时解析一次，配置/目录不会在运行中变）。
 *
 * `logger` 只用于「配置值无效 → 已自动解析」那一条告警。
 */
export function createRuntimePaths(config: PathsRuntimeConfig, logger?: PathsRuntimeLogger): RuntimePaths {
  const qqbotDataRoot = resolvedQqbotRoot(config, logger);

  try {
    const configured = expandHome(config.qqbotDataRoot);
    if (qqbotDataRoot !== configured) {
      logger?.warn?.(
        `[anti-ai-persona] qqbotDataRoot 配置值无效（${configured}），已自动解析为 ${qqbotDataRoot}`
        + '（R4/分析/复盘都用这个真实根；建议在设置面板把 qqbotDataRoot 改成该路径）',
      );
    }
  } catch { /* 日志失败不影响主链 */ }

  /**
   * 人格/guideline 查找用的根列表（首个 = 解析出的真实根）。
   * 2026-11-03：原先直接拿可能是 `~/.dsh-qqbot` 的错误配置值当首个候选，
   * 导致 `personaForGroup` / `readGuidelineSync` 也一起找错目录。
   */
  const personaRoots = (): string[] => {
    const roots = [qqbotDataRoot, ...discoverQqbotDataRoots()];
    return roots.filter((r, i) => r && roots.indexOf(r) === i);
  };

  return { qqbotDataRoot, personaRoots };
}
