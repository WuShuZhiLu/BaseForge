import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRemovedServerProfiles } from "@/lib/removedServerProfileCleanup";

describe("遗留服务器资料清理", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("只删除多服务器专用键", async () => {
    localStorage.setItem("baseforge-server-profiles-v2", "[]");
    localStorage.setItem("baseforge-active-server-profile-v2", "old");
    localStorage.setItem("baseforge-server-profiles-v1", "[]");
    localStorage.setItem("baseforge-active-server-profile-v1", "old");
    localStorage.setItem("baseforge-cloud-login-records-v1", "[]");
    localStorage.setItem("baseforge-profile-credential-index-v1", JSON.stringify(["old"]));
    sessionStorage.setItem("baseforge-pending-profile-reauth-v1", "old");
    localStorage.setItem("baseforge-server-url", "http://127.0.0.1:3001");
    localStorage.setItem("baseforge-token", "token");

    await cleanupRemovedServerProfiles({ isNativePlatform: () => false });

    expect(localStorage.getItem("baseforge-server-profiles-v2")).toBeNull();
    expect(localStorage.getItem("baseforge-active-server-profile-v2")).toBeNull();
    expect(localStorage.getItem("baseforge-server-profiles-v1")).toBeNull();
    expect(localStorage.getItem("baseforge-active-server-profile-v1")).toBeNull();
    expect(localStorage.getItem("baseforge-cloud-login-records-v1")).toBeNull();
    expect(localStorage.getItem("baseforge-profile-credential-index-v1")).toBeNull();
    expect(sessionStorage.getItem("baseforge-pending-profile-reauth-v1")).toBeNull();
    expect(localStorage.getItem("baseforge-server-url")).toBe("http://127.0.0.1:3001");
    expect(localStorage.getItem("baseforge-token")).toBe("token");
  });

  it("Android 安全存储删除失败时保留索引供下次重试", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem("baseforge-profile-credential-index-v1", JSON.stringify(["one", "two"]));
    const removeSecureItem = vi.fn(async (key: string) => {
      if (key.includes("two")) throw new Error("remove failed");
    });

    await cleanupRemovedServerProfiles({ isNativePlatform: () => true, removeSecureItem });

    expect(removeSecureItem).toHaveBeenCalledWith("serverAccount.one.v1");
    expect(removeSecureItem).toHaveBeenCalledWith("serverAccount.two.v1");
    expect(localStorage.getItem("baseforge-profile-credential-index-v1")).toBe(JSON.stringify(["one", "two"]));
  });
});
