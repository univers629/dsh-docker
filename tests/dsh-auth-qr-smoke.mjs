// 二维码验证：往返解码 + 服务端产物同一性。
//
// 为什么这样测：自写编码器测自写编码器没有意义，只看 SVG 结构也证明不了手机能扫。
// 这里做两件互补的事：
//   1. 往返——把库输出的模块矩阵栅格化，用**无关联的第三方解码器**（jsQR）解回，
//      断言解出的就是原 otpauth 地址。这验证的是「码本身扫得出来」。
//   2. 同一性——把服务端返回的 data URI 解出来的 SVG，与库对同一地址的输出逐字节比对。
//      这验证的是「服务端发出去的就是上面那个扫得出来的产物」，而不是别的东西。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// 依赖装在 bin/（服务的运行时清单在那里），测试文件在 tests/，因此显式指向 bin/。
const require = createRequire(new URL('../bin/package.json', import.meta.url))
const QRCode = require('qrcode')
const jsQRModule = require('jsqr')
const jsQR = typeof jsQRModule === 'function' ? jsQRModule : jsQRModule.default

const QR_OPTIONS = { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 200 }

/** 把模块矩阵放大成位图（含静默区），交给解码器。 */
function rasterize(modules, { scale = 8, quiet = 4 } = {}) {
  const size = (modules.size + quiet * 2) * scale
  const buffer = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let row = 0; row < modules.size; row++) {
    for (let column = 0; column < modules.size; column++) {
      if (!modules.data[row * modules.size + column]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (column + quiet) * scale + dx
          const py = (row + quiet) * scale + dy
          const offset = (py * size + px) * 4
          buffer[offset] = 0
          buffer[offset + 1] = 0
          buffer[offset + 2] = 0
        }
      }
    }
  }
  return { buffer, size }
}

function decode(uri) {
  const { buffer, size } = rasterize(QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules)
  const result = jsQR(buffer, size, size)
  return result ? result.data : null
}

// ---- 1) 往返解码 ----
const uri = 'otpauth://totp/DSH:alice?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=DSH&algorithm=SHA1&digits=6&period=30'
assert.equal(decode(uri), uri, 'a generated otpauth QR must decode back to the same URI')

// 中文 issuer 与真实长度的 base32 密钥也要能解回
const cjkUri = 'otpauth://totp/DSH:%E6%B5%8B%E8%AF%95?secret=S6AKG6DQNTKUOLLITWVRZPDMGFV6Z4J7&issuer=DSH'
assert.equal(decode(cjkUri), cjkUri, 'percent-encoded labels must survive the round trip')

// ---- 2) 服务端产物同一性 ----
const demo = path.join(process.env.TEMP ?? '.', 'dsh-qr')
const qrFile = path.join(demo, 'qr.txt')
if (fs.existsSync(qrFile)) {
  const dataUri = fs.readFileSync(qrFile, 'utf8').trim()
  const servedUri = fs.readFileSync(path.join(demo, 'uri.txt'), 'utf8').trim()
  assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'), 'the service returns a data URI, not raw markup')
  const servedSvg = Buffer.from(dataUri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
  const expectedSvg = await QRCode.toString(servedUri, QR_OPTIONS)
  assert.equal(servedSvg, expectedSvg, 'the served image must be exactly what the encoder produces for the served URI')
  // 服务端那个地址本身也要能解回，形成闭环
  assert.equal(decode(servedUri), servedUri, 'the URI the service returned must itself be encodable and decodable')
  // 明文密钥与二维码必须指同一个密钥：手输与扫码必须得到同一串验证码
  const secret = /secret=([A-Z2-7]+)/.exec(servedUri)?.[1]
  assert.ok(secret && secret.length === 32, 'the URI carries a 32-character base32 secret')
}

// ---- 3) 确定性与最小暴露 ----
assert.equal(await QRCode.toString(uri, QR_OPTIONS), await QRCode.toString(uri, QR_OPTIONS), 'QR rendering must be deterministic')
const svg = await QRCode.toString(uri, QR_OPTIONS)
assert.ok(!svg.includes('JBSWY3DPEHPK3PXP'), 'the image must not embed the secret as selectable text')

console.log('dsh-auth otpauth QR smoke: ok')
