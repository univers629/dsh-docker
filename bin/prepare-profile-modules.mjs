import fs from 'node:fs'
import path from 'node:path'

// DSH 自己维护 $DSH_HOME/profiles/node_modules：它按 app 依赖闭包在里面逐包
// 建软链（healProfilesModuleFallback），遇到不是软链的条目会直接报错退出。
// 所以这里不再创建任何链接，只保证那个目录本身是一个真实目录：
// 早期版本把它整体软链到 /app/dsh/node_modules，留下来会让 DSH 起不来。
const appDir = process.env.DSH_APP_DIR ?? '/app/dsh'
const appModules = path.join(appDir, 'node_modules')
const dataProfiles = process.env.DSH_PROFILES_DIR ?? '/data/dsh/profiles'
const dataModules = path.join(dataProfiles, 'node_modules')

if (!fs.existsSync(appModules)) {
  throw new Error(`[profile-modules] 运行时模块目录不存在: ${appModules}`)
}

fs.mkdirSync(dataProfiles, { recursive: true })

let stale = false
try {
  if (fs.lstatSync(dataModules).isSymbolicLink()) {
    fs.unlinkSync(dataModules)
    stale = true
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

fs.mkdirSync(dataModules, { recursive: true })

if (stale) {
  console.log('[profile-modules] 已移除旧版整目录软链，交回 DSH 自行维护 profile 模块回退')
}
