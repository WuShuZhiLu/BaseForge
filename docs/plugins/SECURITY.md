# Nowen 插件安全模型（SECURITY）

> 与代码同步于提交 `e47d57072`（分支 `feat/space-and-plugins`）。
> 依据：`backend/src/plugins/` 下 `manifest.ts`、`packageValidator.ts`、`packageInstaller.ts`、`permissions.ts`、
> `secureExternalFetch.ts`、`pluginRateLimiter.ts`、`secrets.ts`、`hostApiBroker.ts`、`sandboxRunner.ts`、
> `sandbox-child.mjs`、`runner.ts`、`runner-child.mjs`、`inboundWebhooks.ts`、`registryTrust.ts`、
> `registryMetadataGuard.ts`、`logs.ts`。

---

## 1. 隔离模型

| runtime | 执行体 | 能力边界 | 强度 |
| --- | --- | --- | --- |
| `sandbox-js` | 子进程内的 QuickJS（`quickjs-emscripten`）上下文，只注入 `nowen` 桥 | 只有 broker 暴露的 Host API；无 `fs`/`net`/`process`/`require` | **能力隔离（强）** |
| `node-action` | `child_process.fork` 的独立 Node 进程，`import()` 插件入口 | 完整 Node 运行时（fs/net/子进程都可用） | **进程隔离（弱）**，依赖操作系统账号边界 |
| `declarative` | 不执行任何代码 | 只有宿主渲染的静态数据 | 无执行面 |

`node-action` 的进程级收敛措施（`runner.ts`）：

- `env` 白名单化，只透传 `PATH`/`Path`/`SystemRoot`/`WINDIR`/`TEMP`/`TMP`/`LANG`/`LC_ALL`/`TZ`，并强制
  `NODE_ENV=production`、`ELECTRON_RUN_AS_NODE=1`；宿主自身的 token、DB 路径等环境变量不可见。
- `execArgv: ["--max-old-space-size=128"]`、`stdio: ["ignore","ignore","ignore","ipc"]`、启动超时 5s。
- `cwd` 设为插件安装目录，插件之间是不同版本目录，不会互相覆盖文件。

`sandbox-js` 的会话限额（`sandbox-child.mjs` 的 `LIMITS`）：

| 项 | 上限 |
| --- | --- |
| IPC 单条消息 | 2 MiB |
| 单次 Host 调用入参 | 256 KiB |
| 单次 Host 调用回参 | 1 MiB |
| 每次执行 Host 调用次数 | 1000 |
| 并发待决 Host 调用 | 32 |
| 进度事件数 / 单条文案 | 100 / 500 字符 |

### 1.1 必须明说的残留风险

**`node-action` 不是安全沙箱。** 子进程可以自行 `fs.readFile` 任意可读路径、直接用 `https` 出网、忽略
`external:fetch` 的白名单与配额。因此：

- 对 `node-action` 插件，`external:fetch` / `permissionConfig.externalFetchHosts` 是**推荐路径 + 审计口径**，
  不是强制网络管制。
- 真正的强制边界只有：安装期静态检查（禁止二进制/安装脚本/符号链接）、进程边界、内存上限、执行超时、
  数据面 ACL（Host API 内按 `context.userId` 校验）。
- 因此 `node-action` 插件的信任度实际上等于"用户愿意让它在自己账号下跑一个本地程序"，UI 上应据此提示。

`sandbox-js` 的边界成立前提是 QuickJS 本身无逃逸漏洞；桥接层已对方法白名单、参数/回参字节数做校验。

---

## 2. 授权与生命周期

```
安装 → status=quarantined, 写入 plugin_permissions(granted=0)
     → 用户逐项确认 → replaceGrants()（只能授 manifest 已声明项）
     → enable(): 必须 allDeclaredGranted()
     → preflight（加载并核对每个 action 是否实现）
     → probation（可执行插件首次 5 次执行；声明式 1 次）→ stable
```

关键语义：

- **默认拒绝**：`quarantined` 状态下不加载、不执行；`PluginPermissions.require()` 无 `granted=1` 行即抛
  `PLUGIN_PERMISSION_DENIED`。
- **不能越声明授权**：`replaceGrants` 对不在 manifest 中的权限报 `不能授予 Manifest 未声明的权限`。
- **更新不继承授权**：`initialize()` 默认 `preserveExistingGrants=false`，重装/更新会把 `granted` 重置为 0；
  更新协调器会计算 `permissionDiff.added` 与 `permissionDiff.addedHosts`，新增权限/新增域名需要重新确认。
- **开发目录零信任**：进程重启后 `source='dev'` 的记录一律回到 `quarantined` 并清空授权
  （`开发插件重启后需要重新确认`）；开发模式仅在 Desktop Embedded Backend 或非生产环境可用。
- **恢复不自动可信**：从备份恢复的插件被标为 `source='restore'`、`signatureState='needs-revalidation'`、
  `advisoryState='unknown'`，必须重新校验签名与安全公告后才能启用。
- **声明式插件**：`permissions` 必须为 `[]`，不允许 `permissionConfig`，不允许 `secret` 设置项，包内不允许
  任何 `.js/.mjs/.cjs/.wasm`。

---

## 3. 数据隔离

- 所有 Host API 都以服务端 `PluginExecutionContext` 的 `userId` / `workspaceId` 为授权主体，**不信任插件传入的
  身份字段**。读写路径统一走 `allowedWorkspace()` / `hasRole()`：读要求成员身份，写要求 `editor` 及以上。
- 个人任务只能由所有者读取（`canReadPluginTask`：`workspaceId` 为空时 `task.userId === actorId`）。
- 插件存储键为 `(pluginId, scopeType, scopeId, key)`；`scopeType` 只能是 `user`/`workspace`，`scopeId` 缺省取
  当前用户或当前工作区；跨工作区访问要走 `allowedWorkspace`。
- 连接凭据表 `plugin_secrets` 的主键是 `(pluginId, ownerUserId, name)`，AES-256-GCM 加密，密钥文件
  `<userData>/.plugin_secret_key`（32 字节随机、`mode 0600`、不存在时以 `wx` 独占创建）。插件只能通过
  broker 使用凭据（`secrets.digest` / `secrets.crypt` / `external.fetch` 的 `connection`），**读不到明文**。
- 入站 Webhook 令牌是 32 字节随机串，只存 sha256；校验时同时比对用户 `tokenVersion`、`isDisabled` 和
  webhook 声明体快照，任一变化即 `RESOURCE_FORBIDDEN`。

---

## 4. 网络出口

只讨论 `external.fetch`（`capture.importUrl` 走独立但同构的固定传输层）：

| 层 | 控制 |
| --- | --- |
| 协议 | 仅 `https:`；拒绝 URL 内嵌凭证、fragment、反斜杠、控制/零宽字符 |
| 目标 | 必须命中 `permissionConfig.externalFetchHosts` 的 `host:port`（默认 443）精确匹配 |
| DNS | 自解析 CNAME 链（≤16 层、每层唯一、无环）+ A/AAAA；解析结果**全部**必须是公网地址 |
| 连接固定 | 用自定义 `lookup` 把已校验 IP 钉给本次 TLS 连接，防止解析漂移/rebinding；`servername` 显式指定，`rejectUnauthorized: true` |
| 私网 | IPv4 按 18 个保留段黑名单；IPv6 按 IANA 分配表**正向白名单**，并额外排除 `2001::/23`、`2001:db8::/32`、`2002::/16`、`3fff::/20`、IPv4-mapped |
| 重定向 | 每跳重新走白名单 + DNS + IP 校验，最多 5 跳；跨源跳转剥离 `Authorization`/`Cookie`/`Proxy-Authorization` |
| 请求头 | 插件侧不能设 `Host`/`Content-Length`/`Connection`/`TE`/`Upgrade`/`Transfer-Encoding`/`proxy-*`/`x-forwarded-*`/`x-real-ip`/`cf-connecting-ip` 等（静默丢弃）；敏感头只能由 broker 经 `trustedHeaders` 注入 |
| 方法 | 拒绝 `CONNECT`/`TRACE` |
| 预算 | 总 deadline 10s、响应 ≤2 MiB，`Content-Length` 先判、无则流式累计 |
| 配额 | 每插件 60 次/分钟、600 次/小时、并发 4（进程内计数） |

---

## 5. 限额与配额汇总

| 维度 | 限额 | 超限错误 |
| --- | --- | --- |
| ZIP 压缩 / 解压 | 20 MiB / 50 MiB | 安装期中文报错 |
| 包内文件数 | 500 | 同上 |
| manifest.json | 128 KiB | 同上 |
| Action 入参 / 出参 | 256 KiB / 1 MiB | `PLUGIN_INPUT_TOO_LARGE` / `PLUGIN_OUTPUT_TOO_LARGE` |
| 执行超时 | interactive 10s、background 30s | `PLUGIN_TIMEOUT` |
| 进程堆 | `--max-old-space-size=128` | `PLUGIN_MEMORY_LIMIT` |
| 沙箱 Host 调用 | 1000 次/执行、32 并发 | `PLUGIN_PROTOCOL_LIMIT_EXCEEDED` |
| 外网请求 | 60/min、600/h、并发 4 | `PLUGIN_RATE_LIMITED` |
| 外网响应体 | 2 MiB | `EXTERNAL_FETCH_RESPONSE_TOO_LARGE` |
| 存储 value / key | 256 KiB / 200 B | `plugin storage value 超过 256KB` |
| Secret 长度 | 1–64 KiB | `Secret 必须在 1-64KB 之间` |
| Webhook body | manifest `maxBodyBytes` 1–262144 | 入站拒绝 |
| 日志尾 | 500 行 / 64 KiB，单行 4096 字符 | 自动丢弃最旧 |

---

## 6. 审计与可观测

- 执行日志按 `ExecutionLogTail` 保留尾部 500 行/64 KiB，写入前用
  `/(authorization|cookie|jwt|api[-_ ]?key|token|secret|password)\s*[:=]\s*\S+/` 做脱敏，单行截断 4096 字符。
- `external.fetch` 的**拒绝**路径写审计（`external_fetch_denied`，`level: warn`），字段包括 `pluginId`、
  `actionId`、`executionId`、`host`、`code`、`message`；`host` 只取 `new URL(url).host`，**不记录查询串**，
  避免把 token 写进审计。
- 注册表记录 `installedBy`、`installedAt`、`checksum`、`signatureState`、`advisoryState`、`lifecycleState`、
  `autoRollbackReason`，用于事后追溯一次安装/回滚的完整来源。
- 未覆盖：`notes.*` 等成功调用的细粒度审计依赖业务侧审计服务，插件模块本身只对网络拒绝与安装/更新状态留痕。

---

## 7. 威胁模型

### T1 数据外传（读笔记 → 发到外部服务器）

- 攻击面：`notes:read` / `diary:read` / `attachments:read` + `external:fetch`（或 `node-action` 直接出网）。
- 防护：权限逐项授权且必须全部显式确认；外网出口只允许 `externalFetchHosts` 精确声明的域名；更新时新增域名
  进入 `permissionDiff.addedHosts` 需重新确认；响应体与请求次数受限，难以批量渗出；拒绝事件写审计。
- 残留风险：`node-action` 可绕过 broker 直接出网；用户若主动授予 `notes:read` + 任意宽泛域名（如自家中转域名），
  宿主无法判断数据是否敏感。第三方中转域名一旦被声明，等于把"是否外传"的判断交给用户。

### T2 内网扫描 / SSRF

- 攻击面：用 `external.fetch` 打 `127.0.0.1`、`10.0.0.0/8`、`169.254.169.254`（云元数据）、
  或 `evil.com` → CNAME/A 记录指向内网。
- 防护：声明期拒绝 IP 字面量与 `localhost`/`.local`/`.internal` 等内网后缀；运行期对 DNS 结果做 CIDR 判定，
  任一地址非公网即整体拒绝；IP 与连接绑定（防 rebinding）；重定向逐跳重校验，无法用 302 跳到内网；
  端口按 `host:port` 精确匹配，默认 443。
- 残留风险：`node-action` 直接 `net.connect` 可完整扫描内网；声明期只做语法校验，`evil.com` 这类"合法域名解析到
  内网"的写法要靠运行期拦截，若 DNS 返回混合公网/内网地址会被整体拒绝（安全但可能误伤 CDN 场景）。

### T3 打满服务（资源耗尽 / 拒绝服务）

- 攻击面：死循环、单次返回超大对象、疯狂调用 Host API、大量并发外网请求、塞满存储。
- 防护：执行超时 10s/30s；`--max-old-space-size=128` 与 `PLUGIN_MEMORY_LIMIT` 映射；入参/出参字节上限；
  沙箱单次执行 Host 调用上限 1000、并发 32；外网 60/min、600/h、并发 4；存储单值 256 KiB；
  执行按排队串行化（`executionManager` 队列 + 版本/action schema 绑定校验）。
- 残留风险：配额是**进程内内存计数**，重启清零、多实例不共享；`node-action` 可 fork 子进程或开大量 socket 绕过
  进程级堆限制；超时只能杀掉插件子进程，无法回收已被写入的磁盘数据（存储/笔记体积受各 API 上限约束）。

### T4 供应链投毒（包被替换、注册表被劫持、更新夹带）

- 攻击面：下载包被中间人替换、注册表元数据回滚/伪造、正常插件在小版本更新里加权限或加代码。
- 防护：注册表元数据 Ed25519 签名 + `RegistryMetadataGuard` 的 `sequence` 单调 + `digest` 绑定 + `expiresAt`
  （过期即 `REGISTRY_METADATA_EXPIRED`，生成时间超前即 `REGISTRY_METADATA_FROM_FUTURE`）；
  官方源根公钥固定在 `official-registry-trust-roots.json`（`nowen-registry-root-2026`，有效期 2026-08-25 →
  2031-08-25，支持带 `parentKeyId` 的轮换）；包体 `sha256` 与版本坐标绑定（同坐标不同内容 →
  `PLUGIN_VERSION_COORDINATE_CONFLICT`）；更新走 staging → 校验 → 切换 → probation → 失败自动回滚；
  安全公告服务可强制下架（`enforceCriticalAdvisories`）；信任级 `official/verified/community/developer` 与
  审计字段一并入库。
- 残留风险：`community`/`developer` 级插件没有签名强制，仅靠 checksum；签名只覆盖"包字节 + 元数据"，不覆盖插件
  在运行时读取的第三方 CDN 内容（`node-action` 可自行拉取任意远程代码）；恢复备份的插件必须人工重新校验，
  自动化程度有限。

### T5 前端窃取 token（插件内容注入 / 声明式 XSS）

- 攻击面：`noteTemplates.body`、`promptPacks.prompt`、`uiComponents.label`、`sidebarPanels.cards` 等由插件提供的
  文本被前端渲染，若直接 `innerHTML` 即可窃取 localStorage/内存中的 JWT。
- 防护：`noteTemplates.body` 与 `promptPacks.prompt` 在 schema 层拒绝 `<script`/`<iframe`/`<object`、
  `javascript:`、`data:text/html`；`uiComponents` 只能声明 `navigation.open` 这类**枚举化动作**（没有任意脚本、
  没有自定义 URL），`allowedSlots` 仅 `floating-layer`；声明式插件禁止一切 JS 资源；`sidebarPanels` 的卡片只能
  是 `{title, description, link:{label,target}}`，`target` 是枚举。
- 残留风险：schema 只做**黑名单字符串匹配**，HTML 实体/编码变体、`<svg onload>`、`<img onerror>` 等不在正则内，
  最终安全依赖前端渲染时的转义与 sanitize；`node-action`/`sandbox-js` 的字段值（如 `output`、返回值）若被前端
  原样插入 DOM 同样存在此风险，需前端按不可信数据处理。

### T6 越权访问他人数据（IDOR / 横向移动）

- 攻击面：伪造 `userId`/`workspaceId`、猜 noteId、读别的工作区任务。
- 防护：授权主体来自服务端 `PluginExecutionContext`；每条查询都追加 `userId`/`workspaceId` 条件并经
  `allowedWorkspace()`/`hasRole()` 复核；存储 `scopeId` 由上下文推导；凭据按 `ownerUserId` 隔离。
- 残留风险：ACL 判定分散在各 Host 方法内部，新增方法若漏写 workspace 校验即形成缺口（无集中式策略层保证）；
  `node-action` 直接读 SQLite 文件可绕过全部 ACL——这要求部署侧保证插件子进程与数据文件同账号可读，
  也是当前架构最大的信任假设。

---

## 8. 给插件作者的安全底线

1. 能只读就不要写；能 `[]` 权限就不要申请权限。
2. 需要外网时只写**精确域名**（`*.example.com` 在运行时会被拒，见 `SPEC.md` §9）。
3. 不要把用户数据拼进 URL 查询串（审计不记录它，但中间代理会）。
4. 凭据只放在 `connections` + `secrets:use`，不要落盘到 `plugin-storage`。
5. 声明式能表达就别写代码；确实要写代码优先 `sandbox-js`，因为只有它是真隔离。
