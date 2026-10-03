// Passkey（WebAuthn）测试：origin/RPID 策略 + 用合成认证器跑通真实注册与登录验签。
//
// 合成认证器是必要的：这些都必须在没有浏览器/硬件密钥的情况下验证真实密码学路径
// （CBOR 解析、COSE 公钥、ES256 验签、计数器校验），否则测试只能覆盖拒绝分支。

import assert from 'node:assert/strict'
import { makeAuthenticator, b64u } from './helpers/synthetic-authenticator.mjs'

import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_TTL_MS,
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  passkeyOrigin,
  resolveOrigin,
} from '../bin/dsh-auth-passkey.mjs'

const RP_ID = 'dsh.example.com'
const ORIGIN = 'https://dsh.example.com'

// ---------------------------------------------------------------- 合成认证器（共享助手）
// 认证器实现见 tests/helpers/synthetic-authenticator.mjs：它用真实 ES256 签名，
// 让这些用例覆盖真实的验签路径而不是只覆盖拒绝分支。
const authenticator = makeAuthenticator({ rpId: RP_ID, origin: ORIGIN })
// ---------------------------------------------------------------- origin / RPID 策略
assert.deepEqual(passkeyOrigin('https://dsh.example.com'), { origin: ORIGIN, rpId: RP_ID }, 'plain https origin accepted')
assert.deepEqual(passkeyOrigin('https://dsh.example.com/'), { origin: ORIGIN, rpId: RP_ID }, 'trailing slash accepted')
assert.deepEqual(passkeyOrigin('https://dsh.example.com:8443'), { origin: 'https://dsh.example.com:8443', rpId: RP_ID }, 'non-443 port preserved')
assert.deepEqual(passkeyOrigin('https://dsh.example.com:443'), { origin: ORIGIN, rpId: RP_ID }, 'default port normalised away')
assert.equal(passkeyOrigin(''), null, 'empty rejected')
assert.equal(passkeyOrigin(undefined), null, 'missing rejected')
assert.equal(passkeyOrigin('not a url'), null, 'garbage rejected')
assert.equal(passkeyOrigin('http://dsh.example.com'), null, 'plain http rejected (WebAuthn needs a secure context)')
assert.equal(passkeyOrigin('https://127.0.0.1'), null, 'IP literal rejected')
assert.equal(passkeyOrigin('https://localhost'), null, 'single-label host rejected')
assert.equal(passkeyOrigin('https://dsh.example.com/login'), null, 'path rejected')
assert.equal(passkeyOrigin('https://dsh.example.com/?a=1'), null, 'query rejected')
assert.equal(passkeyOrigin('https://dsh.example.com/#x'), null, 'fragment rejected')
assert.equal(passkeyOrigin('https://user:pw@dsh.example.com'), null, 'embedded credentials rejected')
assert.equal(passkeyOrigin('https://com'), null, 'public suffix root rejected')
assert.equal(passkeyOrigin('https://-bad.example.com'), null, 'leading-dash label rejected')
assert.equal(passkeyOrigin('https://dsh.example.com.'), null, 'trailing dot rejected')
assert.equal(passkeyOrigin(`https://${'a'.repeat(64)}.example.com`), null, 'over-long label rejected')
// 绝不回退到请求头：没有配置就没有 passkey
assert.equal(resolveOrigin('', { host: 'dsh.example.com', 'x-forwarded-proto': 'https' }), null, 'never falls back to request headers')
assert.deepEqual(resolveOrigin(ORIGIN, { host: 'evil.example.com' }), { origin: ORIGIN, rpId: RP_ID }, 'configured origin wins over Host')

// ---------------------------------------------------------------- 注册选项
const user = { id: 'u-test-1', username: 'alice' }
const regOptions = await beginRegistration({ user, rpId: RP_ID })
assert.ok(typeof regOptions.challenge === 'string' && regOptions.challenge.length > 20, 'challenge issued')
assert.equal(regOptions.rp.id, RP_ID, 'rp id echoed')
assert.equal(regOptions.authenticatorSelection.residentKey, 'required', 'resident key required')
assert.equal(regOptions.authenticatorSelection.userVerification, 'required', 'user verification required')
assert.equal(regOptions.attestation, 'none', 'no attestation requested')
assert.ok(regOptions.excludeCredentials.length === 0, 'no exclusions by default')
const excluded = await beginRegistration({ user, rpId: RP_ID, excludeCredentials: [{ credentialID: 'abc' }] })
assert.equal(excluded.excludeCredentials[0].id, 'abc', 'exclusions passed through')

// ---------------------------------------------------------------- 真实注册验签
const registration = await finishRegistration({
  response: authenticator.attestation(regOptions.challenge),
  expectedChallenge: regOptions.challenge,
  expectedOrigin: ORIGIN,
  expectedRPID: RP_ID,
})
assert.equal(registration.ok, true, 'valid attestation verifies')
assert.equal(registration.credential.id, b64u(authenticator.credentialID), 'credential id extracted')
assert.ok(typeof registration.credential.publicKey === 'string' && registration.credential.publicKey.length > 20, 'public key extracted')
assert.equal(registration.counter, 0, 'initial counter read')
assert.ok(['singleDevice', 'multiDevice'].includes(registration.deviceType), 'device type reported')

// 拒绝分支
const wrongChallenge = await finishRegistration({
  response: authenticator.attestation('some-other-challenge'),
  expectedChallenge: regOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
})
assert.equal(wrongChallenge.ok, false, 'wrong challenge rejected')
const wrongOrigin = await finishRegistration({
  response: authenticator.attestation(regOptions.challenge, { origin: 'https://evil.example.com' }),
  expectedChallenge: regOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
})
assert.equal(wrongOrigin.ok, false, 'wrong origin rejected')
const wrongRpId = await finishRegistration({
  response: authenticator.attestation(regOptions.challenge, { rpId: 'evil.example.com' }),
  expectedChallenge: regOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
})
assert.equal(wrongRpId.ok, false, 'wrong rpId rejected')
const garbageReg = await finishRegistration({
  response: { id: 'x', type: 'public-key', response: {} },
  expectedChallenge: regOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
})
assert.equal(garbageReg.ok, false, 'malformed response rejected without throwing')

// ---------------------------------------------------------------- 真实登录验签
const storedCredential = registration.credential
const authOptions = await beginAuthentication({ rpId: RP_ID, allowCredentials: [{ credentialID: storedCredential.id }] })
assert.ok(authOptions.challenge.length > 20, 'authentication challenge issued')
assert.equal(authOptions.allowCredentials[0].id, storedCredential.id, 'allowCredentials passed through')
assert.equal(authOptions.userVerification, 'required', 'user verification required for login')

const goodAuth = await finishAuthentication({
  response: authenticator.assertion(authOptions.challenge, { counter: 1 }),
  expectedChallenge: authOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
  credential: storedCredential,
})
assert.equal(goodAuth.ok, true, 'valid assertion verifies')
assert.equal(goodAuth.newCounter, 1, 'counter advanced')

// 篡改签名
const tampered = await finishAuthentication({
  response: authenticator.assertion(authOptions.challenge, { badSignature: true }),
  expectedChallenge: authOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
  credential: storedCredential,
})
assert.equal(tampered.ok, false, 'tampered signature rejected')

// 错 challenge
const wrongAuthChallenge = await finishAuthentication({
  response: authenticator.assertion('another-challenge'),
  expectedChallenge: authOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
  credential: storedCredential,
})
assert.equal(wrongAuthChallenge.ok, false, 'wrong challenge rejected on login')

// 错 origin
const wrongAuthOrigin = await finishAuthentication({
  response: authenticator.assertion(authOptions.challenge, { origin: 'https://evil.example.com' }),
  expectedChallenge: authOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
  credential: storedCredential,
})
assert.equal(wrongAuthOrigin.ok, false, 'wrong origin rejected on login')

// 计数器回退（克隆信号）：v13 的库自己就会拒绝，我们另有一层显式检查作为兜底，
// 所以只要断言「被拒绝」并且原因可解释即可，不绑定具体是哪一层拦下的。
const regressed = await finishAuthentication({
  response: authenticator.assertion(authOptions.challenge, { counter: 0 }),
  expectedChallenge: authOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
  credential: { ...storedCredential, counter: 5 },
})
assert.equal(regressed.ok, false, 'counter regression rejected')
assert.ok(
  ['counter_regression', 'invalid'].includes(regressed.reason),
  `regression must be rejected with an explainable reason, got ${regressed.reason}`,
)

// 常量健全
assert.equal(PASSKEY_TTL_MS, 180_000, 'ceremony TTL is 3 minutes')
assert.equal(MAX_PASSKEYS_PER_USER, 10, 'per-user credential cap')

console.log('dsh-auth passkey smoke: ok')
