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

/** 从文本里识别金额候选（¥/￥/元，以及 金额/合计/实付 等关键词后的数字），按金额降序，最多 3 个 */
export function detectAmounts(text) {
  if (!text) return []
  // OCR 文本常在字符间插入空格（如「金 额 : ¥1216.50」），先去空白再匹配
  const norm = text.replace(/\s+/g, '')
  const found = new Set()
  const re1 = /(￥|¥)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)|([0-9]+(?:\.[0-9]{1,2})?)\s*元/g
  let m
  while ((m = re1.exec(norm))) {
    const n = (m[2] || m[3]).replace(/,/g, '')
    const v = parseFloat(n)
    if (Number.isFinite(v) && v > 0) found.add(v)
  }
  const re2 = /(?:金额|合计|实付|总价|总额)[^\d]{0,4}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/g
  while ((m = re2.exec(norm))) {
    const v = parseFloat(m[1].replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) found.add(v)
  }
  return [...found].sort((a, b) => b - a).slice(0, 3).map((v) => '¥' + v.toFixed(2))
}

/** 从文本里匹配同学清单中的姓名（忽略空白，兼容 OCR 插空） */
export function detectMembers(text, members) {
  if (!text) return []
  const norm = text.replace(/\s+/g, '')
  return members
    .map((m, i) => ({ i, name: m.name }))
    .filter((m) => m.name && norm.includes(m.name))
}

const isImageFile = (name) => /\.(jpe?g|png|gif|webp|bmp)$/i.test(name)

const SCHOOL = '东南大学'
const TAX_ID = '12100000466006770Q'

/** 需要做发票抬头检查的槽位（支付记录、行程单、车票凭证等一律不查抬头） */
export const INVOICE_HEADER_SLOTS = ['f_invoice', 'h_invoice', 'l_invoice', 'fee_invoice']

/**
 * 发票抬头检查：仅对发票类槽位（名称含「发票」）生效，检查是否含「东南大学」或税号。
 * 支付记录即使截图文字里出现「发票」字样也不查。返回 { ok } 或 null（不适用/无法判断）。
 */
export function invoiceHeaderCheck(slotId, slotName, fileName, text) {
  if (!INVOICE_HEADER_SLOTS.includes(slotId)) return null
  const norm = (text || '').replace(/\s+/g, '')
  const hay = `${slotName || ''} ${fileName || ''} ${norm}`
  if (!/发票/.test(hay)) return null
  if (norm.length < 10) return null
  return { ok: norm.includes(SCHOOL) || norm.includes(TAX_ID) }
}

/**
 * 机票舱位检查：机票发票 / 机票订单记录（行程单）需显示「经济舱」字样（飞机仅限经济舱）。
 * 返回 { ok } 或 null（不适用/文字太少无法判断）。
 */
export function cabinCheck(slotId, text) {
  if (slotId !== 'f_invoice' && slotId !== 'f_order') return null
  const norm = (text || '').replace(/\s+/g, '')
  if (norm.length < 10) return null
  return { ok: norm.includes('经济舱') }
}

/** 火车票软检查：座位信息常为图片，识别到「二等座」时显示确认（不强制） */
export function trainSeatCheck(slotId, text) {
  if (slotId !== 't_voucher') return null
  const norm = (text || '').replace(/\s+/g, '')
  if (!norm) return null
  return norm.includes('二等座') ? { ok: true } : null
}

/** 支付类槽位（做收款方提取，供收付款核对） */
const PAY_PARTY_SLOTS = ['f_pay', 'h_pay', 'l_pay', 'fee_pay']

/**
 * 从识别文本提取单位名（「××公司/酒店/银行」等形式），labels 为候选标签。
 * 只认「标签 + 单位后缀」的严格形式；匹配不到就返回空（自动填入宁缺勿错，可手填）。
 */
export function extractParty(text, labels) {
  const norm = String(text || '').replace(/\s+/g, '')
  if (!norm) return ''
  for (const label of labels) {
    const m = norm.match(
      new RegExp(`${label}[名称：:]{0,3}([^，。；;、|\\d]{2,28}?(?:公司|银行|酒店|饭店|宾馆|商行|集团|中心|事务所|门市部))`),
    )
    if (m && m[1]) return m[1]
  }
  return ''
}

/** 识别完成后提取发票开票方（发票槽位）与支付收款方（支付槽位），写入 meta 供收付款核对预填 */
function applyParty(fileObj, text) {
  if (INVOICE_HEADER_SLOTS.includes(fileObj.slot)) {
    const issuer = extractParty(text, ['销售方', '开票方', '开票单位', '卖方', '开票人'])
    if (issuer) fileObj.meta.issuer = issuer
  }
  if (PAY_PARTY_SLOTS.includes(fileObj.slot)) {
    const payee = extractParty(text, ['收款方', '收款单位', '收款人', '商户', '对方'])
    if (payee) fileObj.meta.payee = payee
  }
}

/** 往返交通材料的槽位（可按起讫地自动勾选去程 / 返程） */
const SCOPE_TRANSPORT_SLOTS = ['f_invoice', 'f_pay', 'f_order', 't_voucher']

/** 从「所到省份、城市」（如「吉林省 长春市」）取出城市名，用于起讫地匹配 */
function destCityOf() {
  const place = String((state.approval && state.approval.place) || '').trim()
  if (!place) return ''
  const last = place.split(/[\s,，、/]+/).filter(Boolean).pop() || ''
  return last.replace(/(市|地区|自治州|盟|旗)$/, '') || last
}

/**
 * 按 OCR 文本里的起讫地判断去程 / 返程：
 * 只认真实路线分隔符（→、-、至、到、飞往、抵达…），在其两侧 24 字窗口内找出发/到达
 * 城市名；无分隔符命中时返回 null（宁可不自动勾选，也不凭城市共现瞎猜方向）。
 * 返回 { scope: 'outbound'|'return'|'both', label } 或 null（无法判断/未配置城市）。
 */
export function routeScopeCheck(text, homeCity, destCity) {
  const home = String(homeCity || '').trim()
  const dest = String(destCity || '').trim()
  if (!home || !dest) return null
  const norm = String(text || '').replace(/\s+/g, '')
  if (norm.length < 4) return null
  let out = false
  let back = false
  const seps = [...norm.matchAll(/[→⇒➔➤↦\-–—~～]|至|到|飞往|飞抵|抵达|返回|出发/g)].map((m) => m.index)
  for (const p of seps) {
    const left = norm.slice(Math.max(0, p - 24), p)
    const right = norm.slice(p + 1, p + 25)
    if (left.includes(home) && right.includes(dest)) out = true
    if (left.includes(dest) && right.includes(home)) back = true
  }
  if (out && back) return { scope: 'both', label: `${home}⇄${dest}` }
  if (out) return { scope: 'outbound', label: `${home}→${dest}` }
  if (back) return { scope: 'return', label: `${dest}→${home}` }
  // 兜底：行程单 / 表格版式没有分隔符（如 OFD「南京 禄口 … 18:30 … 长春 龙嘉」列序），
  // 两城紧邻（48 字内）共现时按先出现者为出发地；相距远视为无关提及，不猜。
  const h = norm.indexOf(home)
  const d = norm.indexOf(dest)
  if (h !== -1 && d !== -1 && Math.abs(h - d) <= 48) {
    return h < d ? { scope: 'outbound', label: `${home}→${dest}` } : { scope: 'return', label: `${dest}→${home}` }
  }
  return null
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
