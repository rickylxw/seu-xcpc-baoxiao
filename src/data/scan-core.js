/* 照片扫描增强·纯像素核心（浏览器/服务器共用，零 DOM 依赖）：
   边缘检测找证件四角 → 透视矫正 → 自适应黑白 / 灰度增强。
   输入输出都是 RGBA 像素数组；解码/编码由调用方负责（浏览器 canvas、服务器 jpeg-js/pngjs）。
   算法流程：缩小检测 → 灰度 → Otsu 二值 → 最大连通亮域 → 逐行极值点凸包 → 最大面积四边形
   → 8 参数单应矩阵 → 逆映射采样 → 自适应二值化（黑白）或对比度拉伸（灰度）。
   找不到可信证件边缘时回退为整图增强（不误裁）。 */

export function toGray(data, n) {
  const g = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  return g
}

export function otsuThreshold(g) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < g.length; i++) hist[Math.min(255, Math.max(0, g[i] | 0))]++
  const total = g.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let thr = 128
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      thr = i
    }
  }
  return thr
}

/** 最大连通亮域（4 邻域 BFS），返回 { bestId, bestSize, label } */
export function largestComponent(mask, W, H) {
  const label = new Int32Array(mask.length).fill(-1)
  const queue = new Int32Array(mask.length)
  let bestSize = 0
  let bestId = -1
  let id = 0
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || label[seed] !== -1) continue
    let head = 0
    let tail = 0
    queue[tail++] = seed
    label[seed] = id
    let size = 0
    while (head < tail) {
      const p = queue[head++]
      size++
      const x = p % W
      const y = (p / W) | 0
      if (x > 0 && mask[p - 1] && label[p - 1] === -1) {
        label[p - 1] = id
        queue[tail++] = p - 1
      }
      if (x < W - 1 && mask[p + 1] && label[p + 1] === -1) {
        label[p + 1] = id
        queue[tail++] = p + 1
      }
      if (y > 0 && mask[p - W] && label[p - W] === -1) {
        label[p - W] = id
        queue[tail++] = p - W
      }
      if (y < H - 1 && mask[p + W] && label[p + W] === -1) {
        label[p + W] = id
        queue[tail++] = p + W
      }
    }
    if (size > bestSize) {
      bestSize = size
      bestId = id
    }
    id++
  }
  return { bestId, bestSize, label }
}

/** 连通域的逐行左右极值点 → Andrew 单调链凸包 */
export function convexHullOfComponent(mask, label, W, H, compId) {
  const pts = []
  for (let y = 0; y < H; y++) {
    let minX = -1
    let maxX = -1
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] && label[y * W + x] === compId) {
        if (minX === -1) minX = x
        maxX = x
      }
    }
    if (minX !== -1) {
      pts.push({ x: minX, y })
      if (maxX !== minX) pts.push({ x: maxX, y })
    }
  }
  if (pts.length < 4) return null
  pts.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  return hull.length >= 4 ? hull : null
}

const crossZ = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** 凸包内最大面积四边形（以凸包点对为对角线，两侧各取最远点） */
export function maxAreaQuad(hull) {
  const n = hull.length
  if (n < 4) return null
  const area2 = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
  let best = null
  let bestArea = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ax = hull[i].x
      const ay = hull[i].y
      const bx = hull[j].x
      const by = hull[j].y
      const dx = bx - ax
      const dy = by - ay
      let p1 = null
      let d1 = 0
      let p2 = null
      let d2 = 0
      for (const p of hull) {
        const cross = dx * (p.y - ay) - dy * (p.x - ax)
        const dist = Math.abs(cross)
        if (cross > 0 && dist > d1) {
          d1 = dist
          p1 = p
        } else if (cross < 0 && dist > d2) {
          d2 = dist
          p2 = p
        }
      }
      if (p1 && p2) {
        const a = area2(p1, hull[i], p2) + area2(p2, hull[j], p1) + area2(hull[i], hull[j], p2) + area2(hull[j], hull[i], p1)
        if (a > bestArea) {
          bestArea = a
          best = [p1, p2, hull[j], hull[i]]
        }
      }
    }
  }
  return best
}

/** 四角按 左上/右上/右下/左下 排序 */
export function orderCorners(quad, W, H) {
  const sorted = [...quad].sort((a, b) => a.y + a.x / 10000 - (b.y + b.x / 10000))
  const top = sorted.slice(0, 2).sort((a, b) => a.x - b.x)
  const bottom = sorted.slice(-2).sort((a, b) => a.x - b.x)
  return { tl: top[0], tr: top[1], br: bottom[1], bl: bottom[0], W, H }
}

/** 解 8 参数单应矩阵（src 四角 → dst 四角，DLT + 高斯消元） */
export function solveHomography(src, dst) {
  const A = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: X, y: Y } = dst[i]
    A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x, x])
    A.push([0, 0, 0, X, Y, 1, -X * y, -Y * y, y])
  }
  // 高斯消元求 A · h = 0 的单位解
  const n = 8
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    const p = A[col][col]
    if (Math.abs(p) < 1e-12) return null
    for (let c = col; c <= n; c++) A[col][c] /= p
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const f = A[r][col]
      if (!f) continue
      for (let c2 = col; c2 <= n; c2++) A[r][c2] -= f * A[col][c2]
    }
  }
  const h = []
  for (let i = 0; i < 8; i++) h.push(A[i][n])
  h.push(1)
  return h
}

export function applyHomography(h, x, y) {
  const X = (h[0] * x + h[1] * y + h[2]) / (h[6] * x + h[7] * y + 1)
  const Y = (h[3] * x + h[4] * y + h[5]) / (h[6] * x + h[7] * y + 1)
  return { x: X, y: Y }
}

/** 检测 RGBA 图中证件的四角。失败返回 null */
export function detectQuadRgba(data, W, H) {
  const n = W * H
  const gray = toGray(data, n)
  const thr = otsuThreshold(gray)
  // 文档 = 与中心亮度同类的最大连通域
  const cx = (W / 2) | 0
  const cy = (H / 2) | 0
  const centerBright = gray[cy * W + cx] > thr
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = centerBright ? gray[i] > thr ? 1 : 0 : gray[i] <= thr ? 1 : 0
  const { bestId, bestSize, label } = largestComponent(mask, W, H)
  if (bestSize < n * 0.1) return null
  const hull = convexHullOfComponent(mask, label, W, H, bestId)
  if (!hull) return null
  const quad = maxAreaQuad(hull)
  if (!quad) return null
  const area2pt = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
  const qArea = (area2pt(quad[0], quad[1], quad[2]) + area2pt(quad[0], quad[2], quad[3])) / 2
  if (qArea < n * 0.12) return null
  const ordered = orderCorners(quad, W, H)
  return { tl: { x: ordered.tl.x, y: ordered.tl.y }, tr: { x: ordered.tr.x, y: ordered.tr.y }, br: { x: ordered.br.x, y: ordered.br.y }, bl: { x: ordered.bl.x, y: ordered.bl.y } }
}

/** 盒式均值缩小 RGBA（最近邻足够，检测/预缩放用） */
export function downscaleRgba(data, W, H, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const sy0 = Math.floor((y * H) / outH)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / outH))
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor((x * W) / outW)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / outW))
      let r = 0
      let g = 0
      let b = 0
      let cnt = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4
          r += data[si]
          g += data[si + 1]
          b += data[si + 2]
          cnt++
        }
      }
      const di = (y * outW + x) * 4
      out[di] = r / cnt
      out[di + 1] = g / cnt
      out[di + 2] = b / cnt
      out[di + 3] = 255
    }
  }
  return out
}

/** 自适应二值化（积分图局部均值，黑白扫描件效果）——直接改写 RGBA */
export function adaptiveBinarize(data, W, H) {
  const n = W * H
  const gray = new Float32Array(n)
  for (let i = 0; i < n; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  // 积分图
  const integral = new Float64Array((W + 1) * (H + 1))
  for (let y = 0; y < H; y++) {
    let rowSum = 0
    for (let x = 0; x < W; x++) {
      rowSum += gray[y * W + x]
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + rowSum
    }
  }
  const win = Math.max(8, Math.round(W / 20))
  const offset = 10
  for (let y = 0; y < H; y++) {
    const y1 = Math.max(0, y - win)
    const y2 = Math.min(H - 1, y + win)
    for (let x = 0; x < W; x++) {
      const x1 = Math.max(0, x - win)
      const x2 = Math.min(W - 1, x + win)
      const count = (x2 - x1 + 1) * (y2 - y1 + 1)
      const sum =
        integral[(y2 + 1) * (W + 1) + x2 + 1] - integral[y1 * (W + 1) + x2 + 1] - integral[(y2 + 1) * (W + 1) + x1] + integral[y1 * (W + 1) + x1]
      const i = (y * W + x) * 4
      const v = gray[y * W + x] < (sum / count) * (1 - offset / 255) ? 0 : 255
      data[i] = data[i + 1] = data[i + 2] = v
    }
  }
}

/** 灰度增强：2%~98% 分位对比度拉伸 */
export function contrastStretch(data) {
  const n = data.length / 4
  const hist = new Array(256).fill(0)
  for (let i = 0; i < n; i++) {
    const v = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0
    hist[v]++
  }
  let lo = 0
  let hi = 255
  let acc = 0
  const cut = n * 0.02
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc > cut) {
      lo = v
      break
    }
  }
  acc = 0
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc > cut) {
      hi = v
      break
    }
  }
  const scale = hi > lo ? 255 / (hi - lo) : 1
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (data[i * 4 + c] - lo) * scale
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
}

/**
 * 扫描增强主入口（纯像素）：边缘检测 → 透视矫正 → 黑白 / 灰度增强。
 * 返回 { data(RGBA), width, height, quadFound }；找不到证件边缘时 quadFound=false（整图增强）。
 */
export function enhanceRgba(srcData, srcW, srcH, { mode = 'bw', maxSide = 2400, detectSide = 420, inputCap = 3000 } = {}) {
  // 超大图先降采样，控制内存峰值（服务器无 GPU，12MP 原图积分图会吃掉上百 MB）
  let W = srcW
  let H = srcH
  let data = srcData
  if (Math.max(W, H) > inputCap) {
    const k = inputCap / Math.max(W, H)
    const nW = Math.max(1, Math.round(W * k))
    const nH = Math.max(1, Math.round(H * k))
    data = downscaleRgba(data, W, H, nW, nH)
    W = nW
    H = nH
  }
  // 检测用小图（最近邻缩到 detectSide）
  const dk = Math.min(1, detectSide / Math.max(W, H))
  const dW = Math.max(1, Math.round(W * dk))
  const dH = Math.max(1, Math.round(H * dk))
  const detData = dk < 1 ? downscaleRgba(data, W, H, dW, dH) : data
  const quad = detectQuadRgba(detData, dW, dH)
  // 输出尺寸：按四角边长估算，限制上限
  let outW = W
  let outH = H
  if (quad) {
    const wTop = Math.hypot(quad.tl.x - quad.tr.x, quad.tl.y - quad.tr.y) / dk
    const wBot = Math.hypot(quad.bl.x - quad.br.x, quad.bl.y - quad.br.y) / dk
    const hL = Math.hypot(quad.tl.x - quad.bl.x, quad.tl.y - quad.bl.y) / dk
    const hR = Math.hypot(quad.tr.x - quad.br.x, quad.tr.y - quad.br.y) / dk
    outW = Math.round(Math.max(wTop, wBot))
    outH = Math.round(Math.max(hL, hR))
  }
  const k = Math.min(1, maxSide / Math.max(outW, outH))
  outW = Math.max(400, Math.round(outW * k))
  outH = Math.max(400, Math.round(outH * k))
  // 单应：输出四角 → 源图四角（检测坐标 × 全分辨率/检测缩放）
  const kFull = W / dW || 1
  const srcQuad = quad
    ? {
        tl: { x: quad.tl.x * kFull, y: quad.tl.y * kFull },
        tr: { x: quad.tr.x * kFull, y: quad.tr.y * kFull },
        br: { x: quad.br.x * kFull, y: quad.br.y * kFull },
        bl: { x: quad.bl.x * kFull, y: quad.bl.y * kFull },
      }
    : null
  const out = new Uint8ClampedArray(outW * outH * 4)
  if (srcQuad) {
    const dstQuad = [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ]
    // 解「输出 → 源」映射用于采样：solveHomography(A, B) 返回 B 空间 → A 空间的单应
    const h = solveHomography([srcQuad.tl, srcQuad.tr, srcQuad.br, srcQuad.bl], dstQuad)
    if (h) {
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const p = applyHomography(h, x, y)
          const sx = Math.max(0, Math.min(W - 1, Math.round(p.x)))
          const sy = Math.max(0, Math.min(H - 1, Math.round(p.y)))
          const si = (sy * W + sx) * 4
          const di = (y * outW + x) * 4
          out[di] = data[si]
          out[di + 1] = data[si + 1]
          out[di + 2] = data[si + 2]
          out[di + 3] = 255
        }
      }
    } else {
      out.set(data.subarray(0, Math.min(data.length, out.length)))
    }
  } else {
    // 无四角：整图按输出尺寸最近邻缩放
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(H - 1, Math.round((y * H) / outH))
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(W - 1, Math.round((x * W) / outW))
        const si = (sy * W + sx) * 4
        const di = (y * outW + x) * 4
        out[di] = data[si]
        out[di + 1] = data[si + 1]
        out[di + 2] = data[si + 2]
        out[di + 3] = 255
      }
    }
  }
  if (mode === 'bw') adaptiveBinarize(out, outW, outH)
  else contrastStretch(out)
  return { data: out, width: outW, height: outH, quadFound: !!quad }
}
