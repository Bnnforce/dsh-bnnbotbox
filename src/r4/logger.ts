/** R4.0 日志端口：宿主 logger 是可选字段，缺了就静默（绝不抛错）。 */
export interface R4Logger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export const NOOP_LOGGER: R4Logger = {};

/** 安全打日志：logger 缺失、抛错都不影响主链。 */
export function logInfo(logger: R4Logger | undefined, msg: string): void {
  try { logger?.info?.(msg); } catch { /* ignore */ }
}

export function logWarn(logger: R4Logger | undefined, msg: string): void {
  try { logger?.warn?.(msg); } catch { /* ignore */ }
}
