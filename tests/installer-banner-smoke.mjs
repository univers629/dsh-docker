// 回归：安装向导的鲸鱼徽标必须是「有镂空的实心形状」，而不是一块实心色块；
// 并且 install.sh 与 install.ps1 两边的图案必须逐行一致。
//
// 为什么必须这样测：图案是写死在脚本里的半块字符，肉眼很难判断对错。
// 之前的版本只有外部轮廓——腹部大块留白和眼睛都被填实了，而终端里看着"像那么回事"，
// 于是没人发现。这里把字符还原成位图，直接断言中间确实存在镂空区域。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'))
const installSh = readFileSync(join(root, 'install.sh'), 'utf8')
const installPs1 = readFileSync(join(root, 'install.ps1'), 'utf8')

// install.sh 把图案存在 BANNER_ART / WORDMARK_ART 数组里（启动横幅、每页页头、
// 窄终端降级版共用）。图案字符集包含半块（▀▄█）、方框绘制（╗╔╝╚═║）与 DOS Rebel 的
// 阴影块（░），所以匹配时用"排除法"：单引号里只要不是 ASCII 空格就收。
const isArtChar = (s) => /^[^\x00-\x20']+$/.test(s) || s.trim() === ''

function readShArray(src, marker) {
  const start = src.indexOf(marker)
  if (start < 0) return null
  const end = src.indexOf('\n)', start)
  assert.ok(end > start, `${marker} array must be terminated`)
  const out = []
  for (const line of src.slice(start, end).split('\n')) {
    const m = line.match(/^\s*'([^']*)'\s*$/)
    if (m) out.push(m[1])
  }
  return out
}

const artLines = readShArray(installSh, 'BANNER_ART=(') ?? []
assert.ok(artLines.length >= 8, `banner must have at least 8 rows, got ${artLines.length}`)

const wordmarkLines = readShArray(installSh, 'WORDMARK_ART=(') ?? []
assert.ok(wordmarkLines.length >= 6, `wordmark must have at least 6 rows, got ${wordmarkLines.length}`)

// install.ps1 用脚本级数组存同一份图案
function readPsArray(src, marker) {
  const start = src.indexOf(marker)
  if (start < 0) return null
  const end = src.indexOf('\n)', start)
  assert.ok(end > start, `${marker} array must be terminated`)
  const out = []
  for (const line of src.slice(start, end).split('\n')) {
    const m = line.match(/^\s*'([^']*)'\s*$/)
    if (m) out.push(m[1])
  }
  return out
}
const psArt = readPsArray(installPs1, '$script:BannerArt = @(') ?? []
const psWordmark = readPsArray(installPs1, '$script:WordmarkArt = @(') ?? []
assert.ok(psArt.length >= 8, `PowerShell banner must have at least 8 rows, got ${psArt.length}`)
assert.ok(psWordmark.length >= 6, `PowerShell wordmark must have at least 6 rows, got ${psWordmark.length}`)

// 两个平台的图案必须逐行一致：只改一边，两边的横幅就会长得不一样
assert.deepEqual(
  psArt,
  artLines,
  'install.sh and install.ps1 banners must be identical; update both when changing the art',
)
assert.deepEqual(
  psWordmark,
  wordmarkLines,
  'install.sh and install.ps1 wordmarks must be identical; update both when changing the art',
)

// DSH 大字必须是 8 行（用户指定的高度）：太矮在并排时会被鲸鱼压住
assert.equal(wordmarkLines.length, 8, `the DSH wordmark must be 8 rows, got ${wordmarkLines.length}`)

// 并排后必须放得进 80 列终端，否则主菜单会被折行打乱
const bannerWidth = Math.max(...artLines.map((l) => [...l].length))
assert.ok(
  bannerWidth <= 80,
  `composed banner must fit an 80-column terminal, got ${bannerWidth} columns`,
)

// 文本 → 位图：每字符 1 宽 2 高
const cols = Math.max(...artLines.map((l) => [...l].length))
const rows = artLines.length * 2
const grid = []
for (const line of artLines) {
  const chars = [...line]
  const top = []
  const bottom = []
  for (let c = 0; c < cols; c++) {
    const ch = chars[c] ?? ' '
    top.push(ch === '█' || ch === '▀')
    bottom.push(ch === '█' || ch === '▄')
  }
  grid.push(top, bottom)
}
const on = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols ? grid[r][c] : false)

// 1) 必须有实心像素，否则画的是个空框
let filled = 0
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (on(r, c)) filled++
assert.ok(filled > 60, `banner must contain a solid shape, only ${filled} cells set`)

// 2) 关键：必须存在「被实心像素包围的空白」——那就是镂空。
//    只看内部区域（去掉最外一圈），找上下左右都有实心的空白格。
const hollow = []
for (let r = 1; r < rows - 1; r++) {
  for (let c = 1; c < cols - 1; c++) {
    if (on(r, c)) continue
    // 同一行左右各要有实心，同一列上下各要有实心：这是被包住的洞，不是外缘留白
    let left = false, right = false, up = false, down = false
    for (let k = c - 1; k >= 0; k--) if (on(r, k)) { left = true; break }
    for (let k = c + 1; k < cols; k++) if (on(r, k)) { right = true; break }
    for (let k = r - 1; k >= 0; k--) if (on(k, c)) { up = true; break }
    for (let k = r + 1; k < rows; k++) if (on(k, c)) { down = true; break }
    if (left && right && up && down) hollow.push([r, c])
  }
}
assert.ok(
  hollow.length >= 6,
  `banner must show enclosed hollow areas (belly and eye), found ${hollow.length}: the art likely collapsed into a solid silhouette`,
)

// 3) 眼睛那一处镂空应当靠近图案中部偏右上，且被实心环住；
//    腹部留白是最大的一块连通空白。这里只断言两者都存在。
//    腹部：面积最大的一组镂空
const seen = new Set()
const groups = []
for (const [r0, c0] of hollow) {
  const key = `${r0},${c0}`
  if (seen.has(key)) continue
  const stack = [[r0, c0]]
  const group = []
  seen.add(key)
  while (stack.length) {
    const [r, c] = stack.pop()
    group.push([r, c])
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr, nc = c + dc
      const nk = `${nr},${nc}`
      if (seen.has(nk)) continue
      if (hollow.some(([hr, hc]) => hr === nr && hc === nc)) { seen.add(nk); stack.push([nr, nc]) }
    }
  }
  groups.push(group)
}
groups.sort((a, b) => b.length - a.length)
assert.ok(
  groups[0].length >= 5,
  `the largest hollow (belly) must span several cells, got ${groups[0].length}`,
)
assert.ok(
  groups.length >= 2,
  `expected at least two separate hollows (belly and eye), got ${groups.length}`,
)

console.log(
  `banner smoke: ok (${filled} filled cells, ${hollow.length} hollow cells in ${groups.length} areas, largest ${groups[0].length})`,
)
