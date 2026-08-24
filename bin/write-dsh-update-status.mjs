import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const [file, state, message = ''] = process.argv.slice(2)
if (!file || !state) process.exit(2)

await mkdir(dirname(file), { recursive: true })
const temporary = `${file}.${process.pid}.tmp`
await writeFile(temporary, `${JSON.stringify({ state, message, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
await rename(temporary, file)
