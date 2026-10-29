/* 识别：文本型 PDF 提取文字；扫描件 PDF 抽取内嵌图片走 OCR；图片走 OCR；OFD 发票解析 XML 文字 */

// 全篇文本提取在主线程完成（fake worker）：
// 部分内嵌浏览器里 pdf.js 的真实 worker 会握手挂起，主线程模式实测稳定。
import * as pdfjsLib from 'pdfjs-dist'
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs'

globalThis.pdfjsWorker = pdfjsWorker

import { ocrImageToText } from './ocr'
import { readZipEntries } from './unzip'
import { recognizeViaServer } from './serverRecog'
import { state, recogStats } from '../store'

/** 提取 PDF 文本（最多前 5 页）；失败抛出异常 */
export async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjsLib.getDocument({ data }).promise
  let text = ''
  const max = Math.min(doc.numPages, 5)
  for (let i = 1; i <= max; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    text += tc.items.map((it) => it.str).join('')
  }
  return text
}

/** 扫描件 PDF：把某页的内嵌图片（整页扫描图）提取为 Blob；失败返回 null */
async function extractPdfPageImage(file, pageNum) {
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjsLib.getDocument({ data }).promise
  const page = await doc.getPage(pageNum)
  const opList = await page.getOperatorList()
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] !== pdfjsLib.OPS.paintImageXObject) continue
    const id = opList.argsArray[i][0]
    let img = null
    try {
      img = page.objs.has(id) ? page.objs.get(id) : null
    } catch {
      img = null
    }
    if (!img || !img.data || !img.width || !img.height) continue
    // 数据可能是 RGB（3字节/像素）或 RGBA
    let rgba
    if (img.kind === 3) {
      // GRAYSCALE_1BPP 特殊处理跳过，仅支持 RGB/RGBA
      continue
    }
    if (img.kind === 1 || img.data.length === img.width * img.height * 4) {
      rgba = new Uint8ClampedArray(img.data.buffer || img.data)
      if (img.data.length === img.width * img.height * 3) {
        rgba = new Uint8ClampedArray(img.width * img.height * 4)
        for (let p = 0, q = 0; p < img.data.length; p += 3, q += 4) {
          rgba[q] = img.data[p]
          rgba[q + 1] = img.data[p + 1]
          rgba[q + 2] = img.data[p + 2]
          rgba[q + 3] = 255
        }
      }
    } else {
      continue
    }
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d').putImageData(new ImageData(rgba, img.width, img.height), 0, 0)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob
  }
  return null
}

/** OFD 发票（zip + XML）文字提取：读取 Pages/Attachs 里的 TextCode 文本 */
export async function extractOfdText(file) {
  const items = await extractOfdTextItems(file)
  return items.join('')
}

/** 按页面顺序提取 OFD 的 TextCode 文本片段（数组，保持原始顺序） */
export async function extractOfdTextItems(file) {
  const entries = await readZipEntries(file)
  const pageFiles = entries
    .filter((e) => /Doc_\d+\/Pages\/Page_\d+\/Content\.xml$/i.test(e.name))
    .sort((a, b) => {
      const num = (x) => Number(x.name.match(/Page_(\d+)/i)?.[1] || 0)
      return num(a) - num(b)
    })
  const out = []
  for (const e of pageFiles) {
    const xml = new TextDecoder('utf-8').decode(e.data)
    const re = /<(?:[\w-]+:)?TextCode[^>]*>([^<]*)</g
    let m
    while ((m = re.exec(xml))) {
      const t = m[1].trim()
      if (t) out.push(t)
    }
  }
  return out
}

/** 从文本里识别金额候选与同学归属：实现已抽到 core.js（见下方 import） */

const isImageFile = (name) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(name)

// 纯检查/提取函数（detect*/抬头/舱位/起讫地等）已抽到 core.js（服务器零依赖复用）
import {
  detectAmounts,
  detectMembers,
  INVOICE_HEADER_SLOTS,
  PAY_PARTY_SLOTS,
  SCOPE_TRANSPORT_SLOTS,
  invoiceHeaderCheck,
  cabinCheck,
  trainSeatCheck,
  extractParty,
  routeScopeCheck,
} from '../data/core.js'

export { detectAmounts, detectMembers, extractParty, routeScopeCheck }

/** 从「所到省份、城市」（如「吉林省 长春市」）取出城市名，用于起讫地匹配 */
function destCityOf() {
  const place = String((state.approval && state.approval.place) || '').trim()
  if (!place) return ''
  const last = place.split(/[\s,，、/]+/).filter(Boolean).pop() || ''
  return last.replace(/(市|地区|自治州|盟|旗)$/, '') || last
}

/** 识别完成后按起讫地自动勾选去程 / 返程（仅往返交通材料；结果记入 meta.scopeAuto 供界面展示） */
function applyAutoScope(fileObj, text) {
  if (!SCOPE_TRANSPORT_SLOTS.includes(fileObj.slot)) return
  // 文件名已明确去/返（批量导入时按提示预勾，只剩一项）时不覆盖
  if ((fileObj.scope || []).length === 1) return
  const rs = routeScopeCheck(text, state.meta.homeCity, destCityOf())
  if (!rs) return
  fileObj.scope = rs.scope === 'both' ? ['outbound', 'return'] : [rs.scope]
  fileObj.meta.scopeAuto = rs.label
}

/** 识别结果写入 file 对象的 meta 字段（异步；错误记录在 meta.error；via 标记识别方式） */
/** 计时包装：统计总数/完成数/并发数/近期耗时，供界面显示进度与预计结束时间 */
export async function recognizeInto(fileObj, members, cfg = null, slotName = '') {
  recogStats.total++
  recogStats.running++
  if (!recogStats.startedAt) recogStats.startedAt = Date.now()
  const t0 = Date.now()
  try {
    return await recognizeIntoImpl(fileObj, members, cfg, slotName)
  } finally {
    recogStats.running--
    recogStats.done++
    recogStats.durationsMs.push(Date.now() - t0)
    if (recogStats.durationsMs.length > 20) recogStats.durationsMs.shift()
  }
}

async function recognizeIntoImpl(fileObj, members, cfg = null, slotName = '') {
  const name = fileObj.file.name
  const isImage = isImageFile(name)
  const isPdfFile = /\.pdf$/i.test(name)
  let serverErr = null // 服务器路径失败原因（本地回退后仍展示，便于排查）

  // 启用服务器端模型时：图片与扫描件（无文字层 PDF）改走服务端识别，失败回退本地
  if (cfg && cfg.enabled && cfg.baseUrl && (isImage || isPdfFile)) {
    fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: 'server', status: '服务器识别中…', progress: 0 }
    try {
      const r = await recognizeViaServer(fileObj.file, members, cfg)
      fileObj.meta = {
        busy: false,
        error: '',
        note: r.amounts.length || r.detected.length ? '' : '服务器未识别到有效信息',
        amounts: r.amounts,
        members: r.detected,
        // 抬头只对发票槽位有意义；经济舱只对机票发票/订单有意义——支付记录等一律不检查
        header: INVOICE_HEADER_SLOTS.includes(fileObj.slot) && r.header ? r.header : null,
        cabin:
          (fileObj.slot === 'f_invoice' || fileObj.slot === 'f_order') &&
          r.cabin &&
          typeof r.cabin.ok === 'boolean'
            ? r.cabin
            : null,
        trainSeat: null,
        via: 'server',
        serverError: serverErr,
      }
      if (r.amounts.length && !fileObj.amount) fileObj.amount = String(r.amounts[0].replace('¥', ''))
      if (r.detected.length) fileObj.members = r.detected.map((d) => d.i)
      applyAutoScope(fileObj, r.text || '')
      applyParty(fileObj, r.text || '')
      return
    } catch (e) {
      serverErr = (e && e.message) || String(e)
      fileObj.meta = {
        busy: true,
        error: '服务器识别失败：' + serverErr,
        amounts: [],
        members: [],
        via: 'local',
        status: '回退本地识别…',
        progress: 0,
      }
    }
  }

  if (isPdfFile) {
    fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: 'local', status: '读取 PDF 文字…', progress: 0 }
    try {
      let text = await extractPdfText(fileObj.file)
      let ocrNote = ''
      // 扫描件 / 图片型 PDF：没有文字层，抽取每页内嵌图片（最多前 3 页），
      // 服务端模型启用时逐页送服务端识别，否则回退浏览器内 OCR。
      // 部分浏览器渲染不可用（超时），会跳过并提示改用图片上传。
      if (text.replace(/\s+/g, '').length < 8) {
        const serverOn = cfg && cfg.enabled && cfg.baseUrl
        // 1) 抽取页面内嵌图片（扫描件每页一张大图）
        const pageImages = []
        for (let p = 1; p <= 3; p++) {
          fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: serverOn ? 'server' : 'local', status: `第 ${p} 页转图片…`, progress: (p - 1) / 3 }
          let imgBlob = null
          try {
            imgBlob = await Promise.race([
              extractPdfPageImage(fileObj.file, p),
              new Promise((_, rej) => setTimeout(() => rej(new Error('渲染超时')), 10000)),
            ])
          } catch {
            imgBlob = null
          }
          if (imgBlob) pageImages.push(imgBlob)
        }
        // 2) 逐页识别：服务端优先，回退本地 tesseract
        let ocrText = ''
        if (pageImages.length) {
          for (const [pi, imgBlob] of pageImages.entries()) {
            let pageText = ''
            if (serverOn) {
              fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: 'server', status: `服务端识别第 ${pi + 1} 页…`, progress: (pi + 0.5) / pageImages.length }
              try {
                const r = await recognizeViaServer(imgBlob, members, cfg)
                pageText = r.text || ''
              } catch {
                pageText = '' // 单页失败继续下一页
              }
            }
            if (!pageText) {
              fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: 'local', status: `本地 OCR 第 ${pi + 1} 页…`, progress: (pi + 0.5) / pageImages.length }
              pageText = await ocrImageToText(imgBlob, (pr) => {
                fileObj.meta = { ...fileObj.meta, busy: true, status: `本地 OCR 第 ${pi + 1} 页…`, progress: (pi + pr.progress) / pageImages.length }
              })
            }
            ocrText += pageText + '\n'
          }
        }
        if (ocrText.replace(/\s+/g, '').length >= 8) text = ocrText
        else if (!ocrNote) ocrNote = pageImages.length ? '页面图片识别失败' : '未提取到文字（可能是扫描件）。当前浏览器无法解析扫描件页面，请截图后以图片上传'
      }
      const amounts = detectAmounts(text)
      const detected = detectMembers(text, members)
      fileObj.meta = {
        busy: false,
        error: '',
        note: text ? '' : ocrNote || '未提取到文字',
        amounts,
        members: detected,
        header: invoiceHeaderCheck(fileObj.slot, slotName, fileObj.file.name, text),
        cabin: cabinCheck(fileObj.slot, text),
        trainSeat: trainSeatCheck(fileObj.slot, text),
        serverError: serverErr,
      }
      if (amounts.length && !fileObj.amount) fileObj.amount = String(amounts[0].replace('¥', ''))
      if (detected.length) fileObj.members = detected.map((m) => m.i)
      applyAutoScope(fileObj, text)
      applyParty(fileObj, text)
    } catch (e) {
      fileObj.meta = { busy: false, error: (e && e.message) || String(e), note: '', amounts: [], members: [] }
    }
    return
  }

  if (/\.ofd$/i.test(name)) {
    fileObj.meta = { busy: true, error: '', amounts: [], members: [], status: '解析 OFD…', progress: 0 }
    try {
      const { extractOfdText } = await import('./ofd')
      const text = await extractOfdText(fileObj.file)
      const amounts = detectAmounts(text)
      const detected = detectMembers(text, members)
      fileObj.meta = {
        busy: false,
        error: '',
        note: text ? '' : 'OFD 内未提取到文字（可能是纯图片版式）',
        amounts,
        members: detected,
        header: invoiceHeaderCheck(fileObj.slot, slotName, fileObj.file.name, text),
        cabin: cabinCheck(fileObj.slot, text),
        trainSeat: trainSeatCheck(fileObj.slot, text),
      }
      // 与 PDF / 图片分支一致：识别结果回填金额与归属
      if (amounts.length && !fileObj.amount) fileObj.amount = String(amounts[0].replace('¥', ''))
      if (detected.length) fileObj.members = detected.map((m) => m.i)
      applyAutoScope(fileObj, text)
      applyParty(fileObj, text)
    } catch (e) {
      fileObj.meta = { busy: false, error: 'OFD 解析失败：' + ((e && e.message) || String(e)), note: '', amounts: [], members: [] }
    }
    return
  }

  if (isImageFile(name)) {
    fileObj.meta = { busy: true, error: '', amounts: [], members: [], via: 'local', status: '准备 OCR…', progress: 0 }
    try {
      const text = await ocrImageToText(fileObj.file, (p) => {
        fileObj.meta = { ...fileObj.meta, busy: true, status: p.status, progress: p.progress }
      })
      const amounts = detectAmounts(text)
      const detected = detectMembers(text, members)
      fileObj.meta = {
        busy: false,
        error: '',
        note: text ? '' : '未识别到文字，请确保图片清晰、文字方向正确',
        amounts,
        members: detected,
        header: invoiceHeaderCheck(fileObj.slot, slotName, fileObj.file.name, text),
        cabin: cabinCheck(fileObj.slot, text),
        trainSeat: trainSeatCheck(fileObj.slot, text),
        serverError: serverErr,
      }
      if (amounts.length && !fileObj.amount) fileObj.amount = String(amounts[0].replace('¥', ''))
      if (detected.length) fileObj.members = detected.map((m) => m.i)
      applyAutoScope(fileObj, text)
      applyParty(fileObj, text)
    } catch (e) {
      fileObj.meta = {
        busy: false,
        error: 'OCR 失败：' + ((e && e.message) || String(e)) + '（OCR 引擎与中文模型已内置；若以 file:// 方式打开请改用 http 访问或使用服务器识别）',
        note: '',
        amounts: [],
        members: [],
      }
    }
    return
  }

  fileObj.meta = { busy: false, error: '', note: '非 PDF / 图片文件，暂不支持自动识别', amounts: [], members: [] }
}
