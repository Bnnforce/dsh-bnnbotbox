/**
 * R4.0「赛博生命体」共享类型契约。
 *
 * 纪律（施工图纸 0.1/0.2）：
 *  - 各模块只许从这里取类型，**不得互相 import**（编排由 r4/index 与 scheduler 完成）；
 *  - 字段名与 Schema 逐字一致（`heartbeat/{groupId}.json`、`relationships/{groupId}.json`、
 *    `profiles/index.json`、`profile-events/{userId}.json`、`state/extraction-state.json`）；
 *  - 不得自行增删字段。
 */
export const EMPTY_HEARTBEAT_STATE = {
    date: '',
    dailyCount: 0,
    lastNonBotMessageAt: 0,
    lastBotMessageAt: 0,
    state: 'normal',
    cold: false,
    coldSetAt: 0,
    waitingUntil: 0,
    cooldownUntil: 0,
};
export const SCORE_KINDS = ['reply', 'mention', 'bot'];
export function emptyRelationshipEntry(level, score) {
    return {
        level,
        score,
        lastDecayAt: 0,
        updatedAt: 0,
        scoreCooldowns: { reply: 0, mention: 0, bot: 0 },
        temporaryAttitude: '',
        temporaryAttitudeExpiresAt: 0,
    };
}
