// DSH 产物级补丁定义。
//
// 本项目不再克隆和编译 DSH 源码，而是安装上游发布在 npm 上的预构建包
// （@deepseek-ai/dsh 及其依赖）。发布产物是未压缩、带 region 注释的 bundle，
// 所以历史上对 TypeScript 源码打的补丁在这里改成对产物做精确文本替换。
//
// 每个条目的语义（见 bin/apply-dsh-artifact-patches.mjs）：
//   marker  已生效的标记；命中即认为这条补丁打过了，可安全重入。
//   find    必须在目标文件中命中且只命中一次。
//   replace 替换文本；必须包含 marker。
//   alternatives 旧产物形状的同类替换；所有形状合计必须只命中一次。
//   upstream 共享 helper 的已实现分支；依赖补丁成功且 marker 命中才可跳过独立替换。
// marker 和 find 都不命中时直接失败退出——上游改了产物形状必须被人看见，
// 绝不静默跳过。
// optional=true 的条目表示上游可能已经内置该行为，或在新版中移除了目标包；
// 未命中时只告警，不阻断安装。容器环境仍依赖的安全/持久化补丁保持必需。
export const artifactPatches = [
  {
    id: "sandbox-escalation-self-mode",
    package: "@deepseek-ai/dsh-sandbox",
    file: "lib/index.js",
    why: "容器内 DSH 以 danger-full-access 运行；请求与当前模式相同时不应被判为“不够宽”而抛错。",
    marker: `if (mode === effectiveMode) return effectiveMode;`,
    find: `const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (!(WIDER_MODES[effectiveMode]`,
    replace: `const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;
	if (!(WIDER_MODES[effectiveMode]`,
  },
  {
    id: "sandbox-escalation-justification",
    package: "@deepseek-ai/dsh-sandbox",
    file: "lib/index.js",
    why: "danger-full-access 下工具调用可以不带 justification，避免空理由被拒。",
    marker: `&& sandboxPermissions !== "danger-full-access")`,
    find: `if (justification !== void 0 && justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");`,
    replace: `if (justification !== void 0 && justification.trim().length === 0 && sandboxPermissions !== "danger-full-access") throw new Error("invalid justification: expected a non-empty sentence");`,
  },
  {
    id: "sandbox-writable-roots-data",
    package: "@deepseek-ai/dsh-sandbox",
    file: "lib/index.js",
    why: "workspace-write 必须允许持久化 /data；0.2.2 的共享根派生覆盖 fs、bwrap 和 Landlock，并保留额外根校验。",
    marker: `return [...new Set([canonicalPath(policy.workspaceRoot), canonicalPath("/data"), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)])];`,
    find: `return [...new Set([canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)])];`,
    replace: `return [...new Set([canonicalPath(policy.workspaceRoot), canonicalPath("/data"), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)])];`,
    alternatives: [{
      marker: `"/data",
		"/tmp",`,
      find: `return [...new Set([
		policy.workspaceRoot,
		"/tmp",
		tmpdir()
	].map(canonicalPath))];`,
      replace: `return [...new Set([
		policy.workspaceRoot,
		"/data",
		"/tmp",
		tmpdir()
	].map(canonicalPath))];`,
    }],
  },
  {
    id: "sandbox-local-bwrap-data",
    package: "@deepseek-ai/dsh-sandbox-local",
    file: "lib/index.js",
    why: "旧版 bwrap 需要单独绑定 /data；0.2.2 使用已打补丁的共享 workspaceWritableRoots。",
    upstream: {
      marker: `for (const root of workspaceWritableRoots(policy)) args.push("--bind", root, root);`,
      requires: "sandbox-writable-roots-data",
    },
    marker: `args.push("--bind", "/data", "/data");`,
    find: `args.push("--tmpfs", "/tmp");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);`,
    replace: `args.push("--tmpfs", "/tmp");
		args.push("--bind", "/data", "/data");
		args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);`,
  },
  {
    id: "sandbox-local-landlock-data",
    package: "@deepseek-ai/dsh-sandbox-local",
    file: "lib/index.js",
    why: "旧版 Landlock 需要单独授权 /data；0.2.2 使用已打补丁的共享 workspaceWritableRoots。",
    upstream: {
      marker: `if (policy.mode === "workspace-write") readWrite.push("/tmp", ...workspaceWritableRoots(policy));`,
      requires: "sandbox-writable-roots-data",
    },
    marker: `readWrite.push("/tmp", "/data", policy.workspaceRoot)`,
    find: `if (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);`,
    replace: `if (policy.mode === "workspace-write") readWrite.push("/tmp", "/data", policy.workspaceRoot);`,
  },
  {
    id: "deepseek-api-key-request-headers-config",
    package: "@deepseek-ai/dsh-llm-deepseek-api-key",
    file: "lib/index.js",
    why: "第一方 DeepSeek 需要显式请求头支持，才能向多用户密钥代理传递实例身份。",
    marker: `headersBaseURL: z.string().default("").volatile()`,
    find: `apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile()`,
    replace: `apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile(),
	headers: z.dict(z.string()).default({}).volatile(),
	headersBaseURL: z.string().default("").volatile()`,
  },
  {
    id: "deepseek-api-key-request-headers-options",
    package: "@deepseek-ai/dsh-llm-deepseek-api-key",
    file: "lib/index.js",
    why: "每次解析当前配置时读取 volatile 请求头与身份头目标，不缓存旧令牌。",
    marker: `headersBaseURL: config.headersBaseURL.get()`,
    find: `apiKeyEnv: config.apiKeyEnv.get()`,
    replace: `apiKeyEnv: config.apiKeyEnv.get(),
		headers: config.headers.get(),
		headersBaseURL: config.headersBaseURL.get()`,
  },
  {
    id: "deepseek-api-key-request-headers-connection",
    package: "@deepseek-ai/dsh-llm-deepseek-api-key",
    file: "lib/index.js",
    why: "保留解析后的请求头；实例身份头只发送到种子配置绑定的完整代理路由，改成直连地址时剥离。",
    marker: `const extraHeaders = new Headers(headers);`,
    find: `function resolveAdapterOptions(config, environment) {
	const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, apiKeyEnv, ...messages } = config;
	const timing = resolveListingTiming(config, "llm-deepseek-api-key");
	const connection = resolveAdapterOptions$1(messages, environment);
	const listed = new URL(connection.baseURL).origin === OFFICIAL_ORIGIN && isBuiltInCatalog(connection.models);
	return {
		...connection,
		apiKeyEnv: credentialRef(apiKeyEnv ?? "DEEPSEEK_API_KEY"),`,
    replace: String.raw`function resolveAdapterOptions(config, environment) {
	const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, apiKeyEnv, headers = {}, headersBaseURL = "", ...messages } = config;
	const timing = resolveListingTiming(config, "llm-deepseek-api-key");
	const connection = resolveAdapterOptions$1(messages, environment);
	const extraHeaders = new Headers(headers);
	if (extraHeaders.has("x-dsh-instance-token") && connection.baseURL.replace(/\/+$/, "") !== String(headersBaseURL).replace(/\/+$/, "")) extraHeaders.delete("x-dsh-instance-token");
	const listed = new URL(connection.baseURL).origin === OFFICIAL_ORIGIN && isBuiltInCatalog(connection.models);
	return {
		...connection,
		headers: Object.fromEntries(extraHeaders),
		apiKeyEnv: credentialRef(apiKeyEnv ?? "DEEPSEEK_API_KEY"),`,
  },
  {
    id: "deepseek-api-key-request-headers-auth",
    package: "@deepseek-ai/dsh-llm-deepseek-api-key",
    file: "lib/index.js",
    why: "Messages 与 Files 共用请求头；规范化后固定 x-api-key，不允许大小写变体覆盖凭据。",
    marker: `headers.set("x-api-key", await resolveApiKey(connection));`,
    find: `resolveAuth: async (connection) => ({ headers: { "x-api-key": await resolveApiKey(connection) } }),`,
    replace: `resolveAuth: async (connection) => {
			const headers = new Headers(connection.headers);
			headers.set("x-api-key", await resolveApiKey(connection));
			return { headers: Object.fromEntries(headers) };
		},`,
  },
  {
    id: "app-boot-realpath-import",
    optional: true,
    package: "@deepseek-ai/dsh-app-boot",
    file: "lib/index.js",
    why: "配合下一处补丁引入 realpathSync。",
    marker: `readlinkSync, realpathSync, symlinkSync`,
    find: `readlinkSync, symlinkSync`,
    replace: `readlinkSync, realpathSync, symlinkSync`,
  },
  {
    id: "app-boot-realpath-package-dir",
    optional: true,
    package: "@deepseek-ai/dsh-app-boot",
    file: "lib/index.js",
    why: "profile 的 node_modules 是软链；返回真实路径才能保证同一包只有一个模块实例。",
    marker: `return realpathSync(candidate);`,
    find: `function packageDirFromAnchor(anchor, packageName) {
	/* v8 ignore next */
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json"))) return candidate;
	}
}`,
    replace: `function packageDirFromAnchor(anchor, packageName) {
	/* v8 ignore next */
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
	}
}`,
  },
  {
    id: "public-local-mode",
    optional: true,
    package: "@deepseek-ai/dsh-client-connection",
    file: "lib/client.js",
    why: "已鉴权的反代注入 DSH_PUBLIC_LOCAL_MODE cookie 后，浏览器按 loopback 对待，Host 设置页才可用。",
    marker: `DSH_PUBLIC_LOCAL_MODE=1`,
    find: `isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`,
    replace: `isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || (typeof document !== "undefined" && document.cookie.split(";").some((entry) => entry.trim() === "DSH_PUBLIC_LOCAL_MODE=1")),`,
  },
  {
    id: "workspace-model-delete-rpc",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "修复旧关联补丁遗漏的 Workspace 删除 RPC，兼容已打过补丁的产物。",
    marker: `\t\t\tasync delete(workspaceId) {\n\t\t\t\tconst result = await this.remote.delete({ workspaceId });`,
    find: `\t\t\tasync delete(workspaceId) {\n\t\t\t\tif (result.ok) this.remove(workspaceId, true);`,
    replace: `\t\t\tasync delete(workspaceId) {\n\t\t\t\tconst result = await this.remote.delete({ workspaceId });\n\t\t\t\tif (result.ok) this.remove(workspaceId, true);`,
  },
  {
    id: "workspace-model-pending-attachments-field",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "新版 Workspace controller 中保留 session.create 已确认但尚未出现在 Host 快照的关联。",
    marker: `pendingSessionAttachments = /* @__PURE__ */ new Map();`,
    find: `\t\t\tremovedIds = /* @__PURE__ */ new Set();\n\t\t\tlisteners = /* @__PURE__ */ new Set();`,
    replace: `\t\t\tremovedIds = /* @__PURE__ */ new Set();\n\t\t\tpendingSessionAttachments = /* @__PURE__ */ new Map();\n\t\t\tlisteners = /* @__PURE__ */ new Set();`,
  },
  {
    id: "workspace-model-pending-attachments-note",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "新版 Workspace controller 在 session.create 成功后立即发布待确认归属。",
    marker: `noteSessionAttachment(workspaceId, sessionId) {`,
    find: `\t\t\tasync delete(workspaceId) {\n\t\t\t\tconst result = await this.remote.delete({ workspaceId });`,
    replace: `\t\t\tnoteSessionAttachment(workspaceId, sessionId) {\n\t\t\t\tif (this.removedIds.has(workspaceId)) return;\n\t\t\t\tconst index = this.items.findIndex((item) => item.workspaceId === workspaceId);\n\t\t\t\tconst workspace = this.items[index];\n\t\t\t\tif (workspace === void 0 || workspace.sessionIds.includes(sessionId)) return;\n\t\t\t\tconst pending = this.pendingSessionAttachments.get(workspaceId) ?? [];\n\t\t\t\tif (!pending.includes(sessionId)) this.pendingSessionAttachments.set(workspaceId, [sessionId, ...pending]);\n\t\t\t\tthis.items = this.items.map((item, position) => position === index ? { ...item, sessionIds: [sessionId, ...item.sessionIds] } : item);\n\t\t\t\tthis.invalidate();\n\t\t\t}\n\t\t\tasync delete(workspaceId) {\n\t\t\t\tconst result = await this.remote.delete({ workspaceId });`,
  },
  {
    id: "workspace-model-pending-attachments-reconcile",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "Host 确认前保留新会话关联，确认后移除叠加状态并遵循 Host 顺序。",
    marker: `mergePendingSessionAttachments(view) {`,
    find: `\t\t\tupsert(view) {
\t\t\t\tif (this.removedIds.has(view.workspaceId)) return;
\t\t\t\tconst index = this.items.findIndex((item) => item.workspaceId === view.workspaceId);
\t\t\t\tconst installed = this.items[index];
\t\t\t\tif (installed !== void 0 && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return;`,
    replace: `\t\t\tmergePendingSessionAttachments(view) {
\t\t\t\tconst pending = this.pendingSessionAttachments.get(view.workspaceId);
\t\t\t\tif (pending === void 0) return view;
\t\t\t\tconst remaining = pending.filter((sessionId) => !view.sessionIds.includes(sessionId));
\t\t\t\tif (remaining.length === 0) this.pendingSessionAttachments.delete(view.workspaceId);
\t\t\t\telse this.pendingSessionAttachments.set(view.workspaceId, remaining);
\t\t\t\treturn remaining.length === 0 ? view : { ...view, sessionIds: [...remaining, ...view.sessionIds] };
\t\t\t}
\t\t\tupsert(view) {
\t\t\t\tif (this.removedIds.has(view.workspaceId)) return;
\t\t\t\tconst index = this.items.findIndex((item) => item.workspaceId === view.workspaceId);
\t\t\t\tconst installed = this.items[index];
\t\t\t\tif (installed !== void 0 && Date.parse(view.updatedAt) < Date.parse(installed.updatedAt)) return;
\t\t\t\tview = this.mergePendingSessionAttachments(view);`,
  },
  {
    id: "workspace-model-pending-attachments-baseline",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "重连快照保留未确认关联，并清理已经不在 Workspace 基线中的状态。",
    marker: `installed.set(view.workspaceId, this.mergePendingSessionAttachments(view));`,
    find: `\t\t\t\tfor (const view of views) if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, view);
\t\t\t\tthis.items = [...installed.values()];`,
    replace: `\t\t\t\tfor (const view of views) if (!this.removedIds.has(view.workspaceId)) installed.set(view.workspaceId, this.mergePendingSessionAttachments(view));
\t\t\t\tfor (const workspaceId of this.pendingSessionAttachments.keys()) if (!installed.has(workspaceId)) this.pendingSessionAttachments.delete(workspaceId);
\t\t\t\tthis.items = [...installed.values()];`,
  },
  {
    id: "workspace-model-pending-attachments-remove",
    package: "@deepseek-ai/dsh-api-workspace-controller",
    file: "lib/client.js",
    why: "Workspace 移除时清理待确认关联，保留原有删除墓碑与同步通知。",
    marker: `this.removedIds.add(workspaceId);\n\t\t\t\tthis.pendingSessionAttachments.delete(workspaceId);`,
    find: `\t\t\tremove(workspaceId, immediate = false) {
\t\t\t\tthis.removedIds.add(workspaceId);`,
    replace: `\t\t\tremove(workspaceId, immediate = false) {
\t\t\t\tthis.removedIds.add(workspaceId);
\t\t\t\tthis.pendingSessionAttachments.delete(workspaceId);`,
  },
  {
    id: "workspace-model-pending-attachments-create",
    package: "@deepseek-ai/dsh-client-ui-workspace",
    file: "lib/client.js",
    why: "UI workspace 在 session.create 成功后通知 Workspace model；0.2.1 的创建路径收敛到 createNamed。",
    marker: `this.workspaces.list.noteSessionAttachment(request.workspaceId, sessionId);`,
    find: `\t\t\tasync createNamed(request) {\n\t\t\t\tconst sessionId = await this.sessions.create(request);`,
    replace: `\t\t\tasync createNamed(request) {\n\t\t\t\tconst sessionId = await this.sessions.create(request);\n\t\t\t\tthis.workspaces.list.noteSessionAttachment(request.workspaceId, sessionId);`,
  },
  {
    id: "public-local-mode-transport-owner",
    package: "@deepseek-ai/dsh-client-connection",
    file: "lib/client.browser.js",
    why: "反代注入 DSH_PUBLIC_LOCAL_MODE cookie 后，按 transport 所有权逻辑继续视为本地访问；0.2.1 把 client.js 拆成 browser 与 node 两条件，界面取 browser。",
    marker: `DSH_PUBLIC_LOCAL_MODE=1`,
    find: `isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`,
    replace: `isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || (typeof document !== "undefined" && document.cookie.split(";").some((entry) => entry.trim() === "DSH_PUBLIC_LOCAL_MODE=1")),`,
  },
  {
    id: "trusted-proxy-auto-browser-auth",
    package: "@deepseek-ai/dsh-client-connection",
    file: "lib/index.js",
    why: "外层（Cloudflare Access / VPN / Basic Auth / local）已经完成认证时，由项目反代断言「这个请求已被放行」，DSH 据此在自己的响应里种下浏览器会话 cookie，免除人工取 token。",
    // 种 cookie 只能落在拒绝路径上。
    //
    // 这条路上的 res 不是 Node 的 ServerResponse，而是
    // @deepseek-ai/dsh-host-frontend-static 造的最小 shim，只有
    // writeHead(status, headers) 与 end(text)。authorizeIndex 返回 true 时，
    // 调用方用自己的 { "content-type": ... } 发首页，shim 上写过的头全部丢弃；
    // setHeader 在 shim 上不存在，直接调用会抛异常。
    //
    // 因此形态与上游 ?token= 一致：writeHead(303, { location: "./", set-cookie })
    // + end() + return false。差别只在凭证来源是请求头而非查询串，
    // 303 的作用是让浏览器带着刚种下的 cookie 重发一次首页请求。
    //
    // cookie 用上游自己的 sessionCookie()，保留 SameSite=Strict 与 Secure
    // 跟随监听协议的语义；响应带 no-store，种 cookie 的 303 不进任何缓存。
    //
    // 签名跟随上游：requestAuthority(headers) 已改为
    // requestAudience(headers, secure)（secure 时返回带 scheme 的 origin，
    // 否则 host），isAuthenticated 与 sessionCookie 都多了 secure 参数。
    //
    // 取值必须走产物自带的 header(headers, name)：这条路径传进来的 req 是
    // Fetch 风格 Request，headers 是 Headers 实例，按对象下标取值恒为
    // undefined，分支永不成立。
    // marker 取这段拒绝路径独有的收尾：上游 token 流程虽然也是 writeHead(303,
    // { location: "./", set-cookie })，但后面直接 return false，不跟
    // 「} } if (tokens.length > 0) {」。旧补丁形态（setHeader + return true）
    // 也不匹配，因此会被 alternatives 修好而不是误判为「已生效」。
    marker: `res.end();\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}\n\t\tif (tokens.length > 0) {`,
    find: `\t\tconst tokens = url.searchParams.getAll(TOKEN_QUERY);\n\t\tif (tokens.length > 0) {`,
    replace: `\t\tconst tokens = url.searchParams.getAll(TOKEN_QUERY);\n\t\tif (tokens.length === 0 && req.method === "GET" && url.pathname === "/" && header(req.headers, "x-dsh-trusted-proxy") === "1" && !this.isAuthenticated(req, secure)) {\n\t\t\tconst authority = requestAudience(req.headers, secure);\n\t\t\tif (authority !== void 0) {\n\t\t\t\tconst issuedAt = Date.now();\n\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;\n\t\t\t\tconst value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret);\n\t\t\t\tres.writeHead(303, {\n\t\t\t\t\t"cache-control": "no-store",\n\t\t\t\t\t"location": "./",\n\t\t\t\t\t"referrer-policy": "no-referrer",\n\t\t\t\t\t"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3), secure)\n\t\t\t\t});\n\t\t\t\tres.end();\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}\n\t\tif (tokens.length > 0) {`,
    alternatives: [{
      marker: `res.end();\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}\n\t\tif (tokens.length > 0) {`,
      find: `\t\tif (tokens.length === 0 && req.method === "GET" && url.pathname === "/" && header(req.headers, "x-dsh-trusted-proxy") === "1" && !this.isAuthenticated(req, secure)) {\n\t\t\tconst authority = requestAudience(req.headers, secure);\n\t\t\tif (authority !== void 0) {\n\t\t\t\tconst issuedAt = Date.now();\n\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;\n\t\t\t\tconst value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret);\n\t\t\t\tres.setHeader("set-cookie", sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3), secure));\n\t\t\t\tres.setHeader("cache-control", "no-store");\n\t\t\t\treturn true;\n\t\t\t}\n\t\t}`,
      replace: `\t\tif (tokens.length === 0 && req.method === "GET" && url.pathname === "/" && header(req.headers, "x-dsh-trusted-proxy") === "1" && !this.isAuthenticated(req, secure)) {\n\t\t\tconst authority = requestAudience(req.headers, secure);\n\t\t\tif (authority !== void 0) {\n\t\t\t\tconst issuedAt = Date.now();\n\t\t\t\tconst expiresAt = issuedAt + this.maxAgeMilliseconds;\n\t\t\t\tconst value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret);\n\t\t\t\tres.writeHead(303, {\n\t\t\t\t\t"cache-control": "no-store",\n\t\t\t\t\t"location": "./",\n\t\t\t\t\t"referrer-policy": "no-referrer",\n\t\t\t\t\t"set-cookie": sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1e3), secure)\n\t\t\t\t});\n\t\t\t\tres.end();\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}`,
    }],
  },
]
