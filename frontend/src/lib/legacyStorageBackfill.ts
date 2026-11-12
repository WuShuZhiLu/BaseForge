/**
 * 旧版 `nowen-*` localStorage 键一次性回填到 `baseforge-*`。
 *
 * 背景：9c4bf7e9 把全部存储键改为 baseforge 前缀且无读旧键兼容，升级用户会直接
 * 掉登录、丢草稿与离线队列。本模块在前端启动最早阶段执行：
 *   - 仅当新键不存在时，把旧键值复制到对应新键（前缀 nowen- → baseforge-）；
 *   - 不删除旧键，保留回滚能力；
 *   - 用 baseforge-storage-migrated-v1 标记防止重复执行；
 *   - 带动态后缀的键（nowen-draft-<id> 等）天然被前缀匹配覆盖。
 */

const MIGRATION_MARKER = "baseforge-storage-migrated-v1";
const LEGACY_PREFIX = "nowen-";
const NEW_PREFIX = "baseforge-";

/**
 * 执行一次旧键回填。可重复调用：已有迁移标记时直接跳过。
 * localStorage 不可用（隐私模式等）时静默失败。
 */
export function backfillLegacyStorageKeys(): void {
    try {
        if (typeof localStorage === "undefined" || localStorage.getItem(MIGRATION_MARKER)) {
            return;
        }
        const legacyKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LEGACY_PREFIX)) {
                legacyKeys.push(key);
            }
        }
        for (const legacyKey of legacyKeys) {
            const newKey = NEW_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
            const legacyValue = localStorage.getItem(legacyKey);
            if (legacyValue === null) continue;
            if (localStorage.getItem(newKey) === null) {
                localStorage.setItem(newKey, legacyValue);
            }
        }
        localStorage.setItem(MIGRATION_MARKER, "1");
    } catch {
        // localStorage 不可用或写入失败：不阻塞启动，下次启动再试。
    }
}
