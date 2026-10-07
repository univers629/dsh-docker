// 回归测试：可写数据目录的属主对齐必须发生在 cd 进工程目录之后。
//
// 触发路径：全新安装后 dsh-auth 陷入重启循环，入口返回 500/502：
//   Error: EACCES: permission denied, open '/data/auth/.totp.1.tmp'
//     at loadOrCreateTotpKey (dsh-auth-store.mjs:169)
//
// 原因：install.sh 顶层（case 分派之前）执行了
//   mkdir -p data/auth data/secret data/broker data/egress
//   chown 1000:1000 data/broker data/egress
// 但这些是**相对路径**，而脚本顶层的 cwd 是调用者的当前目录——curl | bash 时
// 就是 $HOME。于是目录被建到工程外面（宿主上确实出现了 /root/data/*），
// 工程目录里那份保持 root:root。dsh-auth / dsh-key-admin 都以 UID 1000 运行，
// 要在目录里新建临时文件再 rename，目录不可写就直接 EACCES。
//
// 三种运行身份的需求不同，测试要锁住这一点：
//   data/auth   → dsh-auth (1000) 写 state.json / totp.key
//   data/broker → dsh-key-admin (1000) 写 keys.json.tmp.<pid>
//   data/egress → dsh-key-admin (1000) 写 policy.json.tmp.<pid>
//   data/secret → 容器 root 用，保持 root
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')

// —— 1) 顶层不得再对相对路径做 mkdir/chown ——
//
// 只检查真正在顶层执行的语句（行首无缩进、非注释）。函数体内的缩进行不受此限：
// 那些函数会在 cd 之后被调用。
const topLevel = installSh
  .split('\n')
  .map((line, i) => ({ line, no: i + 1 }))
  .filter(({ line }) => /^[a-zA-Z_]/.test(line) && !/^\s*#/.test(line))

const strayMkdir = topLevel.filter(({ line }) => /^mkdir\s+-p\s+data\//.test(line))
assert.deepEqual(
  strayMkdir.map((s) => `第 ${s.no} 行: ${s.line}`),
  [],
  '脚本顶层不得对 data/ 做相对路径 mkdir：顶层 cwd 是调用者的当前目录（curl | bash 时是 $HOME），' +
    '目录会被建到工程外面，工程里那份保持 root 属主，UID 1000 的容器写不进去',
)

const strayChown = topLevel.filter(({ line }) => /^chown\s+[^\s]+\s+data\//.test(line))
assert.deepEqual(
  strayChown.map((s) => `第 ${s.no} 行: ${s.line}`),
  [],
  '脚本顶层不得对 data/ 做相对路径 chown：同上，chown 会落到工程外面',
)

// —— 2) 必须有一个在 cd 之后调用的对齐函数 ——
assert.match(
  installSh,
  /^align_writable_data_dirs\(\) \{/m,
  'install.sh 必须定义 align_writable_data_dirs（对齐可写数据目录的属主）',
)

// 该函数必须把三个由 UID 1000 写入的目录放进 **chown 的循环列表**。漏掉任何一个，
// 对应的容器就会在第一次写临时文件时 EACCES——dsh-auth 漏了是重启循环，面板漏了是保存失败。
//
// 只看函数体里有没有出现字符串是不够的：目录名还会出现在 mkdir 与警告文案里，
// 从循环列表里删掉依然能匹配上。必须精确取 for 的列表。
const fnMatch = installSh.match(/^align_writable_data_dirs\(\) \{[\s\S]*?\n\}/m)
assert.ok(fnMatch, 'align_writable_data_dirs 必须有完整的函数体')
const fnBody = fnMatch[0]

const loopMatch = fnBody.match(/for\s+directory\s+in\s+([^;]+);\s*do/)
assert.ok(loopMatch, 'align_writable_data_dirs 必须用一个循环 chown 这些目录')
const chowned = loopMatch[1].trim().split(/\s+/)
for (const dir of ['data/auth', 'data/broker', 'data/egress']) {
  assert.ok(
    chowned.includes(dir),
    `align_writable_data_dirs 的 chown 列表必须包含 ${dir}（实际：${chowned.join(' ')}）：` +
      '对应的容器以 UID 1000 运行，要在目录里新建临时文件再 rename',
  )
}
assert.match(fnBody, /chown 1000:1000/, 'align_writable_data_dirs 必须 chown 到 1000:1000')
// data/secret 由容器 root 使用，不能被改成 1000——那会让 dsh-root 读不到口令哈希。
assert.ok(
  !chowned.includes('data/secret'),
  'data/secret 由容器 root 使用，不能进 1000:1000 的对齐列表',
)

// —— 3) 调用点必须在 cd 之后 ——
//
// 逐个检查调用点的上下文里是否已有 cd "$TARGET_DIR" 或 enter_project。
const callLines = []
{
  const lines = installSh.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*align_writable_data_dirs\s*$/.test(lines[i])) callLines.push(i + 1)
  }
}
assert.ok(callLines.length >= 2, `至少要覆盖安装与维护两条路径，实际 ${callLines.length} 处调用`)

for (const no of callLines) {
  // 往前找 60 行，必须能看到 cd 到工程目录或 enter_project。
  const start = Math.max(0, no - 60)
  const before = installSh.split('\n').slice(start, no).join('\n')
  assert.ok(
    /cd "\$TARGET_DIR"/.test(before) || /enter_project/.test(before),
    `第 ${no} 行的 align_writable_data_dirs 调用必须在 cd 进工程目录之后：` +
      '否则 chown 作用在调用者的当前目录上，工程里的目录仍是 root 属主',
  )
}

console.log('data-dir-ownership smoke: ok (属主对齐在 cd 之后，且覆盖 auth/broker/egress)')
