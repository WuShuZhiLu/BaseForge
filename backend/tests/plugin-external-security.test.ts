import assert from "node:assert/strict";
import test from "node:test";
import { getDb, closeDb } from "../src/db/schema.js";
import { HostApiBroker } from "../src/plugins/hostApiBroker.js";
import {
  PLUGIN_EXTERNAL_FETCH_QUOTA,
  PluginExternalFetchLimiter,
} from "../src/plugins/pluginRateLimiter.js";
import { PluginPermissions, externalFetchHostsFromConfig } from "../src/plugins/permissions.js";
import type { PermissionRow } from "../src/plugins/permissions.js";
import type { PluginExecutionContext, PluginRegistryRecord } from "../src/plugins/types.js";
import { initAuditTables } from "../src/services/audit.js";

const EPOCH = 1_700_000_000_000;
const registryId = "com.example.external-quota";
const context: PluginExecutionContext = {
  executionId: "exec-external-quota",
  pluginId: registryId,
  actionId: "fetch",
  userId: "external-user",
  workspaceId: null,
};

function auditCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE category='plugin' AND action='external_fetch_denied'")
    .get() as { total: number };
  return row.total;
}

function stubBroker(limiter: PluginExternalFetchLimiter): HostApiBroker {
  const permissionRow: PermissionRow = {
    pluginId: registryId,
    permission: "external:fetch",
    configJson: JSON.stringify({ hosts: ["allowed.example.com"] }),
    granted: 1,
    grantedBy: "admin",
    grantedAt: new Date().toISOString(),
  };
  const permissions = { require: () => permissionRow };
  const record = { apiVersion: 2, runtime: "node-action", manifestJson: "{}" } as unknown as PluginRegistryRecord;
  const registry = { get: () => record };
  return new HostApiBroker(
    permissions as unknown as PluginPermissions,
    undefined,
    undefined,
    registry as unknown as ConstructorParameters<typeof HostApiBroker>[3],
    limiter,
  );
}

test("授权视图解析 external:fetch 域名列表，缺失或损坏的 configJson 返回空数组", () => {
  const db = getDb();
  db.prepare(`INSERT INTO plugin_registry(id,name,version,apiVersion,runtime,main,source,trustLevel,status,checksum,manifestJson,installedPath,installedAt,updatedAt)
    VALUES ('com.example.hosts','Hosts','1.0.0',2,'node-action','index.mjs','dev','developer','enabled','x','{}','x','x','x')`).run();
  const insert = db.prepare("INSERT INTO plugin_permissions(pluginId,permission,configJson,granted) VALUES (?,?,?,1)");
  insert.run("com.example.hosts", "external:fetch", JSON.stringify({ hosts: ["a.example.com", 7, "b.example.com:8443"] }));
  insert.run("com.example.hosts", "secrets:use", "");

  const rows = new PluginPermissions().list("com.example.hosts");
  const external = rows.find((row) => row.permission === "external:fetch")!;
  assert.deepEqual(external.hosts, ["a.example.com", "b.example.com:8443"]);
  assert.deepEqual(rows.find((row) => row.permission === "secrets:use")!.hosts, []);

  assert.deepEqual(externalFetchHostsFromConfig(null), []);
  assert.deepEqual(externalFetchHostsFromConfig("not-json"), []);
  assert.deepEqual(externalFetchHostsFromConfig("[1,2]"), []);
  assert.deepEqual(externalFetchHostsFromConfig(JSON.stringify({ hosts: "a.example.com" })), []);
});

test("配额为每分钟 60 次、并发 4、每小时 600 次，释放幂等", () => {
  assert.equal(PLUGIN_EXTERNAL_FETCH_QUOTA.requestsPerMinute, 60);
  assert.equal(PLUGIN_EXTERNAL_FETCH_QUOTA.maxConcurrent, 4);
  assert.equal(PLUGIN_EXTERNAL_FETCH_QUOTA.requestsPerHour, 600);

  const concurrent = new PluginExternalFetchLimiter();
  const releases = [0, 1, 2, 3].map(() => concurrent.acquire("plugin-a", EPOCH));
  assert.throws(() => concurrent.acquire("plugin-a", EPOCH), (error: any) => error.code === "PLUGIN_RATE_LIMITED");
  releases[0]();
  releases[0]();
  const extra = concurrent.acquire("plugin-a", EPOCH);
  extra();
  for (const release of releases.slice(1)) release();

  const perMinute = new PluginExternalFetchLimiter();
  for (let index = 0; index < 60; index += 1) perMinute.acquire("plugin-b", EPOCH)();
  assert.throws(() => perMinute.acquire("plugin-b", EPOCH), (error: any) => error.code === "PLUGIN_RATE_LIMITED");
  perMinute.acquire("plugin-b", EPOCH + 60_001)();
  assert.ok(true);

  const perHour = new PluginExternalFetchLimiter();
  for (let minute = 0; minute < 12; minute += 1) {
    for (let index = 0; index < 50; index += 1) perHour.acquire("plugin-c", EPOCH + minute * 60_000)();
  }
  assert.throws(() => perHour.acquire("plugin-c", EPOCH + 12 * 60_000), (error: any) => error.code === "PLUGIN_RATE_LIMITED");
  const otherPlugin = perHour.acquire("plugin-d", EPOCH + 12 * 60_000);
  otherPlugin();

  const isolated = new PluginExternalFetchLimiter();
  const held = isolated.acquire("plugin-e", EPOCH);
  const other = isolated.acquire("plugin-f", EPOCH);
  other();
  held();
});

test("白名单与限流拒绝写入审计，且并发配额在异常路径释放", async () => {
  initAuditTables();
  const limiter = new PluginExternalFetchLimiter();
  const broker = stubBroker(limiter);

  await assert.rejects(
    () => broker.call(context, { method: "external.fetch", args: { url: "https://denied.example.com/path?token=secret" } }),
    (error: any) => error.code === "EXTERNAL_FETCH_DENIED",
  );
  assert.equal(auditCount(), 1);
  const details = (getDb().prepare("SELECT details FROM audit_logs WHERE action='external_fetch_denied' ORDER BY rowid DESC LIMIT 1").get() as { details: string }).details;
  assert.match(details, /denied\.example\.com/);
  assert.doesNotMatch(details, /token=secret/);

  // 拒绝路径必须归还并发槽位：之后仍能占满 4 个。
  const releasedSlots = [0, 1, 2, 3].map(() => limiter.acquire(registryId, EPOCH));
  await assert.rejects(
    () => broker.call(context, { method: "external.fetch", args: { url: "https://allowed.example.com/data" } }),
    (error: any) => error.code === "PLUGIN_RATE_LIMITED",
  );
  assert.equal(auditCount(), 2);
  for (const release of releasedSlots) release();

  closeDb();
});
