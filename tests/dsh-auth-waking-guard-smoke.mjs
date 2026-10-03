// 等待页的空转防护与「真实路径」判定：静态断言。
//
// 这些行为的失败模式很具体：服务端说「就绪」，但浏览器这一侧仍然打不开（入口的内嵌 DNS
// 对刚创建的容器名有解析缓存），于是「就绪 → 跳转 → 502 → 回等待页」会空转，把入口限速
// 打爆成 429。这里把防线钉住：跳转前必须用浏览器真实路径确认，且短时间内重复跳转要停手。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const page = fs.readFileSync(path.join(root, 'bin', 'dsh-auth-web', 'index.html'), 'utf8')

// 跳转前的真实路径探测
assert.ok(page.includes('async function workspaceReachable()'), 'the waking page probes the real path before redirecting')
assert.ok(page.includes("fetch('/?__probe=1'"), 'the probe goes through the same path the browser will use')
assert.ok(page.includes("redirect: 'follow'"), 'the probe follows redirects so it can see where it lands')
assert.ok(page.includes("landing.pathname.startsWith('/login')"), 'landing back on the login page means not ready')
assert.ok(page.includes("landing.pathname.startsWith('/waking')"), 'landing back on the waking page means not ready')
assert.ok(
  /if \(serverReady && await workspaceReachable\(\)\)/.test(page),
  'a redirect requires both the orchestrator to report ready and the real path to answer',
)

// 空转防护
assert.ok(page.includes("const WAKE_REDIRECT_MARK = 'dsh-waking-redirect-at'"), 'the last redirect is remembered')
assert.ok(page.includes('sessionStorage.setItem(WAKE_REDIRECT_MARK'), 'the redirect timestamp is recorded')
assert.ok(page.includes('Date.now() - last < 20_000'), 'a quick return disables automatic redirecting')
assert.ok(page.includes('attempts >= 3 && serverReady'), 'repeated server-ready-but-unreachable stops the loop')
assert.ok(page.includes("$('waking-retry').style.display = ''"), 'the user is offered an explicit retry instead')
assert.ok(page.includes('sessionStorage.removeItem(WAKE_REDIRECT_MARK)'), 'retrying clears the anti-spin marker')
// 轮询节奏不能太快，否则即使不跳转也在打接口
assert.ok(page.includes('setInterval(tick, 3000)'), 'polling is paced at 3 seconds')

// 文案要区分「环境没就绪」与「环境就绪但入口不通」，否则用户看到的是误导性的无限等待
for (const key of ['waking.almost', 'waking.stuck']) {
  const occurrences = page.split(`'${key}'`).length - 1
  assert.ok(occurrences >= 2, `${key} must exist in both dictionaries, found ${occurrences}`)
}

// 入口的 429 不能是裸错误页
for (const [name, file] of [['multiuser', 'nginx/dsh-multiuser.conf'], ['authgate', 'nginx/dsh-authgate.conf']]) {
  const conf = fs.readFileSync(path.join(root, file), 'utf8')
  assert.ok(conf.includes('error_page 429 = @throttled;'), `${name}: throttling routes to a friendly page`)
  assert.ok(conf.includes('location @throttled'), `${name}: the throttled page exists`)
  assert.ok(/add_header Retry-After 10 always;/.test(conf), `${name}: the throttled page tells the browser when to retry`)
  assert.ok(/http-equiv="refresh" content="10"/.test(conf), `${name}: the throttled page retries on its own`)
}

// ---- 停手规则必须排在跳转之前 ----
// 曾经的写法是「先跳转、后判断停手」：跳转分支 return 之后停手规则永远走不到，
// 于是可达性一会儿真一会儿假时就会持续闪烁。
{
  const stopAt = page.indexOf('if (attempts >= 3 && serverReady)')
  const redirectAt = page.indexOf('if (serverReady && await workspaceReachable())')
  assert.ok(stopAt > 0 && redirectAt > 0, 'both the stop rule and the redirect exist')
  assert.ok(stopAt < redirectAt, 'the stop rule must be evaluated before the redirect, or it can never fire')
}

// ---- 跳转前必须连续两次都通 ----
assert.ok(
  /await workspaceReachable\(\)\) \{\s*\n\s*\/\/ 连续两次/.test(page) || page.includes('await new Promise((resolve) => setTimeout(resolve, 600))'),
  'a redirect waits for a second confirmation instead of trusting a single success',
)
assert.ok(page.includes('if (await workspaceReachable())'), 'the second confirmation is a real probe, not a cached flag')

// ---- 进入等待界面要立刻探一次，而不是干等一个间隔 ----
assert.ok(page.includes('wakeTimer = setInterval(tick, 3000)'), 'polling is paced at 3 seconds')
assert.ok(/wakeTimer = setInterval\(tick, 3000\)\n\s*tick\(\)/.test(page), 'the first probe runs immediately')

// ---- 就绪判定必须用浏览器真正会走的那条路 ----
{
  const instances = fs.readFileSync(path.join(root, 'bin', 'dsh-instances.mjs'), 'utf8')
  assert.ok(instances.includes('instanceEntryPort: Number(process.env.DSH_INSTANCE_ENTRY_PORT ?? 3080)'), 'the entry port is a declared, distinct value')
  const probeReady = /async function probeReady\(name\) \{([\s\S]*?)\n\}/.exec(instances)
  assert.ok(probeReady, 'probeReady exists')
  assert.ok(
    probeReady[1].includes('CONFIG.instanceEntryPort'),
    'readiness must probe the container entry (nginx), the same hop the ingress uses: probing DSH directly reports ready while the ingress still gets connection refused',
  )
  assert.ok(!probeReady[1].includes('CONFIG.instanceWebPort'), 'readiness must not probe DSH directly')
}

// ---- 入口的 DNS 缓存不能太长，否则刚创建的名字会被负缓存拖住 ----
for (const file of ['nginx/dsh-multiuser.conf', 'nginx/dsh-authgate.conf']) {
  const conf = fs.readFileSync(path.join(root, file), 'utf8')
  const valid = /resolver 127\.0\.0\.11 valid=(\d+)s/.exec(conf)
  assert.ok(valid, `${file}: the resolver is configured`)
  assert.ok(Number(valid[1]) <= 5, `${file}: the DNS cache must be short, got ${valid[1]}s`)
}

// ---- 自动跳转必须限次 ----
// 原来「本页有会话 + 带 redirect 参数」就无条件跳转；当入口那侧判成未登录（401）
// 而 /api/auth/session 判成已登录时，就是 / → /login → 自动跳 / → 401 → … 的无限闪烁。
assert.ok(page.includes("const REDIRECT_MARK = 'dsh-login-redirect-at'"), 'the auto redirect is rate-limited by a marker')
assert.ok(page.includes('function justBounced()'), 'the page can tell that it was just bounced back')
assert.ok(
  /if \(target && !justBounced\(\)\) \{/.test(page),
  'the automatic redirect only happens when the page was not just bounced',
)
assert.ok(page.includes('notice.loopStopped'), 'the user is told why automatic redirection stopped')
assert.ok(
  /if \(target\) info\(t\('notice.loopStopped'\)\)/.test(page),
  'landing back with a target explains itself instead of silently looping',
)
assert.ok(
  page.includes("sessionStorage.removeItem(REDIRECT_MARK)"),
  'a manual click clears the marker: that is an explicit user intent',
)

// ---- 等待页只在确定未登录时才回登录页 ----
assert.ok(
  page.includes('if (session.response.status === 401)'),
  'the waking page must only bounce on a definite 401, not on throttling or a transient failure',
)
assert.ok(
  !/if \(!session\.response\.ok\) \{\s*\n\s*window\.location\.replace\('\/login'\)/.test(page),
  'a non-401 failure must not eject the user from the flow',
)

console.log('dsh-auth waking guard smoke: ok')
