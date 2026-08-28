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
// marker 和 find 都不命中时直接失败退出——上游改了产物形状必须被人看见，
// 绝不静默跳过。
export const artifactPatches = [
  {
    id: "sandbox-escalation-self-mode",
    package: "@deepseek-ai/dsh-sandbox",
    file: "lib/index.js",
    why: "容器内 DSH 以 danger-full-access 运行；请求与当前模式相同时不应被判为“不够宽”而抛错。",
    marker: `if (effectiveMode === mode) return mode;`,
    find: `const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (!(WIDER_MODES[effectiveMode]`,
    replace: `const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (effectiveMode === mode) return mode;
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
    why: "/data 是容器的持久挂载根，workspace-write 必须允许写入。",
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
  },
  {
    id: "sandbox-local-bwrap-data",
    package: "@deepseek-ai/dsh-sandbox-local",
    file: "lib/index.js",
    why: "bwrap 沙箱同样要绑定 /data，否则持久数据在沙箱内不可写。",
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
    why: "Landlock 授权同样要包含 /data。",
    marker: `readWrite.push("/tmp", "/data", policy.workspaceRoot)`,
    find: `if (policy.mode === "workspace-write") readWrite.push("/tmp", policy.workspaceRoot);`,
    replace: `if (policy.mode === "workspace-write") readWrite.push("/tmp", "/data", policy.workspaceRoot);`,
  },
  {
    id: "app-boot-realpath-import",
    package: "@deepseek-ai/dsh-app-boot",
    file: "lib/index.js",
    why: "配合下一处补丁引入 realpathSync。",
    marker: `readlinkSync, realpathSync, symlinkSync`,
    find: `readlinkSync, symlinkSync`,
    replace: `readlinkSync, realpathSync, symlinkSync`,
  },
  {
    id: "app-boot-realpath-package-dir",
    package: "@deepseek-ai/dsh-app-boot",
    file: "lib/index.js",
    why: "profile 的 node_modules 是软链；返回真实路径才能保证同一包只有一个模块实例。",
    marker: `return realpathSync(candidate);`,
    find: `if (existsSync(join(candidate, "package.json"))) return candidate;`,
    replace: `if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);`,
  },
  {
    id: "public-local-mode",
    package: "@deepseek-ai/dsh-client-connection",
    file: "lib/client.js",
    why: "已鉴权的反代注入 DSH_PUBLIC_LOCAL_MODE cookie 后，浏览器按 loopback 对待，Host 设置页才可用。",
    marker: `DSH_PUBLIC_LOCAL_MODE=1`,
    find: `isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),`,
    replace: `isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || (typeof document !== "undefined" && document.cookie.split(";").some((entry) => entry.trim() === "DSH_PUBLIC_LOCAL_MODE=1")),`,
  },
  {
    id: "workspace-pending-attachments-field",
    package: "@deepseek-ai/dsh-client-runtime",
    file: "lib/client.js",
    why: "记录已被 session.create 响应证实、但 Host 快照尚未确认的会话归属。",
    marker: `pendingSessionAttachments = /* @__PURE__ */ new Map();`,
    find: `			removedIds = /* @__PURE__ */ new Set();
			snapshotCache;`,
    replace: `			removedIds = /* @__PURE__ */ new Set();
			/**
			* Session attachments proven by a successful session.create response but
			* not yet confirmed by a Host Workspace snapshot. Response and stream
			* delivery are independent, so an older frame must not hide committed
			* membership while the confirming frame is still in flight.
			*/
			pendingSessionAttachments = /* @__PURE__ */ new Map();
			snapshotCache;`,
  },
  {
    id: "workspace-pending-attachments-methods",
    package: "@deepseek-ai/dsh-client-runtime",
    file: "lib/client.js",
    why: "响应与事件流是两条独立通道；旧快照不得把已提交的会话归属抹掉。",
    marker: `noteSessionAttachment(workspaceId, sessionId) {`,
    find: `			/** Upsert one Host view, optionally retaining the local object that materialized it. */
			upsert(view, identity) {
				if (this.removedIds.has(view.workspaceId)) return;`,
    replace: `			/**
			* Publish a session.create attachment proven by its successful response.
			* The matching Host Workspace snapshot later confirms and retires this
			* response-side echo; older snapshots retain it in the meantime.
			*/
			noteSessionAttachment(workspaceId, sessionId) {
				if (this.removedIds.has(workspaceId)) return;
				const index = this.items.findIndex((item) => item.getSnapshot().view?.workspaceId === workspaceId);
				const workspace = this.items[index];
				if (workspace === void 0) return;
				const view = workspace.getSnapshot().view;
				if (view === void 0 || view.sessionIds.includes(sessionId)) return;
				const pending = this.pendingSessionAttachments.get(workspaceId) ?? [];
				if (!pending.includes(sessionId)) this.pendingSessionAttachments.set(workspaceId, [sessionId, ...pending]);
				workspace.adopt(this.withPendingSessionAttachments(view));
				this.items = [...this.items];
				this.notifier.notifyNow();
			}
			/** Overlay response-confirmed attachments without consuming their pending confirmation. */
			withPendingSessionAttachments(view) {
				const pending = this.pendingSessionAttachments.get(view.workspaceId);
				if (pending === void 0) return view;
				const missing = pending.filter((sessionId) => !view.sessionIds.includes(sessionId));
				return missing.length === 0 ? view : {
					...view,
					sessionIds: [...missing, ...view.sessionIds]
				};
			}
			/** Confirm attachments present in a Host snapshot and overlay any still awaiting confirmation. */
			reconcilePendingSessionAttachments(view) {
				const pending = this.pendingSessionAttachments.get(view.workspaceId);
				if (pending === void 0) return view;
				const remaining = pending.filter((sessionId) => !view.sessionIds.includes(sessionId));
				if (remaining.length === 0) this.pendingSessionAttachments.delete(view.workspaceId);
				else this.pendingSessionAttachments.set(view.workspaceId, remaining);
				return remaining.length === 0 ? view : {
					...view,
					sessionIds: [...remaining, ...view.sessionIds]
				};
			}
			/** Upsert one Host view, optionally retaining the local object that materialized it. */
			upsert(view, identity) {
				if (this.removedIds.has(view.workspaceId)) return;
				view = this.reconcilePendingSessionAttachments(view);`,
  },
  {
    id: "workspace-pending-attachments-remove",
    package: "@deepseek-ai/dsh-client-runtime",
    file: "lib/client.js",
    why: "工作区被删除时一并丢弃其待确认归属。",
    marker: `this.pendingSessionAttachments.delete(workspaceId);`,
    find: `				this.removedIds.add(workspaceId);
				this.committedOrder = this.committedOrder.filter((id) => id !== workspaceId);`,
    replace: `				this.removedIds.add(workspaceId);
				this.pendingSessionAttachments.delete(workspaceId);
				this.committedOrder = this.committedOrder.filter((id) => id !== workspaceId);`,
  },
  {
    id: "workspace-pending-attachments-install-views",
    package: "@deepseek-ai/dsh-client-runtime",
    file: "lib/client.js",
    why: "list 基线同样要叠加待确认归属。",
    marker: `const view = this.reconcilePendingSessionAttachments(hostView);`,
    find: `				const installed = /* @__PURE__ */ new Map();
				for (const view of views) {
					const duplicate = installed.get(view.workspaceId);`,
    replace: `				const installed = /* @__PURE__ */ new Map();
				for (const hostView of views) {
					const view = this.reconcilePendingSessionAttachments(hostView);
					const duplicate = installed.get(view.workspaceId);`,
  },
  {
    id: "workspace-note-attachment-on-create",
    package: "@deepseek-ai/dsh-client-runtime",
    file: "lib/client.js",
    why: "session.create 成功后立刻发布归属，不等 Host 帧。",
    marker: `this.manager.noteSessionAttachment(workspaceId, sessionId);`,
    find: `				const attempt = this.sessions.create({ workspaceId }).finally(() => {
					this.connecting.delete(workspaceId);
				});`,
    replace: `				const attempt = this.sessions.create({ workspaceId }).then((sessionId) => {
					this.manager.noteSessionAttachment(workspaceId, sessionId);
					return sessionId;
				}).finally(() => {
					this.connecting.delete(workspaceId);
				});`,
  },
]
