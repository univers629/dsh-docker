// 合成 WebAuthn 认证器（仅测试用）：用 node:crypto 生成 ES256(P-256) 密钥，
// 手工拼出合法的 attestationObject / assertion，让测试能在没有浏览器与硬件密钥的
// 情况下跑通**真实验签路径**（CBOR 解析、COSE 公钥、ES256 验签、计数器）。
//
// 只包含 WebAuthn 需要的最小 CBOR 子集：map / text / byte string / 整数。

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'

function cborHead(major, length) {
  const m = major << 5
  if (length < 24) return Buffer.from([m | length])
  if (length < 256) return Buffer.from([m | 24, length])
  return Buffer.from([m | 25, (length >> 8) & 0xff, length & 0xff])
}

export const cborText = (s) => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s, 'utf8')])
export const cborBytes = (b) => Buffer.concat([cborHead(2, b.length), b])
export const cborMap = (pairs) => Buffer.concat([cborHead(5, pairs.length), ...pairs.flat()])
export const cborInt = (n) => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n))

export function b64u(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

/**
 * 造一个软件认证器。
 * @param {object} [options] 选项。
 * @param {string} options.rpId RPID（决定 rpIdHash）。
 * @param {string} options.origin 期望 origin，写入 clientDataJSON。
 * @returns {{credentialID:Buffer, attestation:Function, assertion:Function}} 认证器。
 */
export function makeAuthenticator({ rpId, origin }) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  const credentialID = randomBytes(32)
  // COSE_Key(EC2, ES256): 1:kty=2, 3:alg=-7, -1:crv=1, -2:x, -3:y
  const cosePublicKey = cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ])
  const counter32 = (value) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(value)
    return b
  }
  return {
    credentialID,
    b64: () => b64u(credentialID),
    /** 注册响应：flags = UP|UV|AT。 */
    attestation(challenge, overrides = {}) {
      const { counter = 0, rpId: rp = rpId, origin: og = origin } = overrides
      const aaguid = Buffer.alloc(16)
      const credIdLen = Buffer.alloc(2)
      credIdLen.writeUInt16BE(credentialID.length)
      const authData = Buffer.concat([
        createHash('sha256').update(rp).digest(),
        Buffer.from([0x45]),
        counter32(counter),
        aaguid,
        credIdLen,
        credentialID,
        cosePublicKey,
      ])
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: og }), 'utf8')
      const attestationObject = cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData)],
      ])
      return {
        id: b64u(credentialID),
        rawId: b64u(credentialID),
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject) },
      }
    },
    /** 登录响应：签名覆盖 authData || sha256(clientDataJSON)。 */
    assertion(challenge, overrides = {}) {
      const { counter = 1, rpId: rp = rpId, origin: og = origin, badSignature = false } = overrides
      const authData = Buffer.concat([
        createHash('sha256').update(rp).digest(),
        Buffer.from([0x05]),
        counter32(counter),
      ])
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: og }), 'utf8')
      const clientDataHash = createHash('sha256').update(clientDataJSON).digest()
      let signature = cryptoSign('sha256', Buffer.concat([authData, clientDataHash]), { key: privateKey, dsaEncoding: 'der' })
      if (badSignature) signature = Buffer.from(signature).fill(0)
      return {
        id: b64u(credentialID),
        rawId: b64u(credentialID),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          userHandle: null,
        },
      }
    },
  }
}
