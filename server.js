// 部署服务器：静态托管 dist/ + 识别代理（浏览器 → 本服务器 → 本机 Ollama）
// 用法：npm run build && node server.js
// 环境变量：PORT（默认 8080）、OLLAMA_URL（默认 http://127.0.0.1:11434）、OLLAMA_NUM_CTX（默认 8192）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as Core from './src/data/core.js'
import { sanitizeName, parseMembersCSV } from './src/utils/misc.js'
import { readZipEntries } from './src/utils/unzip.js'
import { renderOfd } from './src/utils/ofd.js'
import { rgb, PDFDocument } from 'pdf-lib'
import jpegCodec from 'jpeg-js'
import { PNG } from 'pngjs'
import { enhanceRgba } from './src/data/scan-core.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 8080)
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers })
  res.end(body)
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' })
}

function readBody(req, limitMB = 64) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitMB * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// OpenAI 格式 → Ollama 原生 /api/chat 格式（图片 data URL → images 数组；自动扩 num_ctx）
function toOllamaChat(body) {
  const messages = (body.messages || []).map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    let text = ''
    const images = []
    for (const part of m.content || []) {
      if (part.type === 'text') text += part.text
      else if (part.type === 'image_url') {
        const url = part.image_url?.url || ''
        const i = url.indexOf('base64,')
        if (i >= 0) images.push(url.slice(i + 'base64,'.length))
      }
    }
    return { role: m.role, content: text, ...(images.length ? { images } : {}) }
  })
  return {
    model: body.model,
    stream: false,
    messages,
    options: { num_ctx: NUM_CTX },
  }
}

// ---- AI Agent 会话实现 ----
const SESSION_TTL = 30 * 24 * 3600 * 1000 // 闲置过期一个月：每次携带 token 的请求自动续期
const MAX_SESSIONS = 200
const sessions = new Map() // token → session

// ---- 会话持久化（反馈 2：进程重启不再丢会话）----
// 会话对象可 JSON 序列化（bytes 存 base64）；变更即标脏，1 秒防抖写盘（另留 30 秒兜底扫描），
// SIGINT/SIGTERM/exit 时同步保存。lastSeen 一并持久化，重启后过期时间显示不失效。
const SESSIONS_FILE = path.join(__dirname, 'agent-sessions.json')
let sessionsDirty = false
let flushTimer = null
function markSessionsDirty() {
  sessionsDirty = true
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushSessions().catch((e) => console.error('[sessions] 落盘失败:', String(e)))
    }, 1000)
    flushTimer.unref?.()
  }
}
function serializeSessions() {
  const out = {}
  for (const [t, s] of sessions) {
    // pg.legs[].files 与顶层 files 是同一批对象（上传时同一引用 push 两处）；
    // 字节只在顶层 files 存一份 base64，pg 侧剥离 bytes，载入后按 id 重新挂回同一引用。
    // （旧版把 pg 整体 JSON.stringify，Uint8Array 变成 {"0":12,...} 数字对象，重启后字节全坏且体积膨胀）
    const pg = JSON.parse(JSON.stringify(s.pg, (k, v) => (k === 'bytes' ? undefined : v)))
    out[t] = {
      created: s.created,
      lastSeen: s.lastSeen || s.created,
      st: s.st,
      pg,
      files: s.files.map((f) => ({ ...f, bytes: Buffer.from(f.bytes).toString('base64') })),
    }
  }
  return JSON.stringify(out)
}
async function flushSessions() {
  if (!sessionsDirty || !sessions.size) return
  sessionsDirty = false
  // 原子写：先写临时文件再 rename，防写盘中途进程重启把存档截断（截断的 JSON 会让下次启动静默丢全部会话）
  const tmp = SESSIONS_FILE + '.tmp'
  await fs.promises.writeFile(tmp, serializeSessions())
  await fs.promises.rename(tmp, SESSIONS_FILE)
}
function loadSessions() {
  const bytesOf = (b) => {
    // base64（现行格式）；或 {"0":12,...} 数字对象（旧版 pg 内联字节的损坏形态，值仍全在，直接还原）
    if (typeof b === 'string') return new Uint8Array(Buffer.from(b, 'base64'))
    if (b && typeof b === 'object') return new Uint8Array(Object.values(b))
    return new Uint8Array(0)
  }
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8')
    const obj = JSON.parse(raw)
    const now = Date.now()
    for (const [t, s] of Object.entries(obj)) {
      if (now - (s.lastSeen || s.created) > SESSION_TTL) continue
      s.files = (s.files || []).map((f) => ({ ...f, bytes: bytesOf(f.bytes) }))
      // pg.legs[].files 按 id 挂回顶层同一对象（恢复上传时的引用身份，PATCH/识别结果两侧一致）
      const byId = new Map(s.files.map((f) => [f.id, f]))
      for (const leg of (s.pg && s.pg.legs) || []) {
        leg.files = (leg.files || []).map((f) => byId.get(f.id) || { ...f, bytes: bytesOf(f.bytes) })
      }
      s.lastSeen = s.lastSeen || s.created || Date.now()
      sessions.set(t, s)
    }
    if (sessions.size) console.log(`[deploy] 已恢复 ${sessions.size} 个 AI 会话（agent-sessions.json）`)
  } catch {
    /* 首次启动无文件 */
  }
}
loadSessions()
setInterval(() => {
  if (sessionsDirty) flushSessions().catch((e) => console.error('[sessions] 落盘失败:', String(e)))
}, 30000).unref()
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      fs.writeFileSync(SESSIONS_FILE, serializeSessions())
    } catch {}
    process.exit(0)
  })
}
process.on('exit', () => {
  if (sessionsDirty) {
    try {
      fs.writeFileSync(SESSIONS_FILE, serializeSessions())
    } catch {}
  }
})

function newSession({ teamName, members = [], contest = '', leader = '', homeCity = '南京', meta = {} }) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  const session = {
    token,
    created: Date.now(),
    lastSeen: Date.now(),
    st: {
      meta: { contest, dateContest: '', dateReturn: '', leader, homeCity, ...meta },
      teamName: String(teamName || ''),
      members: (members || []).map((m) => ({ name: String(m.name || ''), card: String(m.card || '') })),
      approval: { place: '', unit: '' },
    },
    pg: { legs: [] },
    files: [], // 平铺索引：{ id, legIndex, ...legFile }
  }
  sessions.set(token, session)
  markSessionsDirty()
  return session
}
setInterval(() => {
  const now = Date.now()
  for (const [t, s] of sessions) if (now - s.lastSeen > SESSION_TTL) sessions.delete(t)
}, 10 * 60 * 1000).unref()

/** 微信等下载链路会在文件头前置垃圾字节（反馈 5）：定位真实魔数（%PDF / PK）并剥掉前缀 */
function stripJunkPrefix(bytes, filename) {
  const head = bytes.slice(0, 256)
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return { bytes, stripped: false } // 已是 %PDF
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return { bytes, stripped: false } // 已是 PK (zip/OFD)
  const pdfIdx = head.indexOf(Buffer.from('%PDF'))
  if (pdfIdx > 0) return { bytes: bytes.slice(pdfIdx), stripped: true }
  const pk = head.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  if (pk > 0) return { bytes: bytes.slice(pk), stripped: true }
  return { bytes, stripped: false }
}

function ensureLeg(session, groupId, type) {
  let leg = session.pg.legs.find((l) => l.group === groupId && l.type === type)
  if (!leg) {
    leg = { group: groupId, type, label: '', files: [], customSlots: [] }
    session.pg.legs.push(leg)
  }
  return leg
}

const destCityOfSt = (st) => {
  const place = String(st.approval?.place || '').trim()
  if (!place) return ''
  const last = place.split(/[\s,，、/]+/).filter(Boolean).pop() || ''
  return last.replace(/(市|地区|自治州|盟|旗)$/, '') || last
}

/**
 * 图片扫描增强（扫描全能王式：四角裁剪矫正 + 自适应黑白 / 灰度），与浏览器端同一纯像素核心（scan-core.js）。
 * 黑白输出转 PNG（二值图存 JPEG 会有振铃伪影）；解码失败或非 PNG/JPEG 时原样跳过。
 * 返回 { applied, quadFound?, width?, height?, bytes?, mime?, ms?, reason? }
 */
function enhanceImageServer(bytes, mode = 'bw') {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (!isPng && !isJpg) return { applied: false, reason: '非 PNG/JPEG，跳过' }
  let rgba
  try {
    if (isPng) {
      const png = PNG.sync.read(Buffer.from(bytes))
      rgba = { data: png.data, width: png.width, height: png.height }
    } else {
      const j = jpegCodec.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true })
      rgba = { data: j.data, width: j.width, height: j.height }
    }
  } catch (e) {
    return { applied: false, reason: '图片解码失败（' + (e.message || e) + '），按原图处理' }
  }
  const t0 = Date.now()
  const out = enhanceRgba(rgba.data, rgba.width, rgba.height, { mode })
  const buf = Buffer.from(out.data.buffer, out.data.byteOffset, out.data.length)
  let outBytes
  let mime
  if (mode === 'bw') {
    const png = new PNG({ width: out.width, height: out.height })
    png.data = buf
    outBytes = PNG.sync.write(png)
    mime = 'image/png'
  } else {
    outBytes = jpegCodec.encode({ data: buf, width: out.width, height: out.height }, 90).data
    mime = 'image/jpeg'
  }
  return { applied: true, quadFound: out.quadFound, width: out.width, height: out.height, bytes: new Uint8Array(outBytes), mime, ms: Date.now() - t0 }
}

/** 图片材料：调用本机 Ollama 识别（金额/归属/抬头/舱位/起讫地/开票方/收款方），异步写入 */
function recognizeAsync(session, rec) {
  const leg = session.pg.legs[rec.legIndex]
  const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(rec.name)
  rec.meta = { status: isImage ? '服务器识别中…' : '文本型文件：请由 AI 自行读取提交金额/归属', progress: 0 }
  if (!isImage) {
    rec.recog = { status: 'skipped', via: 'ai' }
    return
  }
  rec.recog = { status: 'pending', via: 'ollama' }
  ;(async () => {
    const b64 = Buffer.from(rec.bytes).toString('base64')
    const mime = rec.mime || (/\.png$/i.test(rec.name) ? 'image/png' : 'image/jpeg')
    const prompt =
      '识别这张报销材料图片，只输出一个 JSON 对象：{"金额":数字,"同学":["姓名"],"抬头":"东南大学或空","经济舱":true或false,"开票方":"发票开具单位全名","收款方":"支付记录收款方全名","起始地":"出发城市","到达地":"到达城市"}。无法判断的字段用空值。'
    // 失败自动重试一次（反馈 3：偶发 fetch failed / Ollama 抖动）
    let r = null
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OLLAMA_VISION_MODEL || 'glm-ocr:latest',
            stream: false,
            options: { num_ctx: NUM_CTX },
            messages: [{ role: 'user', images: [b64], content: prompt }],
          }),
        })
        if (!resp.ok) throw new Error(`Ollama ${resp.status}`)
        r = resp
        break
      } catch (e) {
        lastErr = e
        if (attempt < 2) await new Promise((res) => setTimeout(res, 3000))
      }
    }
    if (!r) throw lastErr || new Error('Ollama 请求失败')
    const j = await r.json()
    const content = j?.message?.content || ''
    const slotName = Core.slotNameOf(leg, rec.slot)
    rec.meta = {
      status: '识别完成',
      progress: 100,
      amounts: Core.detectAmounts(content),
      members: Core.detectMembers(content, session.st.members),
      header: Core.invoiceHeaderCheck(rec.slot, slotName, rec.name, content),
      cabin: Core.cabinCheck(rec.slot, content),
    }
    if (!rec.amount && rec.meta.amounts.length) rec.amount = rec.meta.amounts[0].replace('¥', '')
    if (!rec.members && rec.meta.members.length) rec.members = rec.meta.members.map((m) => m.i)
    const rs = Core.routeScopeCheck(content, session.st.meta.homeCity, destCityOfSt(session.st))
    if (rs && Core.SCOPE_TRANSPORT_SLOTS.includes(rec.slot) && (rec.scope || []).length !== 1) {
      rec.scope = rs.scope === 'both' ? ['outbound', 'return'] : [rs.scope]
      rec.meta.scopeAuto = rs.label
    }
    if (Core.INVOICE_HEADER_SLOTS.includes(rec.slot)) {
      const issuer = Core.extractParty(content, ['销售方', '开票方', '开票单位', '卖方', '开票人'])
      if (issuer) rec.meta.issuer = issuer
    }
    if (Core.PAY_PARTY_SLOTS.includes(rec.slot)) {
      const payee = Core.extractParty(content, ['收款方', '收款单位', '收款人', '商户', '对方'])
      if (payee) rec.meta.payee = payee
    }
    rec.recog = { status: 'done', via: 'ollama' }
  })().catch((e) => {
    rec.recog = { status: 'failed', via: 'ollama', error: String((e && e.message) || e) }
    rec.meta = { status: '识别失败，可重新上传该文件，或手动填写金额 / 归属（也可由 AI 读取图片内容后 PATCH 提交）' }
  })
}

/**
 * 服务器版汇总 PDF：按清单顺序把材料合成一个 PDF。
 * @param invoicesOnly true = 仅发票/凭证类；false = 全部材料
 * @param withLabels true = 每份材料首页加文件名标注（核对对照版）；false = 纯打印版
 * 图片（jpg/png）按 A4 排版；PDF 原件无损拷页；OFD 按坐标矢量渲染（嵌入仿宋字体，文字可选中、打印清晰）。
 * pdf-lib 可用时才生成（返回 null 表示环境缺依赖或没有可合成的材料）。
 */
/** 生成某队 ZIP 字节（两份汇总 PDF + 材料包）；/sessions/:token/zip 与 /station/refresh 共用 */
async function generateTeamZip(session) {
  const extra = []
  const root = sanitizeName(`${session.st.meta?.contest || 'XCPC'}-${session.st.teamName}-报销材料`)
  const invoices = await buildSummaryPdfServer(session, { invoicesOnly: true })
  if (invoices) extra.push({ path: `${root}/发票汇总-扫描打印版.pdf`, data: invoices.bytes })
  const merged = await buildSummaryPdfServer(session, {})
  if (merged) extra.push({ path: `${root}/材料汇总-全部材料扫描打印版.pdf`, data: merged.bytes })
  const zip = await Core.buildTeamZipCore(session.st, session.pg, extra)
  return Buffer.from(await zip.arrayBuffer())
}

async function buildSummaryPdfServer(session, { invoicesOnly = false, withLabels = false } = {}) {
  let fontkitLib
  try {
    fontkitLib = (await import('@pdf-lib/fontkit')).default
  } catch (e) {
    console.error('[summary] fontkit 导入失败:', String((e && e.message) || e))
    return null
  }
  let fontBytes = null
  try {
    fontBytes = fs.readFileSync(path.join(__dirname, 'assets', 'FangSong.ttf'))
  } catch {}
  const A4 = { w: 595.28, h: 841.89 }
  const MM2PT = 72 / 25.4
  const INV_SLOTS = new Set(['f_invoice', 'h_invoice', 'l_invoice', 'fee_invoice', 't_voucher'])
  const title = invoicesOnly
    ? `${session.st.meta?.contest || 'XCPC'} 报销发票汇总（${session.st.teamName}）`
    : `${session.st.meta?.contest || 'XCPC'} 全部材料汇总（${session.st.teamName}）`
  const out = await PDFDocument.create()
  out.setTitle(title)
  if (fontBytes) out.registerFontkit(fontkitLib)
  let cjkFont = null
  if (fontBytes) {
    try {
      cjkFont = await out.embedFont(fontBytes, { subset: true })
    } catch (e) {
      console.error('[summary] 中文字体嵌入失败，OFD 文字将省略:', String((e && e.message) || e).slice(0, 120))
    }
  }
  const parseRgb = (str) => {
    const m = String(str || '').match(/(\d+)\D+(\d+)\D+(\d+)/)
    return m ? rgb(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255) : rgb(0, 0, 0)
  }
  let count = 0
  const skipped = []
  const drawLabel = (page, text, pageH) => {
    if (!cjkFont) return
    page.drawText(text.slice(0, 80), {
      x: 16,
      y: pageH - 13,
      size: 8.5,
      font: cjkFont,
      color: rgb(0.45, 0.45, 0.45),
    })
  }
  const LABEL_H = 20 // 带标注时每份材料顶部预留的标签高度（pt）
  for (const g of Core.GROUPS) {
    for (const leg of session.pg.legs.filter((l) => l.group === g.id && l.files.length)) {
      for (const f of leg.files) {
        if (invoicesOnly && !INV_SLOTS.has(f.slot)) continue
        const name = f.file?.name || f.name
        const label = `［${Core.slotNameOf(leg, f.slot)}］${name}`
        try {
          if (/\.ofd$/i.test(name)) {
            // OFD：按坐标矢量渲染成 PDF 页（文字嵌入仿宋可选中，框线矢量、印章图原样）
            const ofd = await renderOfd(new Blob([f.bytes]))
            for (const [pi, p] of ofd.pages.entries()) {
              const labelH = withLabels && pi === 0 ? LABEL_H : 0
              const pageH = ofd.heightMm * MM2PT + labelH
              const page = out.addPage([ofd.widthMm * MM2PT, pageH])
              if (withLabels && pi === 0) drawLabel(page, label, pageH)
              for (const op of p.ops) {
                if (op.type === 'image') {
                  // OFD 里 MultiMedia 的 Format/扩展名常不可靠：按魔数嗅探格式，解不了的图跳过（缺图好过整页失败）
                  const b = op.bytes
                  const isPng = b[0] === 0x89 && b[1] === 0x50
                  const isJpg = b[0] === 0xff && b[1] === 0xd8
                  if (!isPng && !isJpg) {
                    skipped.push(`${name} 内嵌非 PNG/JPEG 图（跳过该图）`)
                    continue
                  }
                  try {
                    const img = isPng ? await out.embedPng(b) : await out.embedJpg(b)
                    page.drawImage(img, {
                      x: op.x * MM2PT,
                      y: pageH - labelH - (op.y + op.h) * MM2PT,
                      width: op.w * MM2PT,
                      height: op.h * MM2PT,
                    })
                  } catch (e) {
                    skipped.push(`${name} 内嵌图嵌入失败（跳过该图: ${String(e.message || e).slice(0, 60)}）`)
                  }
                } else if (op.type === 'path') {
                  for (const seg of op.cmds) {
                    const pts = []
                    for (let i = 0; i + 1 < seg.list.length; i += 2) {
                      pts.push({
                        x: (op.bx + seg.list[i]) * MM2PT,
                        y: pageH - labelH - (op.by + seg.list[i + 1]) * MM2PT,
                      })
                    }
                    for (let i = 0; i + 1 < pts.length; i++) {
                      page.drawLine({
                        start: pts[i],
                        end: pts[i + 1],
                        thickness: Math.max(0.4, op.lineWidth * MM2PT),
                        color: parseRgb(op.stroke),
                      })
                    }
                  }
                } else if (op.type === 'text' && cjkFont) {
                  const baseY = pageH - labelH - op.y * MM2PT
                  let cx = op.x * MM2PT
                  const chars = [...op.text]
                  for (let ci = 0; ci < chars.length; ci++) {
                    page.drawText(chars[ci], {
                      x: cx,
                      y: baseY,
                      size: Math.max(1, op.size * MM2PT),
                      font: cjkFont,
                      color: parseRgb(op.color),
                    })
                    cx +=
                      (op.deltaX && op.deltaX[ci] != null ? op.deltaX[ci] : op.size) * MM2PT
                  }
                }
              }
            }
            count++
            continue
          }
          if (/\.pdf$/i.test(name)) {
            const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true })
            const pages = await out.copyPages(src, src.getPageIndices())
            pages.forEach((p, pi) => {
              if (withLabels && pi === 0) drawLabel(p, `［${Core.slotNameOf(leg, f.slot)}］${name}`, p.getHeight())
            })
            pages.forEach((p) => out.addPage(p))
          } else if (/\.(jpe?g|png)$/i.test(name)) {
            const isPng = f.bytes[0] === 0x89 && f.bytes[1] === 0x50
            const img = isPng ? await out.embedPng(f.bytes) : await out.embedJpg(f.bytes)
            const labelH = withLabels ? LABEL_H : 0
            const page = out.addPage([A4.w, A4.h])
            const scale = Math.min((A4.w - 40) / img.width, (A4.h - 24 - labelH - 40) / img.height, 1)
            page.drawImage(img, {
              x: (A4.w - img.width * scale) / 2,
              y: (A4.h - 24 - labelH - img.height * scale) / 2,
              width: img.width * scale,
              height: img.height * scale,
            })
            if (withLabels) drawLabel(page, `［${Core.slotNameOf(leg, f.slot)}］${name}`, page.getHeight())
          } else {
            skipped.push(`${name}（类型不支持）`)
            continue
          }
          count++
        } catch (e) {
          skipped.push(`${name}（${String((e && e.message) || e).slice(0, 60)}）`)
        }
      }
    }
  }
  console.error(`[summary] ${invoicesOnly ? '发票汇总' : '全部材料'} 完成 ${count} 个，跳过: ${JSON.stringify(skipped)}`)
  if (!count) return null
  return { bytes: await out.save(), count, skipped }
}

function agentSummary(session) {
  const { st, pg } = session
  const miss = Core.missingRequiredCore(st, pg)
  const cov = Core.coverageGapsCore(st, pg)
  const amounts = Core.amountCheckCore(st, pg)
  const hdr = Core.invoiceHeaderIssuesCore(pg)
  const cab = Core.cabinIssuesCore(pg)
  const pc = Core.payCheckIssuesCore(pg)
  const next = []
  if (!st.teamName) next.push('用 PATCH /sessions/:token 设置 teamName（打包必需）')
  if (!st.members.length) next.push('用 PATCH /sessions/:token 提交参赛同学名单（归属核对必需）')
  if (miss.length) next.push(`缺必附材料：${miss.map((m) => `${Core.TYPE_META[m.leg.type].label}·${m.slot.name}`).join('；')}（POST files 上传）`)
  if (cov.length) next.push(`归属不完整：${cov.map((c) => `${c.name}缺${c.miss.join('/')}`).join('；')}（PATCH file 的 members/scope）`)
  for (const a of amounts) {
    if (a.match === false) next.push(`【${a.name}】支付 ¥${a.paySum} ≠ 发票 ¥${a.invSum}：核对金额，或填写说明`)
    if (a.match === null) next.push(`【${a.name}】金额待填写（PATCH file 的 amount）`)
  }
  if (hdr.issues.length) next.push(`${hdr.issues.length} 张发票未识别到「东南大学」抬头，请人工核对`)
  if (cab.issues.length) next.push(`${cab.issues.length} 张机票材料未见「经济舱」，请人工核对`)
  if (pc.length) next.push(`收付款不一致：${pc.map((p) => p.name).join('；')}（PATCH file 的 issuer/payee 后勾选一致，或填说明）`)
  if (!next.length) next.push('全部检查通过，可以 POST /sessions/:token/zip 打包下载')
  const unsortedCount = session.files.filter((f) => f.slot === 'unsorted').length
  if (unsortedCount) next.unshift(`有 ${unsortedCount} 个「未分类」文件待归位：读取内容后 PATCH {group, type, slot}（归位前不参与核对，也不会打进 ZIP）`)
  const filesView = session.files.map((f) => ({
    id: f.id,
    name: f.name,
    slot: f.slot,
    extraSlots: f.extraSlots || [],
    leg: `${Core.TYPE_META[session.pg.legs[f.legIndex].type].label}`,
    amount: f.amount || null,
    members: f.members == null ? '全员' : (f.members || []).map((i) => st.members[i]?.name).filter(Boolean),
    scope: f.scope,
    recog: f.recog ? f.recog.status : null,
    recogError: f.recog?.error || null,
    issuer: f.meta?.issuer || null,
    payee: f.meta?.payee || null,
    scopeAuto: f.meta?.scopeAuto || null,
    header: f.meta?.header?.ok ?? null,
    cabin: f.meta?.cabin?.ok ?? null,
  }))
  return {
    teamName: st.teamName,
    members: st.members,
    session: {
      createdAt: new Date(session.created).toISOString(),
      expiresAt: new Date(session.lastSeen + SESSION_TTL).toISOString(),
      expiresInMinutes: Math.max(0, Math.round((session.lastSeen + SESSION_TTL - Date.now()) / 60000)),
      note: '闲置一个月过期；每次请求自动续期',
    },
    legs: pg.legs.map((l, i) => ({
      index: i,
      group: l.group,
      type: l.type,
      label: l.label,
      files: filesView.filter((f) => session.files.find((x) => x.id === f.id)?.legIndex === i),
    })),
    files: filesView,
    checks: {
      missingRequired: miss.map((m) => ({ type: m.leg.type, label: Core.TYPE_META[m.leg.type].label, slot: m.slot.name })),
      coverageGaps: cov,
      amounts,
      headerIssues: hdr,
      cabinIssues: cab,
      payCheckIssues: pc,
    },
    // 财务系统网上报销填写对照（两个屏的字段 → 工具值，归报销负责人填写）
    sysFill: {
      note: '财务系统填写对照单（https://caiwuchujf.seu.edu.cn/WFManager/home2.jsp 网上报销），归属报销负责人；元数据缺项时用 PATCH /sessions/:token 的 meta 补（projectNo/projectLeader/leaderCard/phone/email/payMethod）',
      text: Core.sysFillText(st, pg),
    },
    next,
  }
}

const agentGuide = () => ({
  project: 'XCPC 报销材料整理工具（东南大学）—— AI 可驱动整套报销材料整理流程',
  how_to_drive: [
    '1. POST /api/agent/sessions 创建会话（携带队名与同学名单），得到 token。会话闲置一个月过期，每次请求自动续期（status.session.expiresAt 可查剩余时间）',
    '2. 对每个材料文件：POST /api/agent/sessions/:token/files（请求体为文件原始字节，头 X-Filename 放文件名）。服务器按文件名关键词自动分类（完整映射见 material_rules.keyword_map；酒店「结账单/结帐单」→ 住宿流水、东航小程序「行程提示单」→ 机票订单）；判不出类别不会报错，文件落入「未分类」段，识别照常进行。图片自动扫描增强（四角裁剪矫正；X-Scan: bw 黑白 / gray 灰度；**默认 off 保留彩色原图——报销场景保持默认即可，黑白会把红章变灰，仅用户明确要黑白扫描件时才传 bw**）后自动 OCR',
    '3. GET /api/agent/sessions/:token/status 查看全部状态、检查结果与 next 建议',
    '4. 对识别不到的字段（金额/归属/开票方/收款方等），由你（AI）自行读取文件内容，PATCH /api/agent/sessions/:token/files/:fileId 提交',
    '5. next 全部清零后 POST /api/agent/sessions/:token/zip 下载打包好的队伍 ZIP。ZIP 必须 EOCD 校验+解包抽验（status 全绿≠字节配对正确，历史发生过图片字节错位）；赛站总包从「上传的队 ZIP」打包而非从会话现打——任何会话变更（补材料/PATCH）后用 POST /api/agent/station/refresh 一键从所有会话现打队包并替换赛站队列，再 POST /station/zip 重打总包（或手工：重打队包→DELETE 旧 /station/zips/:id→重传→重打）',
    '5b. 财务报销填写：status.sysFill.text 是「财务系统网上报销填写对照单」（https://caiwujf.seu.edu.cn/WFManager/home2.jsp 两个屏的逐字段对照：基本信息 + 差旅费明细，按队员汇总车船费/市内交通/住宿费），归属报销负责人；元数据缺项（projectNo 项目号/projectLeader 负责人/leaderCard 工号/phone/email/payMethod 支付方式）请向用户收集后 PATCH /sessions/:token 的 meta 补上，ZIP 内也会生成对照单 txt',
    '5c. 财务金额口径（ICPC 沈阳站与财务核对后定稿）：支付立减按实付报销（报销额=实付，如东航机票支付立减 0.50/张）；高速费等票面外附加不报销（市内交通按发票票面，差额队员自担）；参赛注册费填财务系统「其他费用」栏；出租车老式纸质票二维码扫不出属正常（非增值税发票，手填票面四要素或补开电子票，二选一防重复）；差旅费明细出差人一组上限 6 人（+加组），职称选「其他人员」、伙食/交通补贴选「否」、参赛费填「其他费用」栏。服务器/ZIP 金额保持发票口径，财务填表差额口头说明。**经济舱佐证**：数电票票面无舱位栏、支付截图不含舱位——坐飞机的每人必须补一张含「经济舱」字样的订单详情截图（东航小程序→我的订单→订单详情），本流程的 status/next 不检查此项，靠 AI 主动收集核对',
    '6.（建议）任务完成后向用户提议：本网站由学生团队维护，欢迎意见反馈；征得用户同意后，把本次使用中的问题与改进建议整理成文字，POST /api/agent/feedback 提交（无需 token）',
    '注意1：文本型 PDF/OFD 服务器不做内容解析，金额/归属等由你读取后 PATCH 提交',
    '注意2：上传图片默认保留彩色原图（黑白会把红章变灰）——需要黑白扫描件时显式传 X-Scan: bw',
    '注意3：读材料文件前先本地体检（PDF 用 pdftoppm 渲染副本、图片验证解码通道）：个别正常文件 GLM 解析会报 1210 文件解析失败，一旦进入会话历史该会话永久报废；上游工具链见仓库根 AGENTS.md',
  ],
  leader_flow: {
    desc: '报销负责人流程：收各队 ZIP + 参赛费材料，自动汇总各队名单与待办，打包赛站总包（端点前缀 /api/agent/station，无需会话 token）',
    steps: [
      'PATCH /api/agent/station {name:"赛站名"} 设置赛站名称',
      'POST /api/agent/station/zips 上传各队 ZIP（X-Filename 头；自动提取每队名单与核对报告待办）',
      'POST /api/agent/station/entryfees 上传参赛费材料（X-Slot: invite / fee_invoice / fee_pay）',
      'GET /api/agent/station/status 查看队伍 / 材料 / 名单汇总与下一步建议',
      'POST /api/agent/station/zip 打包赛站总包（含 00-参赛费、问题清单、汇总说明；差旅审批单用网页端生成后单独提交）',
      'POST /api/agent/station/refresh 从已登记的队会话现打 ZIP 替换赛站队包——队会话变更（补材料/PATCH/换图）后的标准动作，之后重新 POST /station/zip 重打总包',
      '重要：/station/zip 从「已上传的队 ZIP」打包而非从会话现打——任何队会话变更（补材料/PATCH/换彩色图）后用 POST /station/refresh 一键现打全部队包并替换赛站队列，再 POST /station/zip 重打总包（手工方式：重打队包→DELETE 旧 /station/zips/:id→重传）；否则总包仍是旧内容（沈阳站真实翻车过）；交付前解包抽验总包条目；大响应下载走局域网 192.168.3.5:8080 更稳（公网代理对 50MB+ 易超时）',
    ],
  },
  material_rules: {
    groups: Core.GROUPS,
    slots: Core.TYPE_META,
    keyword_map: `文件名自动分类关键词：${Core.CLASSIFY_HINTS}`,
    必附: '每段必附槽位见 slots 中 required:true；常见漏项：酒店流水、机票订单、行程单、参赛费支付记录',
    一文件多槽: '酒店「盖章结账明细单/流水」既是流水又常含收款/POS 信息：上传一份即可，PATCH slot:["h_flow","h_pay"]（或单独 PATCH extraSlots:["h_pay"]）。缺料检查视为两项齐全，其金额计入支付合计 paySum，ZIP 内只出现一份',
    未分类: '文件名判不出类别时上传仍成功（slot=unsorted 的「未分类」段，不参与核对与打包）。读出内容后 PATCH {group, type, slot} 归位：group∈transport（配 flight/train/local）、stay（hotel）、entryfee（entryfee）；只传 type 也可，group 自动反推',
    补充材料: '规则未要求但想随包提交的材料（如 12306 支付记录、说明附件）：PATCH slot:"supplement"。不参与任何核对，ZIP 中归入该段「补充材料/」文件夹',
    金额: '支付金额必须与发票金额一致；购票勿勾选保险。核对口径：按分组累计，invSum 只统计槽位 f_invoice/h_invoice，paySum 只统计 f_pay/h_pay（市内交通与参赛费不参与该核对；一文件多槽按附加槽位计入对应合计）',
    抬头: '所有可改抬头的发票抬头必须为「东南大学」（严格匹配：购买方名称须一字不差，多字如「东南大学苏州校区」、缺字均不通过），税号 12100000466006770Q 须完全一致。检查覆盖槽位 f_invoice/h_invoice/l_invoice/fee_invoice/t_voucher（12306 新版铁路电子发票自带购买方抬头会参与检查）',
    舱位: '飞机仅限经济舱（材料需含「经济舱」字样）；高铁仅限二等座',
    收付款: '流程：对比发票开票方（issuer）与支付记录收款方（payee）。不一致时一次 PATCH 同时提交 {issuer, payee, consistent: true, note}（同次提交不会先出现告警）；若只提交 issuer/payee，status 立即出现 payCheckIssues，之后 PATCH consistent:true 或填写 note 可解除',
    范围: '往返交通材料需标注去程/返程。scope 只接受数组：["outbound"]=去程、["return"]=返程、["outbound","return"]=往返（没有字符串 "both"）',
    recog_状态机: 'files[].recog：pending=识别中；done=完成；failed=失败（原因见 recogError，可重新上传重试，或由你读取图片后 PATCH）；skipped=文本型 PDF/OFD，服务器不解析，由你读取后 PATCH 提交',
    zip_命名: 'ZIP 内段文件夹 = 「组序号-组名/段序号-类型-label」，label 来自 PATCH 的 label 字段（缺省只有类型名）。段文件夹按段组织，去/返程由文件名中的「去程/返程」标注区分——不要把多段行程混进一个段。文件名 = 「序号-槽位名-去返程-归属-金额.扩展名」',
    发票汇总: '打包 ZIP 自动附带「发票汇总-扫描打印版.pdf」：发票/凭证类图片与 PDF 按清单顺序合成（OFD 不参与，原件仍在包内）',
    材料汇总: '打包 ZIP 同时自动附带「材料汇总-全部材料扫描打印版.pdf」：全部材料（PDF 无损拷页、图片排 A4）按清单顺序合成，OFD 原样保留在包内',
  },
  endpoints: [
    { method: 'GET', path: '/api/agent', desc: '本指南' },
    { method: 'POST', path: '/api/agent/sessions', body: { teamName: '队名(必填)', members: [{ name: '姓名', card: '一卡通号' }], contest: '比赛名', leader: '负责人', homeCity: '出发城市(默认南京)', meta: '{projectNo,projectLeader,leaderCard,phone,email,payMethod,dateContest,dateReturn}（财务系统对照单元数据，也可事后 PATCH）' }, resp: { token: 'xxxx' } },
    { method: 'PATCH', path: '/api/agent/sessions/:token', body: { teamName: '…', members: [{ name: '…', card: '…' }], meta: { contest: '…', leader: '…', homeCity: '…', dateContest: 'YYYY-MM-DD', dateReturn: 'YYYY-MM-DD', projectNo: '项目号', projectLeader: '项目负责人', leaderCard: '申请人工号', phone: '电话', email: '电子邮件', payMethod: '支付方式' } }, desc: '更新会话基础信息（财务系统对照单需要的元数据见 meta 各字段，缺失项 status.sysFill.text 中标「未填写」）' },
    { method: 'POST', path: '/api/agent/sessions/:token/files', headers: { 'X-Filename': '文件名（URL 编码）', 'X-Scan': '图片扫描增强模式（默认 off 保留彩色原图；bw 黑白；gray 灰度）' }, body: '文件原始字节', resp: { fileId: 'fab12c34', slot: 'f_order', leg: 'transport/flight', scope: ['outbound', 'return'], recog: 'pending', scan: { applied: true, mode: 'bw', quadFound: true, width: 1600, height: 1000 } }, desc: '图片自动扫描增强（四角裁剪矫正+黑白/灰度）后 OCR，scan.quadFound=false 表示未检出证件边缘（整图增强）；判不出类别时返回 200 + warning，slot=unsorted（未分类），读内容后 PATCH 归位' },
    { method: 'PATCH', path: '/api/agent/sessions/:token/files/:fileId', body: { amount: '670.00', members: ['姓名'], scope: ['outbound'], slot: 'f_order 或 ["h_flow","h_pay"]（一文件多槽）', extraSlots: ['h_pay'], group: '移动目标分组（配 type）', type: 'flight/train/local/hotel/entryfee', label: '段备注', issuer: '开票方', payee: '收款方', consistent: true, note: '不一致说明' }, desc: 'slot/extraSlots 非法时返回该段全部合法槽位（含 supplement）；members 用姓名数组（服务器换算下标）；issuer/payee/consistent/note 写入该文件所在段的收付款核对' },
    { method: 'DELETE', path: '/api/agent/sessions/:token/files/:fileId', desc: '删除文件' },
    { method: 'GET', path: '/api/agent/sessions/:token/status', resp: '全量状态 + session（含 expiresAt/expiresInMinutes）+ checks + next（下一步建议）+ sysFill（财务系统填写对照单，见 how_to_drive 5b）；files[].recogError 为识别失败原因' },
    { method: 'POST', path: '/api/agent/sessions/:token/zip', resp: 'ZIP 二进制（Content-Disposition 附件）' },
    { method: 'POST', path: '/api/agent/feedback', body: { content: '问题与建议（必填，≤10000 字）', teamName: '队名（可省略；带 X-Agent-Token 自动归属）', contact: '联系方式（可选）', category: 'bug/建议/其他（可选）' }, desc: '网站意见反馈，无需会话。任务完成后建议向用户征求反馈，征得同意后代为整理提交' },
  ],
})

// ---- 负责人赛站汇总状态（单一负责人；随 agent-sessions.json 一起持久化）----
const station = {
  name: '', // 赛站名称
  zips: [], // { id, team, bytes, count, todos, roster }
  entryFees: [], // { id, slot, name, bytes }
}
const STATION_FILE = path.join(__dirname, 'agent-station.json')
function stationSerial() {
  return JSON.stringify({
    name: station.name,
    zips: station.zips.map((z) => ({ id: z.id, team: z.team, name: z.name, bytes: Buffer.from(z.bytes).toString('base64') })),
    entryFees: station.entryFees.map((f) => ({ id: f.id, slot: f.slot, name: f.name, bytes: Buffer.from(f.bytes).toString('base64') })),
  })
}
function loadStation() {
  try {
    const o = JSON.parse(fs.readFileSync(STATION_FILE, 'utf8'))
    station.name = o.name || ''
    station.zips = (o.zips || []).map((z) => ({ ...z, bytes: new Uint8Array(Buffer.from(z.bytes, 'base64')) }))
    station.entryFees = (o.entryFees || []).map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.bytes, 'base64')) }))
    if (station.zips.length || station.entryFees.length) console.log('[deploy] 已恢复赛站汇总状态')
  } catch {
    /* 首次启动无文件 */
  }
}
loadStation()
const flushStation = () => {
  const tmp = STATION_FILE + '.tmp'
  return fs.promises.writeFile(tmp, stationSerial()).then(() => fs.promises.rename(tmp, STATION_FILE)).catch(() => {})
}
setInterval(() => {
  flushStation().catch(() => {})
}, 5000).unref()
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      fs.writeFileSync(STATION_FILE, stationSerial())
    } catch {}
  })
}

const EF_SLOTS = ['invite', 'fee_invoice', 'fee_pay']
let zSeq = 1
let efSeq = 1

/** 负责人赛站汇总路由（parts: ['station', ...]） */
async function handleStation(req, res, parts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // PATCH /api/agent/station —— 设置赛站名称
  if (req.method === 'PATCH' && parts.length === 0) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (body.name != null) station.name = String(body.name)
    sendJSON(res, 200, { ok: true, name: station.name })
    return
  }
  // POST /api/agent/station/zips —— 上传一个队伍 ZIP（X-Filename 头；X-Team 可选覆盖队名）
  if (req.method === 'POST' && parts[0] === 'zips' && parts.length === 1) {
    const bytes = new Uint8Array(await readBody(req, 64))
    let filename = '队伍材料.zip'
    try {
      filename = decodeURIComponent(String(req.headers['x-filename'] || filename))
    } catch {}
    // 剥离微信下载链路的垃圾前缀（%PDF / PK 魔数定位）
    const head = bytes.slice(0, 256)
    let startOff = 0
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const seq = Buffer.from([0x50, 0x4b, 0x03, 0x04])
      for (let i = 0; i < head.length - 4; i++) {
        if (head[i] === 0x50 && head[i + 1] === 0x4b && head[i + 2] === 0x03 && head[i + 3] === 0x04) {
          startOff = i
          break
        }
      }
    }
    const clean = startOff > 0 ? bytes.slice(startOff) : bytes
    const item = {
      id: 'z' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      team: filename.replace(/\.zip$/i, ''),
      name: filename,
      bytes: clean,
      count: null,
      todos: [],
      roster: [],
      error: '',
    }
    try {
      const entriesList = await readZipEntries(new Blob([clean]))
      item.count = entriesList.length
      const roots = new Set(entriesList.map((e) => e.name.split('/')[0]))
      if (roots.size === 1 && !item.team) item.team = [...roots][0]
      const reportEntry = entriesList.find((e) => e.name.includes('核对报告.txt'))
      if (reportEntry) item.todos = Core.parseTodosSection(new TextDecoder('utf-8').decode(reportEntry.data))
      const csvEntry = entriesList.find((e) => e.name.includes('参赛同学清单.csv'))
      if (csvEntry) item.roster = parseMembersCSV(new TextDecoder('utf-8').decode(csvEntry.data))
    } catch (e) {
      item.error = String((e && e.message) || e)
    }
    station.zips.push(item)
    flushStation().catch(() => {})
    sendJSON(res, 200, {
      id: item.id,
      team: item.team,
      count: item.count,
      todos: item.todos,
      roster: item.roster,
      rosterCount: item.roster.length,
      error: item.error,
      next: item.error ? 'ZIP 无法读取，请确认导出的队伍 ZIP 完整' : '可继续上传其余队伍 ZIP / 参赛费材料，全部就绪后 POST /station/zip 打包',
    })
    return
  }
  // DELETE /api/agent/station/zips/:id
  if (req.method === 'DELETE' && parts[0] === 'zips' && parts.length === 2) {
    const i = station.zips.findIndex((z) => z.id === parts[1])
    if (i === -1) {
      sendJSON(res, 404, { error: { message: '队伍 ZIP 不存在' } })
      return
    }
    station.zips.splice(i, 1)
    flushStation().catch(() => {})
    sendJSON(res, 200, { ok: true })
    return
  }
  // POST /api/agent/station/entryfees —— 上传参赛费材料（X-Slot: invite / fee_invoice / fee_pay）
  if (req.method === 'POST' && parts[0] === 'entryfees' && parts.length === 1) {
    const slot = String(req.headers['x-slot'] || 'fee_invoice')
    if (!EF_SLOTS.includes(slot)) {
      sendJSON(res, 400, { error: { message: 'X-Slot 需为 invite / fee_invoice / fee_pay 之一' } })
      return
    }
    const bytes = new Uint8Array(await readBody(req, 64))
    let filename = '参赛费材料'
    try {
      filename = decodeURIComponent(String(req.headers['x-filename'] || filename))
    } catch {}
    const rec = { id: 'e' + crypto.randomUUID().replace(/-/g, '').slice(0, 8), slot, name: filename, bytes }
    station.entryFees.push(rec)
    flushStation().catch(() => {})
    sendJSON(res, 200, { id: rec.id, slot: rec.slot, name: rec.name })
    return
  }
  // DELETE /api/agent/station/entryfees/:id
  if (req.method === 'DELETE' && parts[0] === 'entryfees' && parts.length === 2) {
    const i = station.entryFees.findIndex((f) => f.id === parts[1])
    if (i === -1) {
      sendJSON(res, 404, { error: { message: '参赛费材料不存在' } })
      return
    }
    station.entryFees.splice(i, 1)
    flushStation().catch(() => {})
    sendJSON(res, 200, { ok: true })
    return
  }
  // POST /api/agent/station/refresh —— 从已登记的队会话现打 ZIP，替换赛站队包
  // （改会话后免手工「重打队包→DELETE→重传」链；队名单沿用上次提取，待办视为已清；
  //   只刷新已在赛站的队——新队/历史测试会话不会被误打包，新队走 station_upload_zip 显式上传）
  if (req.method === 'POST' && parts[0] === 'refresh' && parts.length === 1) {
    const refreshed = []
    const skipped = []
    const failed = []
    // 同队名可能有多个会话（历史比赛/测试残留）：只取最近活跃（lastSeen 最新）的那个
    const byTeam = new Map()
    for (const session of sessions.values()) {
      const team = (session.st.teamName || '').trim()
      if (!team) continue
      const prev = byTeam.get(team)
      if (!prev || (session.lastSeen || 0) > (prev.lastSeen || 0)) byTeam.set(team, session)
    }
    for (const [team, session] of byTeam) {
      const existing = station.zips.find((z) => z.team === team)
      if (!existing) {
        skipped.push(team)
        continue
      }
      try {
        const buf = await generateTeamZip(session)
        existing.bytes = new Uint8Array(buf)
        existing.name = `${team}.zip`
        refreshed.push(team)
      } catch (e) {
        failed.push(`${team}: ${(e && e.message) || e}`)
      }
    }
    flushStation().catch(() => {})
    sendJSON(res, 200, {
      refreshed,
      skipped,
      failed,
      note: '队名单沿用上次提取；如队内名单有变请重新 station_upload_zip。待办视为已清。',
      zips: station.zips.map((z) => ({ id: z.id, team: z.team, name: z.name })),
      next: '可直接 POST /api/agent/station/zip 重新打包赛站总包',
    })
    return
  }
  // GET /api/agent/station/status
  if (req.method === 'GET' && parts[0] === 'status' && parts.length === 1) {
    const rosterTotal = []
    const seenCards = new Set()
    for (const z of station.zips) {
      for (const m of z.roster || []) {
        const key = m.card || m.name
        if (key && !seenCards.has(key)) {
          seenCards.add(key)
          rosterTotal.push(m)
        }
      }
    }
    sendJSON(res, 200, {
      name: station.name,
      zips: station.zips.map((z) => ({ id: z.id, team: z.team, name: z.name, count: z.count, todos: z.todos, roster: z.roster, error: z.error })),
      entryFees: station.entryFees.map((f) => ({ id: f.id, slot: f.slot, name: f.name })),
      rosterFromZips: rosterTotal,
      missing: !station.name ? ['赛站名称（PATCH /station {name}）'] : [],
      next: !station.zips.length
        ? '上传各队 ZIP：POST /station/zips（X-Filename + 字节）'
        : !station.entryFees.length
          ? '上传参赛费材料：POST /station/entryfees（X-Slot + 字节）'
          : '全部就绪后 POST /station/zip 打包赛站总包',
    })
    return
  }
  // POST /api/agent/station/zip —— 打包赛站总包
  if (req.method === 'POST' && parts[0] === 'zip' && parts.length === 1) {
    try {
      if (!station.name.trim()) {
        sendJSON(res, 400, { error: { message: '请先用 PATCH /station 设置赛站名称' } })
        return
      }
      if (!station.zips.length) {
        sendJSON(res, 400, { error: { message: '请先上传各队 ZIP' } })
        return
      }
      const items = station.zips.map((z) => ({
        file: { name: z.name, arrayBuffer: async () => z.bytes.slice().buffer },
        team: z.team,
      }))
      const entryFeeFiles = station.entryFees.map((f) => ({
        file: { name: f.name, arrayBuffer: async () => f.bytes.slice().buffer },
        slot: f.slot,
      }))
      const zip = await Core.buildStationZipCore(station.name, items, entryFeeFiles, {})
      const buf = Buffer.from(await zip.arrayBuffer())
      send(res, 200, buf, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(station.name)}.zip"`,
      })
    } catch (e) {
      sendJSON(res, 400, { error: { message: (e && e.message) || String(e) } })
    }
    return
  }
  sendJSON(res, 404, { error: { message: '未知赛站端点，GET /api/agent 查看指南' } })
}

async function handleAgent(req, res, pathname) {
  // 指南（无需鉴权）
  if (req.method === 'GET' && pathname === '/api/agent') {
    sendJSON(res, 200, agentGuide())
    return
  }

  // 意见反馈（无需会话；带 X-Agent-Token 可自动归属队名）。JSONL 追加到 feedback/ 目录
  if (req.method === 'POST' && pathname === '/api/agent/feedback') {
    const body = JSON.parse((await readBody(req, 1)).toString('utf8') || '{}')
    const content = String(body.content || '').trim()
    if (!content) {
      sendJSON(res, 400, { error: { message: 'content 必填：把问题与建议整理成文字提交' } })
      return
    }
    if (content.length > 10000) {
      sendJSON(res, 400, { error: { message: 'content 过长（>10000 字），请精简后提交' } })
      return
    }
    const owner = sessions.get(String(req.headers['x-agent-token'] || ''))
    const line = {
      at: new Date().toISOString(),
      teamName: String(body.teamName || owner?.st.teamName || '').trim(),
      contact: String(body.contact || '').trim(),
      category: String(body.category || '建议').trim(),
      content,
    }
    try {
      const dir = path.join(__dirname, 'feedback')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, `feedback-${line.at.slice(0, 7)}.jsonl`), JSON.stringify(line) + '\n')
    } catch (e) {
      sendJSON(res, 500, { error: { message: '反馈写入失败：' + String((e && e.message) || e) } })
      return
    }
    sendJSON(res, 200, { ok: true, savedAt: line.at, hint: '反馈已记录，感谢！' })
    return
  }

  const parts = pathname.split('/').filter(Boolean) // ['api','agent',...]
  if (req.method === 'POST' && pathname === '/api/agent/sessions') {
    if (sessions.size >= MAX_SESSIONS) {
      sendJSON(res, 503, { error: { message: '会话数已达上限，请稍后再试' } })
      return
    }
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (!body.teamName || !String(body.teamName).trim()) {
      sendJSON(res, 400, { error: { message: 'teamName 必填' } })
      return
    }
    const session = newSession(body)
    markSessionsDirty()
    sendJSON(res, 200, {
      token: session.token,
      idleExpireHours: SESSION_TTL / 3600000,
      note: '会话闲置过期（小时），每次请求自动续期',
      next: '上传文件：POST /api/agent/sessions/' + session.token + '/files（X-Filename 头 + 文件字节）',
    })
    return
  }

  // ---- 负责人赛站汇总（parts[2]='station'）----
  if (parts[2] === 'station') {
    await handleStation(req, res, parts.slice(3))
    return
  }

  // 以下均需 token（/api/agent/sessions/:token/... → parts[2]='sessions'，token 在 parts[3]）
  const token = parts[3] || ''
  const session = sessions.get(token)
  if (!session) {
    sendJSON(res, 404, { error: { message: '会话不存在或已过期（若整理中途突然全部失效，通常是服务器重启过——请重新创建会话并重传材料；已填内容如已打包则不受影响）' } })
    return
  }
  session.lastSeen = Date.now() // 闲置过期：活跃会话自动续期
  const rest = parts.slice(4)

  if (req.method === 'PATCH' && rest.length === 0) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (body.teamName != null) session.st.teamName = String(body.teamName)
    if (Array.isArray(body.members)) session.st.members = body.members.map((m) => ({ name: String(m.name || ''), card: String(m.card || '') }))
    if (body.meta) Object.assign(session.st.meta, body.meta)
    sendJSON(res, 200, { ok: true, status_hint: 'GET status 查看检查结果' })
    return
  }

  if (req.method === 'POST' && rest[0] === 'files' && rest.length === 1) {
    const rawName = req.headers['x-filename'] || '未命名'
    let filename
    try {
      filename = decodeURIComponent(String(rawName))
    } catch {
      filename = String(rawName)
    }
    const raw = new Uint8Array(await readBody(req, 64))
    const fixed = stripJunkPrefix(raw, filename)
    let bytes = fixed.bytes
    // 照片自动扫描增强（默认 off 保留彩色原图——黑白会把红章变灰；bw 黑白 / gray 灰度需显式指定）；增强后再送 Ollama，识别更稳
    const scanModeRaw = String(req.headers['x-scan'] || 'off').toLowerCase()
    const scanMode = scanModeRaw === 'gray' ? 'gray' : scanModeRaw === 'off' ? 'off' : 'bw'
    let scanInfo = null
    let recMime = null
    if (scanMode !== 'off' && /\.(jpe?g|png)$/i.test(filename)) {
      const sc = enhanceImageServer(bytes, scanMode)
      if (sc.applied) {
        bytes = sc.bytes
        recMime = sc.mime
        // 黑白增强输出为 PNG 字节（灰度为 JPEG），扩展名同步修正，避免包内名实不符
        filename = filename.replace(/\.(jpe?g|png)$/i, scanMode === 'bw' ? '.png' : '.jpg')
        scanInfo = { applied: true, mode: scanMode, quadFound: sc.quadFound, width: sc.width, height: sc.height, ms: sc.ms }
      } else {
        scanInfo = { applied: false, reason: sc.reason }
      }
    }
    // 判不出类别不拒绝：落入「未分类」段（不参与核对/打包），AI 读取内容后 PATCH group/type/slot 归位
    const cls = Core.classifyMaterial(filename)
    const unclassified = !cls || !cls.groupId
    const groupId = unclassified ? 'unsorted' : cls.groupId
    const type = unclassified ? 'unsorted' : cls.type
    const leg = ensureLeg(session, groupId, type)
    const rec = {
      id: 'f' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      legIndex: session.pg.legs.indexOf(leg),
      name: filename,
      bytes,
      slot: unclassified ? 'unsorted' : cls.slotId,
      amount: '',
      members: null,
      scope: groupId === 'transport' ? cls?.scopeHint || ['outbound', 'return'] : cls?.scopeHint || [],
      meta: null,
      recog: null,
    }
    if (recMime) rec.mime = recMime
    leg.files.push(rec)
    session.files.push(rec)
    markSessionsDirty()
    recognizeAsync(session, rec)
    sendJSON(res, 200, {
      fileId: rec.id,
      slot: rec.slot,
      leg: { group: groupId, type },
      scope: rec.scope,
      recog: rec.recog,
      ...(scanInfo ? { scan: scanInfo } : {}),
      ...(unclassified
        ? { warning: `文件名未含可识别关键词，已存入「未分类」段。请读取文件内容后 PATCH 本文件 {group, type, slot} 归位。分类关键词：${Core.CLASSIFY_HINTS}` }
        : {}),
      hint:
        '图片已自动扫描增强并 OCR（重传可换 X-Scan: gray 灰度 / off 关闭）；文本型 PDF/OFD 请自行读取内容后 PATCH 提交 amount/members' +
        (fixed.stripped ? '；已自动剥离文件头的下载垃圾前缀' : ''),
    })
    return
  }

  if (rest[0] === 'files' && rest.length === 2) {
    const rec = session.files.find((f) => f.id === rest[1])
    if (!rec) {
      sendJSON(res, 404, { error: { message: '文件不存在' } })
      return
    }
    let leg = session.pg.legs[rec.legIndex]
    if (req.method === 'DELETE') {
      leg.files.splice(leg.files.indexOf(rec), 1)
      session.files.splice(session.files.indexOf(rec), 1)
      markSessionsDirty()
      sendJSON(res, 200, { ok: true })
      return
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      if (body.amount != null) rec.amount = String(body.amount)
      if (Array.isArray(body.members)) {
        // 支持姓名数组（AI 友好），换算为成员下标
        rec.members = body.members
          .map((n) => session.st.members.findIndex((m) => m.name === n || (m.name && n.includes(m.name))))
          .filter((i) => i >= 0)
      }
      if (Array.isArray(body.scope)) rec.scope = body.scope.filter((s) => ['outbound', 'return'].includes(s))

      // 跨段移动（「未分类」归位等）：group 可省略（由 type 唯一反推）
      if (body.group != null || body.type != null) {
        const type = String(body.type != null ? body.type : leg.type)
        const group = String(body.group != null ? body.group : { flight: 'transport', train: 'transport', local: 'transport', hotel: 'stay', entryfee: 'entryfee' }[type] || '')
        if (!['transport', 'stay', 'entryfee'].includes(group) || !{ transport: ['flight', 'train', 'local'], stay: ['hotel'], entryfee: ['entryfee'] }[group].includes(type)) {
          sendJSON(res, 400, { error: { message: '移动目标不合法。group∈transport(类型 flight/train/local)、stay(hotel)、entryfee(entryfee)，示例：{"group":"stay","type":"hotel","slot":"h_flow"}' } })
          return
        }
        if (group !== leg.group || type !== leg.type) {
          leg.files.splice(leg.files.indexOf(rec), 1)
          const target = ensureLeg(session, group, type)
          target.files.push(rec)
          rec.legIndex = session.pg.legs.indexOf(target)
          if (group === 'transport' && !(rec.scope || []).length) rec.scope = ['outbound', 'return']
          leg = target
        }
      }

      // slot：字符串或数组（数组 = 一文件多槽，首元素为主槽位）；extraSlots 单独指定附加槽位
      const legalIds = () => Core.agentSlotIdsOf(leg)
      const legalList = () => legalIds().map((id) => `${id}(${Core.slotNameOf(leg, id)})`).join('、')
      if (body.slot != null || Array.isArray(body.extraSlots)) {
        const primary = Array.isArray(body.slot) ? body.slot[0] : body.slot
        const extras = Array.isArray(body.slot) ? body.slot.slice(1) : body.extraSlots
        if (primary != null) {
          if (!legalIds().includes(primary)) {
            const unsortedHint =
              leg.type === 'unsorted' ? '。归位（未分类 → 正式段）需同时传 type，如 {"type":"hotel","slot":"h_invoice"}（group 可省略自动反推）' : ''
            sendJSON(res, 400, { error: { message: `slot「${primary}」不属于该行程段（${Core.TYPE_META[leg.type]?.label || leg.type}）。合法值：${legalList()}${unsortedHint}` } })
            return
          }
          rec.slot = primary
        }
        if (extras != null) {
          if (!Array.isArray(extras)) {
            sendJSON(res, 400, { error: { message: 'extraSlots 需为数组，如 ["h_pay"]' } })
            return
          }
          const bad = extras.filter((s) => !legalIds().includes(s))
          if (bad.length) {
            sendJSON(res, 400, { error: { message: `extraSlots 中 ${JSON.stringify(bad)} 不属于该行程段。合法值：${legalList()}` } })
            return
          }
          rec.extraSlots = extras.filter((s) => s !== rec.slot)
        }
      }

      if (body.label != null) leg.label = String(body.label)
      if (body.issuer != null || body.payee != null || body.consistent != null || body.note != null) {
        if (!leg.payCheck) leg.payCheck = { issuer: '', payee: '', consistent: false, note: '' }
        if (body.issuer != null) leg.payCheck.issuer = String(body.issuer)
        if (body.payee != null) leg.payCheck.payee = String(body.payee)
        if (body.consistent != null) leg.payCheck.consistent = !!body.consistent
        if (body.note != null) leg.payCheck.note = String(body.note)
      }
      const stillUnsorted = rec.slot === 'unsorted'
      markSessionsDirty()
      sendJSON(res, 200, {
        ok: true,
        file: { id: rec.id, slot: rec.slot, extraSlots: rec.extraSlots || [], amount: rec.amount, members: rec.members, scope: rec.scope, leg: { group: leg.group, type: leg.type } },
        ...(stillUnsorted ? { warning: `文件已移动到目标段，但 slot 仍为 unsorted，请继续 PATCH slot 指定槽位（合法值：${legalList()}）` } : {}),
      })
      return
    }
  }

  if (req.method === 'GET' && rest[0] === 'status' && rest.length === 1) {
    sendJSON(res, 200, agentSummary(session))
    return
  }

  if (req.method === 'POST' && rest[0] === 'zip' && rest.length === 1) {
    try {
      if (!session.st.teamName.trim()) {
        sendJSON(res, 400, { error: { message: '请先用 PATCH /sessions/:token 设置 teamName' } })
        return
      }
      const buf = await generateTeamZip(session)
      send(res, 200, buf, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(session.st.teamName)}.zip"`,
      })
    } catch (e) {
      sendJSON(res, 400, { error: { message: (e && e.message) || String(e) } })
    }
    return
  }

  sendJSON(res, 404, { error: { message: '未知 Agent 端点，GET /api/agent 查看指南' } })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

    if (req.method === 'OPTIONS') {
      send(res, 204, null, {
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Token, X-Filename',
      })
      return
    }

    // ---- AI Agent 会话 API（同学的 AI 无需打开网页即可完成导入/核对/打包）----
    if (pathname === '/api/agent' || pathname.startsWith('/api/agent/')) {
      await handleAgent(req, res, pathname, url)
      return
    }

    // ---- 识别代理：浏览器 → 本服务器 → 本机 Ollama ----
    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/api/chat')) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const ollamaBody = pathname === '/api/chat' ? body : toOllamaChat(body)
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaBody),
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        sendJSON(res, r.status, { error: { message: `Ollama 返回 ${r.status}：${t.slice(0, 200)}` } })
        return
      }
      const j = await r.json()
      // 统一返回 OpenAI 格式（原生响应也包一层），前端解析逻辑不变
      const content = j?.message?.content ?? j?.choices?.[0]?.message?.content ?? ''
      sendJSON(res, 200, { choices: [{ message: { role: 'assistant', content } }] })
      return
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      const r = await fetch(`${OLLAMA_URL}/api/tags`).catch(() => null)
      if (!r || !r.ok) {
        sendJSON(res, 502, { error: { message: '无法连接 Ollama' } })
        return
      }
      const j = await r.json()
      sendJSON(res, 200, {
        object: 'list',
        data: (j.models || []).map((m) => ({ id: m.name, object: 'model' })),
      })
      return
    }


// ---- 静态文件（dist/）----
    if (req.method === 'GET') {
      let rel = pathname === '/' ? '/index.html' : pathname
      let file = path.normalize(path.join(DIST, rel))
      if (!file.startsWith(DIST)) {
        send(res, 403, 'Forbidden')
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html') // 单页应用回退
      }
      if (!fs.existsSync(file)) {
        send(res, 404, 'Not Found')
        return
      }
      const ext = path.extname(file).toLowerCase()
      send(res, 200, fs.readFileSync(file), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      })
      return
    }

    send(res, 405, 'Method Not Allowed')
  } catch (e) {
    sendJSON(res, 500, { error: { message: (e && e.message) || String(e) } })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[deploy] 服务已启动: http://0.0.0.0:${PORT}/\n` +
      `[deploy] 静态目录: ${DIST}\n` +
      `[deploy] 识别代理: POST /v1/chat/completions → ${OLLAMA_URL} (num_ctx ${NUM_CTX})`,
  )
})
