export const NOOP_LOGGER = {};
/** 安全打日志：logger 缺失、抛错都不影响主链。 */
export function logInfo(logger, msg) {
    try {
        logger?.info?.(msg);
    }
    catch { /* ignore */ }
}
export function logWarn(logger, msg) {
    try {
        logger?.warn?.(msg);
    }
    catch { /* ignore */ }
}
