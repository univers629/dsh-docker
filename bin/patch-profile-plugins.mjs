import fs from 'node:fs'

const root = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const clientFile = `${root}/node_modules/dsh-vision-router/lib/client.js`
const permissionFile = `${root}/node_modules/dsh-vision-router/lib/local-remote-settings-permission.js`
const marketClientFile = `${root}/node_modules/dshmarket/client/client.js`

const clientBefore = "const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS, ...LOCAL_TOGGLE_KEYS, ...PRIVACY_TOGGLE_KEYS]"
const clientAfter = "const ALL_TOGGLE_KEYS = [...TOGGLE_KEYS, ...ADVANCED_TOGGLE_KEYS, ...LOCAL_TOGGLE_KEYS, ...PRIVACY_TOGGLE_KEYS, 'allowRemoteSettings']"

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

function read(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

function replaceExactly(source, before, after) {
  const first = source.indexOf(before)
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) return undefined
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function patchMarketUpdateResponse(source) {
  const doUpdate = source.indexOf('const doUpdate =')
  const fetchStart = source.indexOf('return fetch("/dsh-market/update", {', doUpdate)
  if (doUpdate === -1 || fetchStart === -1) return undefined

  const parseStart = source.indexOf('}).then((res) => res.json().then((body) => ({', fetchStart)
  const parseEndToken = '}))).then(({ status, body }) => {'
  const parseEnd = source.indexOf(parseEndToken, parseStart)
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

const client = read(clientFile)
const permission = read(permissionFile)
if (client !== undefined && permission !== undefined) {
  const clientPatched = client.includes(clientAfter)
  const permissionPatched = permission.includes(permissionAfter)
  const nextClient = clientPatched ? client : replaceExactly(client, clientBefore, clientAfter)
  const nextPermission = permissionPatched
    ? permission
    : replaceExactly(permission, permissionBefore, permissionAfter)

  if (nextClient === undefined || nextPermission === undefined) {
    process.stderr.write('[dsh] vision-router compatibility patch skipped: plugin source is not recognized\n')
  } else {
    if (nextClient !== client) fs.writeFileSync(clientFile, nextClient, 'utf8')
    if (nextPermission !== permission) fs.writeFileSync(permissionFile, nextPermission, 'utf8')

    if (nextClient !== client || nextPermission !== permission) {
      process.stderr.write('[dsh] fixed vision-router boolean settings compatibility\n')
    }
  }
}

const market = read(marketClientFile)
if (market !== undefined) {
  const marker = 'The market endpoint returned a non-JSON response; retry later.'
  const nextMarket = market.includes(marker) ? market : patchMarketUpdateResponse(market)
  if (nextMarket === undefined) {
    process.stderr.write('[dsh] market response compatibility patch skipped: client bundle is not recognized\n')
  } else if (nextMarket !== market) {
    fs.writeFileSync(marketClientFile, nextMarket, 'utf8')
    process.stderr.write('[dsh] fixed dsh-market non-JSON update responses\n')
  }
}
