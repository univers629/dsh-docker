import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const script = await readFile(new URL('../bin/update-dsh.sh', import.meta.url), 'utf8')

assert.match(script, /git clone/)
assert.match(script, /apply-dsh-patches/)
assert.match(script, /pnpm install --frozen-lockfile/)
assert.match(script, /pnpm run build:official/)
assert.match(script, /METADATA_WRITER/)
assert.match(script, /mktemp -d \/tmp\/dsh-update/)
assert.match(script, /nginx -t -c/)
assert.doesNotMatch(script, /gosu|node:node/)
assert.match(script, /mv "\$APP_DIR" "\$OLD_DIR"/)
assert.match(script, /mv "\$SOURCE_DIR" "\$APP_DIR"/)
assert.match(script, /DSH_UPDATE_NO_RESTART/)
assert.doesNotMatch(script, /docker(?:\s|['"])/)
assert.doesNotMatch(script, /docker\.sock/)

console.log('dsh update script smoke: ok')
