/**
 * r4/host-types — R4 运行时的宿主契约类型
 *
 * 从 `r4/index.ts` 拆出（重构阶段 2 / 批次 C）。
 * 单独成文件的原因：`inbound.ts` 要引用 `R4Host`，若类型留在 `index.ts` 会造成
 * `index → inbound → index` 的循环引用。把**纯类型**抽出来，依赖方向变成单向：
 *
 *     host-types ← inbound / outbound / index
 *
 * `r4/index.ts` 仍然 `export type { R4Host, R4Handle }`，所以对外 API 面不变。
 */
export {};
