// 星空背景动画（登录页与管理面板共用）。
//
// 主题由 documentElement.dataset.theme 决定，每帧读取，因此深浅色切换无需重启动画。
// 尊重 prefers-reduced-motion：用户要求减少动效时不绘制任何粒子。
;(() => {
  const canvas = document.querySelector('.backdrop canvas')
  if (!canvas) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const ctx = canvas.getContext('2d')
  const root = document.documentElement
  let stars = []
  let w = 0
  let h = 0

  function palette() {
    return root.dataset.theme === 'light'
      ? { base: '57,100,254', alt: '103,158,254', maxA: 0.30, minA: 0.06, r: 1.15 }
      : { base: '210,224,255', alt: '103,140,255', maxA: 0.70, minA: 0.14, r: 1.4 }
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const p = palette()
    const n = Math.round((w * h) / 9000)
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * p.r + 0.3,
      a: Math.random() * (p.maxA - p.minA) + p.minA,
      v: Math.random() * 0.14 + 0.03,
      alt: Math.random() < 0.12,
    }))
  }

  let last = 0
  function tick(ts) {
    const dt = Math.min(ts - last, 50)
    last = ts
    const p = palette()
    ctx.clearRect(0, 0, w, h)
    for (const s of stars) {
      s.y -= s.v * (dt / 16)
      if (s.y < -3) {
        s.y = h + 3
        s.x = Math.random() * w
      }
      const tw = 0.55 + 0.45 * Math.sin(ts / 1600 + s.x)
      ctx.beginPath()
      ctx.fillStyle = `rgba(${s.alt ? p.alt : p.base},${(s.a * tw).toFixed(3)})`
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      ctx.fill()
    }
    requestAnimationFrame(tick)
  }

  new ResizeObserver(resize).observe(canvas)
  resize()
  requestAnimationFrame(tick)
})()
