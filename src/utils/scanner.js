/* 照片扫描增强（扫描全能王式）浏览器封装：canvas 解码/编码 + 纯像素核心（scan-core.js）。
   算法本体（四角检测/透视矫正/二值化）在 scan-core.js，服务器端复用同一实现。 */

import { enhanceRgba } from '../data/scan-core.js'

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

function imageDataOf(img) {
  const cv = document.createElement('canvas')
  cv.width = img.width
  cv.height = img.height
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, cv.width, cv.height)
}

function toBlob(cv, mime, quality) {
  return new Promise((r) => cv.toBlob((b) => r(b), mime, quality))
}

/**
 * 扫描增强主入口：边缘检测 → 透视矫正 → 黑白 / 灰度增强。
 * 返回 { blob, mime, quadFound, width, height }；找不到证件边缘时 quadFound=false（整图增强）。
 */
export async function scanDocument(file, { mode = 'bw' } = {}) {
  const img = await loadImageEl(file)
  const src = imageDataOf(img)
  const { data, width, height, quadFound } = enhanceRgba(src.data, src.width, src.height, { mode })
  const outCv = document.createElement('canvas')
  outCv.width = width
  outCv.height = height
  const octx = outCv.getContext('2d', { willReadFrequently: true })
  octx.putImageData(new ImageData(data, width, height), 0, 0)
  const mime = mode === 'bw' ? 'image/png' : 'image/jpeg'
  const blob = await toBlob(outCv, mime, mode === 'bw' ? undefined : 0.92)
  return { blob, mime, quadFound, width, height }
}
