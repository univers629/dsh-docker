// dsh-auth 策略层与状态库的单元冒烟测试。
// 覆盖 docs/auth-design.md §2/§3 中可纯函数验证的部分：Argon2id 编解码、密码强度、
// 恒时比较、限速桶、IP/同源解析、状态库原子读写与版本守卫、审计裁剪、TOTP 主密钥。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ARGON2,
  PASSWORD_MIN,
  RECOVERY,
  TOTP,
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  clientIp,
  constantTimeEqual,
  evaluateFailureBucket,
  findRecoveryCode,
  flowDigest,
  generateRecoveryCodes,
  generatePassword,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  isSameOrigin,
  isValidUsername,
  loginKeys,
  looksLikeRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  openTotpSecret,
  parsePasswordHash,
  randomToken,
  sealTotpSecret,
  tokenDigest,
  totpCodeAtStep,
  passwordAdvice,
  validatePassword,
  verifyPassword,
} from '../bin/dsh-auth-policy.mjs'
import { AUDIT_LIMIT, STATE_VERSION, appendAudit, loadOrCreateTotpKey, openStore } from '../bin/dsh-auth-store.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-policy-'))
try {
  // ---------- 密码：哈希/校验往返 ----------
  const encoded = hashPassword('correct horse 42')
  const parsed = parsePasswordHash(encoded)
  assert.ok(parsed, 'hash must parse back')
  assert.equal(parsed.memory, ARGON2.memory, 'memory parameter must round-trip')
  assert.equal(parsed.passes, ARGON2.passes, 'passes must round-trip')
  assert.equal(parsed.tag.length, 32, 'tag length must be 32 bytes')
  assert.ok(verifyPassword('correct horse 42', encoded), 'correct password must verify')
  assert.ok(!verifyPassword('correct horse 43', encoded), 'wrong password must fail')
  assert.ok(!verifyPassword('', encoded), 'empty password must fail')

  // 同一密码两次哈希必须不同（随机盐）
  assert.notEqual(hashPassword('correct horse 42'), hashPassword('correct horse 42'), 'salt must be random')

  // 复用的盐 → 确定性输出（便于将来做迁移测试）
  const salt = Buffer.alloc(16, 7)
  assert.equal(hashPassword('pw123456789', salt), hashPassword('pw123456789', salt), 'fixed salt must be deterministic')

  // ---------- 密码哈希解析：拒绝弱参数与畸形输入 ----------
  assert.equal(parsePasswordHash('$argon2id$v=19$m=1024,t=1,p=1$c2FsdHNhbHRzYWx0c2E$AAAA'), null, 'weak memory must be rejected')
  assert.equal(parsePasswordHash('$argon2id$v=19$m=65536,t=99,p=1$c2FsdHNhbHRzYWx0c2E$AAAA'), null, 'absurd passes rejected')
  assert.equal(parsePasswordHash('$argon2i$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2E$AAAA'), null, 'wrong algorithm rejected')
  assert.equal(parsePasswordHash('$argon2id$v=99$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2E$AAAA'), null, 'unknown version rejected')
  assert.equal(parsePasswordHash('not-a-hash'), null, 'garbage rejected')
  assert.equal(parsePasswordHash(''), null, 'empty rejected')
  assert.equal(verifyPassword('x', 'not-a-hash'), false, 'verify on garbage must be false, not throw')

  // ---------- 密码强度 ----------
  //
  // 只有长度是硬性要求。组成复杂度**不再拦截**：早先沿用 KPanel 的"至少一字母
  // 一数字"，实测把大量正常用户挡在注册之外，而强度提升有限（人们会写
  // Password1! 这类可预测组合）。强度改为界面提示，见 passwordAdvice。
  assert.equal(PASSWORD_MIN, 6, '长度下限是 6')
  assert.equal(validatePassword('short'), 'length', '5 位太短，拒绝')
  assert.equal(validatePassword('123456'), null, '纯数字 6 位放行（不再要求字母）')
  assert.equal(validatePassword('abcdef'), null, '纯字母 6 位放行')
  assert.equal(validatePassword('ab12'), 'length', '4 位仍拒绝')
  assert.equal(validatePassword('a'.repeat(257)), 'length', 'over-long rejected')
  assert.equal(validatePassword(null), 'length', 'non-string rejected')

  // ---------- 强度建议（不拦截） ----------
  assert.equal(passwordAdvice('123456'), 'short_simple', '6 位纯数字：既短又单一字符集')
  assert.equal(passwordAdvice('abcdefghij'), 'short_simple', '10 位纯字母：同样既短又单一字符集')
  assert.equal(passwordAdvice('abcdefghijkl'), 'simple', '12 位纯字母：够长，只提示字符集单一')
  assert.equal(passwordAdvice('abcd1234efgh'), null, '12 位且混合字符集：无建议')
  assert.equal(passwordAdvice('abcd1234'), 'short', '8 位但混合字符集：只提示偏短')
  assert.equal(passwordAdvice('ab'), null, '低于下限不提示（由 validatePassword 报错）')

  // ---------- 生成的口令必须必然通过校验 ----------
  for (let i = 0; i < 200; i++) {
    const generated = generatePassword()
    assert.equal(validatePassword(generated), null, `generated password must be valid: ${generated}`)
    assert.ok(generated.length >= PASSWORD_MIN, 'generated password meets the minimum length')
    assert.equal(passwordAdvice(generated), null, 'generated password needs no advice')
  }

  // ---------- 用户名 ----------
  assert.ok(isValidUsername('alice'))
  assert.ok(isValidUsername('a_b-c.d'))
  assert.ok(!isValidUsername('ab'), 'too short rejected')
  assert.ok(!isValidUsername('-alice'), 'leading dash rejected')
  assert.ok(!isValidUsername('a'.repeat(33)), 'too long rejected')
  assert.ok(!isValidUsername('has space'), 'space rejected')

  // ---------- 恒时比较与摘要 ----------
  assert.ok(constantTimeEqual('same', 'same'))
  assert.ok(!constantTimeEqual('same', 'diff'))
  assert.ok(!constantTimeEqual('short', 'much longer value'), 'length mismatch must not throw')
  assert.equal(tokenDigest('abc').length, 64, 'digest must be hex sha256')
  assert.notEqual(flowDigest('secret', 'totp_setup', 'tok'), flowDigest('secret', 'passkey_register', 'tok'), 'purpose must domain-separate')
  assert.ok(randomToken().length >= 32, 'random token must carry entropy')

  // ---------- 登录限速双桶（KPanel loginKeys 同款） ----------
  const keys = loginKeys('  192.168.1.5 ', ' Alice ')
  assert.equal(keys.ipKey, 'ip:192.168.1.5')
  assert.equal(keys.accountKey, 'account:alice')

  const now = 1_000_000
  const window = 60_000
  const fresh = evaluateFailureBucket([], now, window, 3)
  assert.ok(fresh.allowed, 'empty bucket allows')
  const two = evaluateFailureBucket([now - 1000, now - 2000], now, window, 3)
  assert.ok(two.allowed, 'below limit allows')
  const three = evaluateFailureBucket([now - 1000, now - 2000, now - 3000], now, window, 3)
  assert.ok(!three.allowed, 'at limit blocks')
  assert.ok(three.retryAfterMs > 0 && three.retryAfterMs <= window, 'retry-after within window')
  const stale = evaluateFailureBucket([now - window - 1, now - window - 2], now, window, 2)
  assert.ok(stale.allowed, 'expired failures must not block')
  assert.equal(stale.kept.length, 0, 'expired failures pruned')

  // ---------- IP 与同源 ----------
  // clientIp 的信任模型（修复后）：转发头只在直接对端是可信代理时采信。
  // 旧版无条件信任 x-real-ip，导致任何能直连网关端口的调用者自选配额键与审计地址。
  // 不给可信代理列表：一律用 socket 地址，头被忽略
  assert.equal(clientIp({ 'x-real-ip': '10.0.0.9' }, '127.0.0.1'), '127.0.0.1', 'untrusted peer: header ignored')
  assert.equal(clientIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.1'), '10.0.0.1', 'untrusted peer: XFF ignored')
  // 对端在可信列表里：头被采信
  const trustIngress = { trustedProxies: ['dsh-ingress'] }
  assert.equal(clientIp({ 'x-real-ip': '10.0.0.9' }, 'dsh-ingress', trustIngress), '10.0.0.9', 'trusted peer: X-Real-IP honoured')
  assert.equal(clientIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, 'dsh-INGRESS', trustIngress), '2.2.2.2', 'trusted peer (case-insensitive): last XFF hop wins')
  // 对端不在列表里（即使列表非空）：仍然回退 socket
  assert.equal(clientIp({ 'x-real-ip': '10.0.0.9' }, '10.9.9.9', trustIngress), '10.9.9.9', 'listed proxies do not include this peer')
  assert.equal(clientIp({}, '::ffff:127.0.0.1'), '127.0.0.1', 'v4-mapped normalised')
  assert.ok(isSameOrigin({ host: 'dsh.example.com', origin: 'https://dsh.example.com' }))
  assert.ok(!isSameOrigin({ host: 'dsh.example.com', origin: 'https://evil.example.com' }))
  assert.ok(!isSameOrigin({ host: 'dsh.example.com' }), 'missing origin/referer is not same-origin')
  assert.ok(isSameOrigin({ host: 'dsh.example.com', referer: 'https://dsh.example.com/login' }))

  // ---------- 状态库：原子读写 / 版本守卫 / 权限 ----------
  const stateFile = path.join(sandbox, 'auth', 'state.json')
  const store = openStore(stateFile)
  const initial = store.read()
  assert.equal(initial.version, STATE_VERSION)
  assert.deepEqual(initial.users, [], 'fresh store has no users')
  assert.equal(initial.setup.initialized, false)

  initial.setup.initialized = true
  initial.users.push({ id: 'u1', username: 'alice' })
  store.write(initial)
  const reread = store.read()
  assert.equal(reread.setup.initialized, true)
  assert.equal(reread.users[0].username, 'alice')

  // 权限位只在 POSIX 平台可断言：Windows 的 mode 恒为 0666（只有只读位有语义），
  // 而本服务的部署目标是 Linux 容器，那里 0600 必须真实成立。
  const posix = process.platform !== 'win32'
  if (posix) {
    const mode = fs.statSync(stateFile).mode & 0o777
    assert.equal(mode, 0o600, `state file must be 0600, got ${mode.toString(8)}`)
  }

  // 不支持的结构版本必须硬失败，而不是静默重置（避免用户丢账户）
  fs.writeFileSync(stateFile, JSON.stringify({ version: 999 }))
  assert.throws(() => store.read(), /version 999 is not supported/, 'unknown version must throw')

  // 损坏 JSON 必须硬失败
  fs.writeFileSync(stateFile, '{not json')
  assert.throws(() => store.read(), /not valid JSON/, 'corrupt state must throw')

  // ---------- 审计裁剪 ----------
  const auditState = { audit: [] }
  for (let i = 0; i < AUDIT_LIMIT + 25; i++) appendAudit(auditState, { action: 'login', result: 'ok', ip: '1.2.3.4' }, 1_700_000_000_000)
  assert.equal(auditState.audit.length, AUDIT_LIMIT, 'audit must be capped')
  assert.equal(auditState.audit[0].action, 'login')
  assert.equal(auditState.audit[0].change, null)

  // ---------- TOTP 主密钥 ----------
  const keyFile = path.join(sandbox, 'auth', 'totp.key')
  const k1 = loadOrCreateTotpKey(keyFile)
  assert.equal(k1.length, 32, 'TOTP key must be 32 bytes')
  const k2 = loadOrCreateTotpKey(keyFile)
  assert.ok(k1.equals(k2), 'TOTP key must persist across reloads')
  if (posix) assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'TOTP key must be 0600')

  fs.writeFileSync(keyFile, Buffer.alloc(31))
  assert.throws(() => loadOrCreateTotpKey(keyFile), /unexpected length/, 'wrong-length key must throw, not rotate')

  console.log('dsh-auth policy smoke: ok')
  // ---------- base32 往返 ----------
  const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
  const b32 = base32Encode(raw)
  assert.ok(/^[A-Z2-7]+$/.test(b32), 'base32 charset')
  assert.ok(base32Decode(b32).equals(raw), 'base32 round-trip')
  assert.ok(base32Decode(b32.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(raw), 'decode tolerates case/space')
  assert.equal(base32Decode('1NVALID'), null, 'base32 rejects illegal chars')
  assert.equal(base32Decode(''), null, 'base32 rejects empty')

  // ---------- TOTP：RFC 6238 已知向量（secret = "12345678901234567890" 的 base32） ----------
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
  assert.equal(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'base32 of RFC test secret')
  const rfcStep = (t) => Math.floor(t / TOTP.periodSeconds)
  assert.equal(totpCodeAtStep(rfcSecret, rfcStep(59)), '287082', 'RFC 6238 T=59')
  assert.equal(totpCodeAtStep(rfcSecret, rfcStep(1111111109)), '081804', 'RFC 6238 T=1111111109')
  assert.equal(totpCodeAtStep(rfcSecret, rfcStep(1234567890)), '005924', 'RFC 6238 T=1234567890')
  assert.equal(totpCodeAtStep('not-base32!', 1), null, 'invalid secret yields null')

  // ---------- TOTP：生成、URI、±1 步窗口、防重放 ----------
  const secret = generateTotpSecret()
  assert.equal(base32Decode(secret).length, 20, 'generated secret is 20 bytes')
  assert.match(buildOtpAuthUri('alice', secret), /^otpauth:\/\/totp\/DSH%3Aalice\?.*issuer=DSH/, 'otpauth URI shape')
  assert.ok(buildOtpAuthUri('alice', secret).includes(`secret=${secret}`), 'URI carries secret')

  const at = 1_700_000_000_000
  const step = Math.floor(at / 1000 / TOTP.periodSeconds)
  const code = totpCodeAtStep(secret, step)
  assert.ok(matchTotpStep(secret, code, at).ok, 'current step accepted')
  assert.ok(matchTotpStep(secret, totpCodeAtStep(secret, step - 1), at).ok, 'previous step accepted (drift)')
  assert.ok(matchTotpStep(secret, totpCodeAtStep(secret, step + 1), at).ok, 'next step accepted (drift)')
  assert.ok(!matchTotpStep(secret, totpCodeAtStep(secret, step + 5), at).ok, 'far step rejected')
  assert.ok(!matchTotpStep(secret, '000000', at).ok || code === '000000', 'wrong code rejected')
  assert.ok(!matchTotpStep(secret, 'abcdef', at).ok, 'non-numeric rejected')
  assert.ok(!matchTotpStep(secret, '12345', at).ok, 'short code rejected')
  assert.equal(matchTotpStep(secret, code, at).step, step, 'returns matched step')
  // 同一时间步重放必须被拒（T5）
  assert.ok(!matchTotpStep(secret, code, at, step).ok, 'replay of same step rejected')
  assert.ok(matchTotpStep(secret, code, at, step - 1).ok, 'a later step is still usable after an earlier consumption')

  // ---------- 恢复码 ----------
  const { codes, hashes } = generateRecoveryCodes()
  assert.equal(codes.length, RECOVERY.count, '10 recovery codes')
  assert.equal(hashes.length, RECOVERY.count, '10 hashes')
  for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/, `recovery code shape: ${c}`)
  assert.equal(new Set(codes).size, codes.length, 'recovery codes are unique')
  assert.ok(!hashes.includes(codes[0]), 'hash list must not contain plaintext')
  assert.ok(looksLikeRecoveryCode(codes[0]), 'plain code detected as recovery code')
  assert.ok(looksLikeRecoveryCode(normalizeRecoveryCode(codes[0])), 'normalised code detected')
  assert.ok(!looksLikeRecoveryCode('123456'), 'totp code is not a recovery code')
  assert.equal(findRecoveryCode(hashes, codes[3]), 3, 'finds the matching index')
  assert.equal(findRecoveryCode(hashes, codes[3].toLowerCase()), 3, 'case-insensitive match')
  assert.equal(findRecoveryCode(hashes, codes[3].replace(/-/g, '')), 3, 'separator-insensitive match')
  assert.equal(findRecoveryCode(hashes, 'AAAAA-BBBBB-CCCCC'), -1, 'unknown code misses')
  assert.equal(hashRecoveryCode(codes[1]), hashRecoveryCode(normalizeRecoveryCode(codes[1])), 'normalisation is idempotent')

  // ---------- TOTP 密钥加密封装 ----------
  const masterKey = Buffer.alloc(32, 9)
  const sealed = sealTotpSecret(masterKey, secret)
  assert.ok(!sealed.includes(secret), 'ciphertext must not contain plaintext')
  assert.equal(openTotpSecret(masterKey, sealed), secret, 'seal/open round-trip')
  assert.equal(openTotpSecret(Buffer.alloc(32, 8), sealed), null, 'wrong key must not open')
  const tampered = Buffer.from(sealed, 'base64url')
  tampered[tampered.length - 1] ^= 0xff
  assert.equal(openTotpSecret(masterKey, tampered.toString('base64url')), null, 'tampered ciphertext must fail auth')
  assert.equal(openTotpSecret(masterKey, 'AAAA'), null, 'short ciphertext rejected')
  assert.equal(openTotpSecret(masterKey, 'not base64url!!!'), null, 'garbage ciphertext rejected')
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}
