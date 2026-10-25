/* 图片 OCR：tesseract.js 已随应用本地化（public/tesseract + public/tessdata），离线可用、无 CDN 依赖 */

let modPromise = null
async function loadTesseract() {
  if (!modPromise) {
    modPromise = (async () => {
      const mod = await import('tesseract.js')
      const T =
        mod && typeof mod.createWorker === 'function'
          ? mod
          : mod && mod.default && typeof mod.default.createWorker === 'function'
            ? mod.default
            : null
      if (T) return T
      throw new Error('构建中未找到 createWorker')
    })()
  }
  return modPromise
}

let workerPromise = null
let activeProgress = null

/** 资产随应用打包（public/），运行时解析为绝对 URL（dev 与 dist 任意子路径均可）；
 *  file:// 直接打开 dist 时浏览器禁止创建 Worker，OCR 需通过 http 访问。 */
function assetUrl(rel) {
  return new URL(rel, document.baseURI).href
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = await loadTesseract()
      return Tesseract.createWorker('chi_sim', 1, {
        workerPath: assetUrl('tesseract/worker.min.js'),
        corePath: assetUrl('tesseract/core/tesseract-core-simd.wasm.js'),
        langPath: assetUrl('tessdata'),
        logger: (m) => {
          if (activeProgress && m.status) {
            try {
              activeProgress({ status: m.status, progress: m.progress || 0 })
            } catch {
              /* 进度回调异常忽略 */
            }
          }
        },
      })
    })()
  }
  return workerPromise
}

let chain = Promise.resolve()

/** 识别图片文字（任务串行执行）；onProgress 收到 { status, progress } */
export function ocrImageToText(file, onProgress) {
  const run = async () => {
    activeProgress = onProgress || null
    try {
      const worker = await getWorker()
      const { data } = await worker.recognize(file)
      return data.text || ''
    } finally {
      activeProgress = null
    }
  }
  const p = chain.then(run, run)
  chain = p.then(
    () => {},
    () => {},
  )
  return p
}
