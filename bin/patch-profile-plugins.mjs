import fs from 'node:fs'
import path from 'node:path'

// 对 profile 里第三方插件打的兼容补丁。两个地方会跑它：supervisor 在每次拉起 DSH
// 之前跑一遍（bin/dsh-supervisor 的 prepare_dsh），bin/watch-profile-plugins.mjs 在
// 插件目录发生变化后也跑一遍。后者是必要的：dsh-market 的 hot-mount 安装完全不重启
// 进程，只靠"启动前那一次"会整段漏掉。因此这里必须幂等、必须能重入。
//
// 每条补丁的结论会写进 DSH_PROFILE_PATCH_REPORT，由 verify-dsh-hardening 读出来报警。
// 这不是装饰：dsh-market 把 fetch("/dsh-market/update", …) 改成
// fetch(api("/dsh-market/update"), …) 之后，写死形状的锚点静默失配了很久，而唯一的
// 线索只是一行没人会去看的 stderr。

const root = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const reportFile = process.env.DSH_PROFILE_PATCH_REPORT ?? '/run/dsh-state/profile-patches.json'

const visionClientFile = `${root}/node_modules/dsh-vision-router/lib/client.js`
const visionPermissionFile = `${root}/node_modules/dsh-vision-router/lib/local-remote-settings-permission.js`
const marketClientFile = `${root}/node_modules/dshmarket/client/client.js`
const marketHttpFile = `${root}/node_modules/dshmarket/lib/http.js`
const marketPatchFile = `${root}/node_modules/dshmarket/cordis.patch.yml`

const clientBefore = "const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS, ...LOCAL_TOGGLE_KEYS, ...PRIVACY_TOGGLE_KEYS]"
const clientAfter = "const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS, ...LOCAL_TOGGLE_KEYS, ...PRIVACY_TOGGLE_KEYS, 'allowRemoteSettings']"

// 市场在「没识别出 supervisor」时给的重启指引是「关闭当前 dsh 进程后重新运行（例如
// dsh web）」—— 在本容器里这句话本身就是制造故障的命令：手起的 dsh 不是 Supervisor
// 的孩子，它会占住 3081，而 Supervisor 的孩子每次都撞 EADDRINUSE。改成指向本工程真正
// 的重启入口。中英两份要么一起改要么都不改，只改一半会让提示自相矛盾。
const marketRestartHintBefore = 'restartHint: "重启方式：关闭当前 dsh 进程后重新运行（例如 dsh web）"'
const marketRestartHintAfter = 'restartHint: "重启方式：点设置页里的「重启 DSH」按钮，或在宿主机执行 docker restart dsh"'
const marketRestartHintEnBefore = 'restartHint: "To restart: stop the current dsh process and run it again (e.g. dsh web)"'
const marketRestartHintEnAfter = 'restartHint: "To restart: use the Restart DSH button in Settings, or run docker restart dsh on the host"'

const permissionBefore = `      var next = effective;
      var value = effective.value;
      if (value && typeof value === 'object' && !Array.isArray(value)
          && Object.prototype.hasOwnProperty.call(value, FIELD)
          && typeof value[FIELD] === 'boolean') {
        value = Object.assign({}, value, { [FIELD]: value[FIELD] ? 'true' : '' });
        next = Object.assign({}, next, { value: value });
      }
      var user = effective.user;
      if (user && typeof user === 'object' && !Array.isArray(user)
          && Object.prototype.hasOwnProperty.call(user, FIELD)
          && typeof user[FIELD] === 'boolean') {
        user = Object.assign({}, user, { [FIELD]: user[FIELD] ? 'true' : 'false' });
        next = Object.assign({}, next, { user: user });
      }

      cachedRawSnapshot = snapshot;`
const permissionAfter = `      var next = effective;

      cachedRawSnapshot = snapshot;`

// state 只有四种：applied（这一次改了）、current（已经是补过的）、absent（插件没装）、
// unrecognized（插件装了但认不出形状——唯一需要人来看的一种）。
const report = []

function record(id, state, detail) {
  report.push({ id, state, detail })
}

function writeReport() {
  const payload = {
    generatedAt: new Date().toISOString(),
    profileRoot: root,
    patches: report,
    unrecognized: report.filter((entry) => entry.state === 'unrecognized').map((entry) => entry.id),
  }
  // 报告写不出去绝不能影响启动：/run/dsh-state 在某些排查场景下可能不存在。
  try {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    const temporary = `${reportFile}.tmp.${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(temporary, reportFile)
  } catch {}
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

function replaceExactly(source, before, after) {
  const first = source.indexOf(before)
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) return undefined
  return source.slice(0, first) + after + source.slice(first + before.length)
}

// dsh-market 的 client bundle 里这一行的形状变过：先是 fetch("/dsh-market/update", …)，
// 1.35.0 起是 fetch(api("/dsh-market/update"), …)。写死任一种都会在下次改版时静默失配，
// 所以只认"同一行上先有 return fetch( 再有那个路径字面量"这个更稳定的形状。
function findUpdateFetch(source, from) {
  const marker = '"/dsh-market/update"'
  let index = source.indexOf(marker, from)
  while (index !== -1) {
    const lineStart = source.lastIndexOf('\n', index) + 1
    const call = source.slice(lineStart, index).lastIndexOf('return fetch(')
    if (call !== -1) return lineStart + call
    index = source.indexOf(marker, index + marker.length)
  }
  return -1
}

function patchMarketUpdateResponse(source) {
  const doUpdate = source.indexOf('const doUpdate =')
  if (doUpdate === -1) return undefined
  const fetchStart = findUpdateFetch(source, doUpdate)
  if (fetchStart === -1) return undefined

  const parseStart = source.indexOf('}).then((res) => res.json().then((body) => ({', fetchStart)
  const parseEndToken = '}))).then(({ status, body }) => {'
  const parseEnd = parseStart === -1 ? -1 : source.indexOf(parseEndToken, parseStart)
  if (parseStart === -1 || parseEnd === -1) return undefined

  const replacement = `}).then(async (res) => {
\t\t\t\t\tconst contentType = (res.headers.get("content-type") || "").toLowerCase();
\t\t\t\t\tconst raw = await res.text();
\t\t\t\t\tlet body;
\t\t\t\t\tif (contentType.includes("json")) {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tconst parsed = JSON.parse(raw);
\t\t\t\t\t\t\tif (parsed !== null && typeof parsed === "object") body = parsed;
\t\t\t\t\t\t} catch {}
\t\t\t\t\t}
\t\t\t\t\tif (body === undefined) {
\t\t\t\t\t\tconst html = /<!doctype\\s+html|<html[\\s>]/i.test(raw);
\t\t\t\t\t\tconst error = res.status === 502
\t\t\t\t\t\t\t? "网关返回了 HTML 错误页（HTTP 502）。请确认 DSH 容器正常运行后重试。 / The gateway returned an HTML 502 page; verify that DSH is running and retry."
\t\t\t\t\t\t\t: res.redirected || html
\t\t\t\t\t\t\t\t? "公网认证会话已失效或返回了 HTML 页面，请重新登录后重试。 / The public authentication session expired or returned HTML; sign in again and retry."
\t\t\t\t\t\t\t\t: "市场接口返回了非 JSON 响应（HTTP " + String(res.status) + "）。请稍后重试。 / The market endpoint returned a non-JSON response; retry later.";
\t\t\t\t\t\tbody = { error };
\t\t\t\t\t}
\t\t\t\t\treturn { status: res.status, body };
\t\t\t\t}).then(({ status, body }) => {`

  return source.slice(0, parseStart) + replacement + source.slice(parseEnd + parseEndToken.length)
}

function patchMarketApplicationStatus(source) {
  const before = `export function sendJson(response, status, payload) {
    response.writeHead(status, {`
  const after = `export function sendJson(response, status, payload) {
    // HTTP 502 is reserved for failures at a gateway boundary. dsh-market
    // also used it for ordinary package-manager, validation, rollback, and
    // activation failures. Public gateways commonly replace every 502 body
    // with their own HTML page, hiding the structured JSON error and actions
    // such as the fresh-release "Update now" retry. Keep the application
    // failure body intact by using 422 at the HTTP boundary instead.
    const responseStatus = status === 502 ? 422 : status;
    response.writeHead(responseStatus, {`

  return replaceExactly(source, before, after)
}

// 让市场把重启权交出来。它自己的文档写明：被 systemd/launchd/pm2 托管的部署用
// `allowRestart: false` ——「有 supervisor 负责重启，市场的一键重启就不该再拉起第二个」。
// 本容器正是被 bin/dsh-supervisor 托管的，而市场那套 systemd 判据在这里不成立（PID 1
// 是 docker-init、Supervisor 是 PID 7，见 bin/dsh-supervisor 里的说明），所以这条显式
// 声明才是真正生效的那一个。用户在市场的设置页里仍然可以自己把它打开。
function patchMarketRestartOwnership(source) {
  const anchor = source.indexOf('id: dsh-market')
  if (anchor === -1) return undefined
  const nameStart = source.indexOf('name:', anchor)
  if (nameStart === -1) return undefined
  const nameLineEnd = source.indexOf('\n', nameStart)
  if (nameLineEnd === -1) return undefined
  // 这一段里已经有 config 就说明上游换了写法：宁可不补，也不要写出第二个 config 键。
  const rest = source.slice(nameLineEnd)
  const nextItem = rest.search(/\n[ ]*- /)
  if (/\bconfig:/.test(nextItem === -1 ? rest : rest.slice(0, nextItem))) return undefined
  const indent = source.slice(source.lastIndexOf('\n', nameStart) + 1, nameStart)
  return `${source.slice(0, nameLineEnd)}\n${indent}config:\n${indent}  allowRestart: false${source.slice(nameLineEnd)}`
}

function patchMarketRestartHint(source) {
  const chinese = replaceExactly(source, marketRestartHintBefore, marketRestartHintAfter)
  if (chinese === undefined) return undefined
  return replaceExactly(chinese, marketRestartHintEnBefore, marketRestartHintEnAfter)
}

// 一条补丁的通用执行流程：文件不在就 absent，已经补过就 current，能补就写盘，
// 认不出形状就 unrecognized。任何一条失败都不阻断其它条，也不阻断 DSH 启动。
function apply({ id, file, marker, patch, success }) {
  const source = read(file)
  if (source === undefined) {
    record(id, 'absent', `未安装：${file}`)
    return false
  }
  if (source.includes(marker)) {
    record(id, 'current', '已是补过的版本')
    return false
  }
  const next = patch(source)
  if (next === undefined) {
    record(id, 'unrecognized', `认不出上游形状，补丁未生效：${file}`)
    process.stderr.write(`[dsh][warn] ${id}: 认不出上游形状，补丁未生效（${file}）\n`)
    return false
  }
  fs.writeFileSync(file, next, 'utf8')
  record(id, 'applied', `已补：${file}`)
  process.stderr.write(`[dsh] ${success}\n`)
  return true
}

// vision-router 的两条要么一起生效要么一起不生效：只补一半会让远程设置开关的
// 读写两侧对不上，比两边都不补更糟。所以先都算出来，再一起落盘。
const visionClient = read(visionClientFile)
const visionPermission = read(visionPermissionFile)
if (visionClient === undefined || visionPermission === undefined) {
  record('vision-router-remote-settings', 'absent', `未安装：${visionClientFile}`)
} else if (visionClient.includes(clientAfter) && visionPermission.includes(permissionAfter)) {
  record('vision-router-remote-settings', 'current', '已是补过的版本')
} else {
  const nextClient = visionClient.includes(clientAfter)
    ? visionClient
    : replaceExactly(visionClient, clientBefore, clientAfter)
  const nextPermission = visionPermission.includes(permissionAfter)
    ? visionPermission
    : replaceExactly(visionPermission, permissionBefore, permissionAfter)

  if (nextClient === undefined || nextPermission === undefined) {
    record('vision-router-remote-settings', 'unrecognized', '认不出上游形状，两条都未生效')
    process.stderr.write('[dsh][warn] vision-router-remote-settings: 认不出上游形状，补丁未生效\n')
  } else {
    if (nextClient !== visionClient) fs.writeFileSync(visionClientFile, nextClient, 'utf8')
    if (nextPermission !== visionPermission) fs.writeFileSync(visionPermissionFile, nextPermission, 'utf8')
    record('vision-router-remote-settings', 'applied', '已补 client.js 与 local-remote-settings-permission.js')
    process.stderr.write('[dsh] fixed vision-router boolean settings compatibility\n')
  }
}

apply({
  id: 'market-non-json-update',
  file: marketClientFile,
  marker: 'The market endpoint returned a non-JSON response; retry later.',
  patch: patchMarketUpdateResponse,
  success: 'fixed dsh-market non-JSON update responses',
})

apply({
  id: 'market-application-status',
  file: marketHttpFile,
  marker: 'const responseStatus = status === 502 ? 422 : status;',
  patch: patchMarketApplicationStatus,
  success: 'kept dsh-market application errors out of gateway HTTP 502 responses',
})

apply({
  id: 'market-restart-ownership',
  file: marketPatchFile,
  marker: 'allowRestart: false',
  patch: patchMarketRestartOwnership,
  success: 'told dsh-market the supervisor owns restarts (allowRestart: false)',
})

apply({
  id: 'market-restart-hint',
  file: marketClientFile,
  marker: marketRestartHintAfter,
  patch: patchMarketRestartHint,
  success: 'pointed the dsh-market restart hint at the DSH environment restart button',
})

writeReport()
