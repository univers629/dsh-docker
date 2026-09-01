import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(root, path))

const manifest = JSON.parse(read('pwa/manifest.webmanifest').toString('utf8'))
assert.equal(manifest.name, 'DeepSeek Harness')
assert.equal(manifest.short_name, 'DSH')
assert.equal(manifest.display, 'standalone')
assert.equal(manifest.start_url, '/')
assert.equal(manifest.scope, '/')
assert.deepEqual(
  manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
  [
    { src: '/icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
)

function pngSize(path) {
  const image = read(path)
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is not PNG`)
  return [image.readUInt32BE(16), image.readUInt32BE(20)]
}

assert.deepEqual(pngSize('pwa/icon-192.png'), [192, 192])
assert.deepEqual(pngSize('pwa/icon-512.png'), [512, 512])
assert.deepEqual(pngSize('pwa/icon-maskable-512.png'), [512, 512])
assert.match(read('pwa/favicon.svg').toString('utf8'), /DeepSeek|<path id="path"/)

const worker = read('pwa/service-worker.js').toString('utf8')
assert.match(worker, /self\.skipWaiting\(\)/)
assert.match(worker, /self\.clients\.claim\(\)/)
assert.match(worker, /addEventListener\(['"]fetch['"]/)
assert.match(worker, /event\.respondWith\(fetch\(event\.request\)\)/)
assert.doesNotMatch(worker, /cache\.(add|addAll|put)\(/, 'authenticated app traffic must not be cached')

const nginx = read('nginx/dsh-nginx.conf').toString('utf8')
for (const route of ['/manifest.webmanifest', '/service-worker.js', '/pwa-register.js']) {
  assert.match(nginx, new RegExp(`location = ${route.replaceAll('.', '\\.')}`))
}
assert.equal((nginx.match(/auth_basic off;/g) ?? []).length, 5, 'health check and four PWA locations must bypass Basic Auth')
assert.match(nginx, /manifest\.webmanifest" crossorigin="use-credentials"/)
assert.match(nginx, /sub_filter '<\/head>' .*pwa-register\.js/)
assert.match(nginx, /proxy_set_header Accept-Encoding ""/)

const dockerfile = read('Dockerfile').toString('utf8')
assert.match(dockerfile, /COPY pwa\/ \/usr\/local\/share\/dsh-pwa\//)

console.log('pwa smoke: ok')
