// 部署服务器：静态托管 dist/ + 识别代理（浏览器 → 本服务器 → 本机 Ollama）
// 用法：npm run build && node server.js
// 环境变量：PORT（默认 8080）、OLLAMA_URL（默认 http://127.0.0.1:11434）、OLLAMA_NUM_CTX（默认 8192）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as Core from './src/data/core.js'

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
const SESSION_TTL = 4 * 3600 * 1000
const MAX_SESSIONS = 50
const sessions = new Map() // token → session

function newSession({ teamName, members = [], contest = '', leader = '', homeCity = '南京' }) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  const session = {
    token,
    created: Date.now(),
    st: {
      meta: { contest, dateContest: '', dateReturn: '', leader, homeCity },
      teamName: String(teamName || ''),
      members: (members || []).map((m) => ({ name: String(m.name || ''), card: String(m.card || '') })),
      approval: { place: '', unit: '' },
    },
    pg: { legs: [] },
    files: [], // 平铺索引：{ id, legIndex, ...legFile }
  }
  sessions.set(token, session)
  return session
}
setInterval(() => {
  const now = Date.now()
  for (const [t, s] of sessions) if (now - s.created > SESSION_TTL) sessions.delete(t)
}, 10 * 60 * 1000).unref()

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
    const mime = /\.png$/i.test(rec.name) ? 'image/png' : 'image/jpeg'
    const prompt =
      '识别这张报销材料图片，只输出一个 JSON 对象：{"金额":数字,"同学":["姓名"],"抬头":"东南大学或空","经济舱":true或false,"开票方":"发票开具单位全名","收款方":"支付记录收款方全名","起始地":"出发城市","到达地":"到达城市"}。无法判断的字段用空值。'
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_VISION_MODEL || 'glm-ocr:latest',
        stream: false,
        options: { num_ctx: NUM_CTX },
        messages: [{ role: 'user', images: [b64], content: prompt }],
      }),
    })
    if (!r.ok) throw new Error(`Ollama ${r.status}`)
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
    rec.meta = { status: '识别失败（可由 AI 自行读取图片内容后 PATCH 提交）' }
  })
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
  const filesView = session.files.map((f) => ({
    id: f.id,
    name: f.name,
    slot: f.slot,
    leg: `${Core.TYPE_META[session.pg.legs[f.legIndex].type].label}`,
    amount: f.amount || null,
    members: f.members == null ? '全员' : (f.members || []).map((i) => st.members[i]?.name).filter(Boolean),
    scope: f.scope,
    recog: f.recog ? f.recog.status : null,
    issuer: f.meta?.issuer || null,
    payee: f.meta?.payee || null,
    scopeAuto: f.meta?.scopeAuto || null,
    header: f.meta?.header?.ok ?? null,
    cabin: f.meta?.cabin?.ok ?? null,
  }))
  return {
    teamName: st.teamName,
    members: st.members,
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
    next,
  }
}

const agentGuide = () => ({
  project: 'XCPC 报销材料整理工具（东南大学）—— AI 可驱动整套报销材料整理流程',
  how_to_drive: [
    '1. POST /api/agent/sessions 创建会话（携带队名与同学名单），得到 token',
    '2. 对每个材料文件：POST /api/agent/sessions/:token/files（请求体为文件原始字节，头 X-Filename 放文件名）。服务器按文件名自动分类到行程段/槽位，图片会自动调用 OCR 识别',
    '3. GET /api/agent/sessions/:token/status 查看全部状态、检查结果与 next 建议',
    '4. 对识别不到的字段（金额/归属/开票方/收款方等），由你（AI）自行读取文件内容，PATCH /api/agent/sessions/:token/files/:fileId 提交',
    '5. 全部检查通过后 POST /api/agent/sessions/:token/zip 下载打包好的队伍 ZIP',
    '注意：文本型 PDF/OFD 服务器不做内容解析，金额/归属等由你读取后 PATCH 提交；所有会话 4 小时后自动过期',
  ],
  material_rules: {
    groups: Core.GROUPS,
    slots: Core.TYPE_META,
    必附: '每段必附槽位见 slots.required；常见漏项：酒店流水、机票订单、行程单、参赛费支付记录',
    金额: '支付金额必须与发票金额一致；购票勿勾选保险',
    抬头: '所有可改抬头的发票抬头必须为「东南大学」，税号 12100000466006770Q',
    舱位: '飞机仅限经济舱（材料需含「经济舱」字样）；高铁仅限二等座',
    收付款: '住宿发票盖章单位需与支付记录收款方一致；不一致需填写说明（可请酒店开具证明）',
    范围: '往返交通材料需标注去程/返程（scope: ["outbound"]/["return"]/both）',
  },
  endpoints: [
    { method: 'GET', path: '/api/agent', desc: '本指南' },
    { method: 'POST', path: '/api/agent/sessions', body: { teamName: '队名(必填)', members: [{ name: '姓名', card: '一卡通号' }], contest: '比赛名', leader: '负责人', homeCity: '出发城市(默认南京)' }, resp: { token: 'xxxx' } },
    { method: 'PATCH', path: '/api/agent/sessions/:token', body: { teamName: '…', members: [{ name: '…', card: '…' }], meta: { contest: '…', leader: '…', homeCity: '…', dateContest: 'YYYY-MM-DD', dateReturn: 'YYYY-MM-DD' } }, desc: '更新会话基础信息' },
    { method: 'POST', path: '/api/agent/sessions/:token/files', headers: { 'X-Filename': '文件名（URL 编码）' }, body: '文件原始字节', resp: { fileId: 'fab12c34', slot: 'f_order', leg: 'transport/flight', scope: ['outbound', 'return'], recog: 'pending' } },
    { method: 'PATCH', path: '/api/agent/sessions/:token/files/:fileId', body: { amount: '670.00', members: ['姓名'], scope: ['outbound'], slot: 'f_order', label: '段备注', issuer: '开票方', payee: '收款方', consistent: true, note: '不一致说明' }, desc: 'members 用姓名数组（服务器换算下标）；issuer/payee/consistent/note 写入该文件所在段的收付款核对' },
    { method: 'DELETE', path: '/api/agent/sessions/:token/files/:fileId', desc: '删除文件' },
    { method: 'GET', path: '/api/agent/sessions/:token/status', resp: '全量状态 + checks + next（下一步建议）' },
    { method: 'POST', path: '/api/agent/sessions/:token/zip', resp: 'ZIP 二进制（Content-Disposition 附件）' },
  ],
})

async function handleAgent(req, res, pathname) {
  // 指南（无需鉴权）
  if (req.method === 'GET' && pathname === '/api/agent') {
    sendJSON(res, 200, agentGuide())
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
    sendJSON(res, 200, {
      token: session.token,
      expiresInHours: SESSION_TTL / 3600000,
      next: '上传文件：POST /api/agent/sessions/' + session.token + '/files（X-Filename 头 + 文件字节）',
    })
    return
  }

  // 以下均需 token（/api/agent/sessions/:token/... → parts[2]='sessions'，token 在 parts[3]）
  const token = parts[3] || ''
  const session = sessions.get(token)
  if (!session) {
    sendJSON(res, 404, { error: { message: '会话不存在或已过期（重新 POST /api/agent/sessions 创建）' } })
    return
  }
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
    const bytes = new Uint8Array(await readBody(req, 64))
    const cls = Core.classifyMaterial(filename)
    if (!cls || !cls.groupId) {
      sendJSON(res, 400, {
        error: { message: '无法从文件名判断材料类别。请在文件名中加入关键词（如 机票发票/机票支付记录/机票订单/酒店发票/酒店支付/酒店流水/火车票/参赛费发票…），或先上传后用 PATCH 指定 slot' },
      })
      return
    }
    const leg = ensureLeg(session, cls.groupId, cls.type)
    const rec = {
      id: 'f' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      legIndex: session.pg.legs.indexOf(leg),
      name: filename,
      bytes,
      slot: cls.slotId,
      amount: '',
      members: null,
      scope: cls.groupId === 'transport' ? cls.scopeHint || ['outbound', 'return'] : [],
      meta: null,
      recog: null,
    }
    leg.files.push(rec)
    session.files.push(rec)
    recognizeAsync(session, rec)
    sendJSON(res, 200, {
      fileId: rec.id,
      slot: rec.slot,
      leg: { group: cls.groupId, type: cls.type },
      scope: rec.scope,
      recog: rec.recog,
      hint: '图片将自动 OCR；文本型 PDF/OFD 请自行读取内容后 PATCH 提交 amount/members',
    })
    return
  }

  if (rest[0] === 'files' && rest.length === 2) {
    const rec = session.files.find((f) => f.id === rest[1])
    if (!rec) {
      sendJSON(res, 404, { error: { message: '文件不存在' } })
      return
    }
    const leg = session.pg.legs[rec.legIndex]
    if (req.method === 'DELETE') {
      leg.files.splice(leg.files.indexOf(rec), 1)
      session.files.splice(session.files.indexOf(rec), 1)
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
      if (body.slot != null) {
        const legal = Core.slotsOf(leg.type).some((s) => s.id === body.slot) || (leg.customSlots || []).some((s) => s.id === body.slot)
        if (!legal) {
          sendJSON(res, 400, { error: { message: 'slot 不属于该行程段：' + Core.slotsOf(leg.type).map((s) => s.id).join(', ') } })
          return
        }
        rec.slot = body.slot
      }
      if (body.label != null) leg.label = String(body.label)
      if (body.issuer != null || body.payee != null || body.consistent != null || body.note != null) {
        if (!leg.payCheck) leg.payCheck = { issuer: '', payee: '', consistent: false, note: '' }
        if (body.issuer != null) leg.payCheck.issuer = String(body.issuer)
        if (body.payee != null) leg.payCheck.payee = String(body.payee)
        if (body.consistent != null) leg.payCheck.consistent = !!body.consistent
        if (body.note != null) leg.payCheck.note = String(body.note)
      }
      sendJSON(res, 200, { ok: true, file: { id: rec.id, slot: rec.slot, amount: rec.amount, members: rec.members, scope: rec.scope } })
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
      const zip = await Core.buildTeamZipCore(session.st, session.pg)
      const buf = Buffer.from(await zip.arrayBuffer())
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
