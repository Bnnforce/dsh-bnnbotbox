/**
 * review — 复盘/错题本的**统一出口门面**
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 重构阶段 2 / 批次 A（2026-11-05）：
 *   本文件原来是 493 行的「什么都干」大杂烩，现按职责拆成 5 个文件：
 *
 *     review-types.ts    纯类型与常量（无逻辑，避免循环依赖）
 *     review-detect.ts   语料判定 + session event 文本提取（无 IO）
 *     review-buffer.ts   错题本文件读写（按人格分流 + 原子裁剪）
 *     review-llm.ts      轻量模型调用（提示词/解析/路由/流式收集）
 *     review-overlay.ts  复盘结果 → 行为禁忌（去重/限字/淘汰）
 *
 *   本文件只做 `export *`，**保持对外 API 一字不变** ——
 *   所有调用方（index.ts / maintenance-tasks.ts / review-collector.ts / r4/*）
 *   的 import 路径与函数签名全部不用改。
 *
 *   拆分的唯一目的是「一个文件只干一件事」，业务行为零变化。
 * ═══════════════════════════════════════════════════════════════════════════
 */
export * from './review-types.js';
export * from './review-detect.js';
export * from './review-buffer.js';
export * from './review-llm.js';
export * from './review-overlay.js';
