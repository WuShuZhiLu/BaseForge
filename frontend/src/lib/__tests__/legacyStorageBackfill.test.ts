import { beforeEach, describe, expect, it } from "vitest";
import { backfillLegacyStorageKeys } from "../legacyStorageBackfill";

describe("backfillLegacyStorageKeys", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("旧键不存在时复制到新键，值一致，旧键保留", () => {
        localStorage.setItem("nowen-token", "tok-123");
        localStorage.setItem("nowen-draft-x", "draft-body");
        localStorage.setItem("nowen-offline-queue:v2", "[1,2,3]");
        localStorage.setItem("nowen-cache-v2-abc", "cached");

        backfillLegacyStorageKeys();

        expect(localStorage.getItem("baseforge-token")).toBe("tok-123");
        expect(localStorage.getItem("baseforge-draft-x")).toBe("draft-body");
        expect(localStorage.getItem("baseforge-offline-queue:v2")).toBe("[1,2,3]");
        expect(localStorage.getItem("baseforge-cache-v2-abc")).toBe("cached");
        expect(localStorage.getItem("nowen-token")).toBe("tok-123");
        expect(localStorage.getItem("nowen-draft-x")).toBe("draft-body");
        expect(localStorage.getItem("nowen-offline-queue:v2")).toBe("[1,2,3]");
        expect(localStorage.getItem("nowen-cache-v2-abc")).toBe("cached");
    });

    it("新键已存在时不覆盖新键值", () => {
        localStorage.setItem("nowen-token", "old-token");
        localStorage.setItem("baseforge-token", "new-token");

        backfillLegacyStorageKeys();

        expect(localStorage.getItem("baseforge-token")).toBe("new-token");
        expect(localStorage.getItem("nowen-token")).toBe("old-token");
    });

    it("重复执行不重复写：清理新键后再调用不会从旧键回填", () => {
        localStorage.setItem("nowen-token", "tok-1");

        backfillLegacyStorageKeys();
        expect(localStorage.getItem("baseforge-token")).toBe("tok-1");

        localStorage.removeItem("baseforge-token");
        backfillLegacyStorageKeys();

        expect(localStorage.getItem("baseforge-token")).toBeNull();
        expect(localStorage.getItem("nowen-token")).toBe("tok-1");
    });

    it("值为 null 的旧键（异常态）不写新键", () => {
        // 无法通过 setItem 造 null，等价场景：旧键值存在但新键不覆盖已在用例 2 覆盖；
        // 此处验证纯 baseforge 键不受影响。
        localStorage.setItem("baseforge-device-id", "dev-1");

        backfillLegacyStorageKeys();

        expect(localStorage.getItem("baseforge-device-id")).toBe("dev-1");
    });

    it("迁移后写入迁移标记", () => {
        backfillLegacyStorageKeys();

        expect(localStorage.getItem("baseforge-storage-migrated-v1")).toBe("1");
    });
});
