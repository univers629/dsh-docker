// 回归：passkeyOrigin 必须拒绝公共后缀根作为 RPID。
//
// 审计待验证项：注释声称"不接受公共后缀根域"，但实现只检查段数 ≥2，于是 co.uk 这类
// 多标签公共后缀被放过。以公共后缀为 RPID 会让该后缀下所有互不相关的站点共享同一个
// 凭据作用域——它们都能对本部署发起断言。
//
// 同样重要的是别过度收紧：公共后缀之下多一段就是合法注册域（example.co.uk、
// foo.github.io），必须继续可用，否则真实用户在自己域名上开不了通行密钥。

import assert from 'node:assert/strict'

import { passkeyOrigin } from '../bin/dsh-auth-passkey.mjs'

const accepted = [
  'https://dsh.example.com',
  'https://dsh.example.com/', // 尾斜杠是书写 origin 的常见形式，与不带斜杠等价
  'https://example.co.uk',
  'https://foo.github.io',
  'https://dsh.example.com:8443',
  'https://a-b.c-d.example.com',
  'https://dsh.example.com:443',
]
for (const value of accepted) {
  const resolved = passkeyOrigin(value)
  assert.ok(resolved, `必须接受合法注册域：${value}`)
  const url = new URL(value)
  const port = url.port && url.port !== '443' ? `:${url.port}` : ''
  assert.equal(resolved.origin, `https://${url.hostname}${port}`, `origin 应归一化：${value}`)
  assert.equal(resolved.rpId, url.hostname, `rpId 应为主机名：${value}`)
}

const rejected = [
  ['', '空配置等于关闭该功能'],
  ['not a url', '非法 URL'],
  ['http://dsh.example.com', '通行密钥要求安全上下文，http 一律拒绝'],
  ['https://1.2.3.4', 'IP 字面量没有 RPID 语义'],
  ['https://[2001:db8::1]', 'IPv6 字面量同理'],
  ['https://localhost', '单标签主机'],
  ['https://com', '单标签公共后缀根'],
  ['https://co.uk', '多标签公共后缀根（本次修复的核心）'],
  ['https://com.au', '多标签公共后缀根'],
  ['https://github.io', '托管平台的私有后缀根'],
  ['https://pages.dev', '托管平台的私有后缀根'],
  ['https://s3.amazonaws.com', '云存储的私有后缀根'],
  ['https://dsh.example.com/login', '带路径'],
  ['https://user:pass@dsh.example.com', 'URL 内嵌凭据'],
  ['https://dsh.example.com?x=1', '带查询串'],
  ['https://dsh.example.com#frag', '带片段'],
  ['https://dsh.example.com.', '尾部点（会改变 RPID 语义）'],
  ['https://-bad.example.com', '标签以连字符开头'],
  ['https://bad-.example.com', '标签以连字符结尾'],
  ['https://dsh..example.com', '空标签'],
  [`https://${'a'.repeat(64)}.example.com`, '标签超过 63 字符'],
]
for (const [value, reason] of rejected) {
  assert.equal(passkeyOrigin(value), null, `必须拒绝（${reason}）：${value}`)
}
for (const value of [null, undefined, 42, {}, []]) {
  assert.equal(passkeyOrigin(value), null, `非字符串输入必须拒绝：${String(value)}`)
}

console.log('passkey origin suffix smoke: ok')
