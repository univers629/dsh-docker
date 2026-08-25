import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const script = await readFile(new URL('../bin/update-dsh.sh', import.meta.url), 'utf8')
const installer = await readFile(new URL('../bin/install-dsh-runtime.sh', import.meta.url), 'utf8')

// 更新走 npm 预构建包，不再克隆源码也不再编译。
assert.doesNotMatch(script, /git clone/)
assert.doesNotMatch(script, /pnpm/)
assert.doesNotMatch(script, /build:official/)
assert.match(script, /INSTALLER/)
assert.match(script, /mktemp -d \/tmp\/dsh-update/)
assert.match(script, /nginx -t -c/)
assert.match(script, /mv "\$APP_DIR" "\$OLD_DIR"/)
assert.match(script, /mv "\$STAGE_DIR" "\$APP_DIR"/)
assert.match(script, /DSH_UPDATE_NO_RESTART/)
assert.match(script, /"\$RESTART_EXECUTABLE" check/)
assert.match(script, /"\$RESTART_EXECUTABLE" request 1/)
// 重启只针对 DSH 进程；容器是长期存活的 Debian 系统，绝不能被更新流程重建。
assert.doesNotMatch(script, /gosu|node:node/)
assert.doesNotMatch(script, /kill -TERM "\$\(cat \/run\/dsh\.pid\)"/)
assert.doesNotMatch(script, /docker(?:\s|['"])/)
assert.doesNotMatch(script, /docker\.sock/)

// 安装器是镜像构建和容器内更新的唯一入口，两条路径必须产出同一套目录。
assert.match(installer, /npm install --global --prefix/)
assert.match(installer, /--allow-scripts=/)
assert.match(installer, /ln -sfn "lib\/node_modules\/\$PACKAGE\/node_modules"/)
assert.match(installer, /apply-dsh-artifact-patches/)
assert.match(installer, /write-dsh-metadata/)
assert.doesNotMatch(installer, /git clone|pnpm|build:official/)

console.log('dsh update script smoke: ok')
