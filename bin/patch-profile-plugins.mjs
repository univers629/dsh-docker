import fs from 'node:fs'

const root = process.env.DSH_PROFILE_ROOT ?? '/data/dsh/profiles/web'
const clientFile = `${root}/node_modules/dsh-vision-router/lib/client.js`
const permissionFile = `${root}/node_modules/dsh-vision-router/lib/local-remote-settings-permission.js`

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

const client = read(clientFile)
const permission = read(permissionFile)
if (client === undefined || permission === undefined) process.exit(0)

const clientPatched = client.includes(clientAfter)
const permissionPatched = permission.includes(permissionAfter)
const nextClient = clientPatched ? client : replaceExactly(client, clientBefore, clientAfter)
const nextPermission = permissionPatched
  ? permission
  : replaceExactly(permission, permissionBefore, permissionAfter)

if (nextClient === undefined || nextPermission === undefined) {
  process.stderr.write('[dsh] vision-router compatibility patch skipped: plugin source is not recognized\n')
  process.exit(0)
}

if (nextClient !== client) fs.writeFileSync(clientFile, nextClient, 'utf8')
if (nextPermission !== permission) fs.writeFileSync(permissionFile, nextPermission, 'utf8')

if (nextClient !== client || nextPermission !== permission) {
  process.stderr.write('[dsh] fixed vision-router boolean settings compatibility\n')
}
