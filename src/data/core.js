/* 纯逻辑核心：浏览器与服务器（零依赖部署）共用。
   本文件禁止引入 store / vue / pdfjs-dist / pdf-lib —— 只允许 utils/zip 与 utils/misc。
   所有函数都接受 (st, pg) 形式的普通对象（结构与 store 的 state / pkg 一致），
   不读取任何单例，服务器可为每个会话构造独立实例。 */
import { makeZip } from '../utils/zip.js'
import { membersCSVString, sanitizeName } from '../utils/misc.js'

export const SCHOOL = '东南大学'
export const TAX_ID = '12100000466006770Q'

/* ---------- 材料模型 ---------- */

export const GROUPS = [
  { id: 'transport', name: '往返交通', types: ['flight', 'train', 'local'] },
  { id: 'stay', name: '赛站住宿', types: ['hotel'] },
]

export const TYPE_META = {
  entryfee: {
    label: '参赛费',
    ph: '',
    slots: [
      { id: 'invite', name: '邀请函', required: true, note: '打印件扫描' },
      { id: 'fee_invoice', name: '参赛费发票', required: true, note: '一般发送至教练邮箱；抬头「东南大学」' },
      { id: 'fee_pay', name: '参赛费支付记录', required: true, note: '与发票金额核对一致' },
    ],
  },
  flight: {
    label: '飞机',
    ph: '如：10.24 MU2801 南京—长春',
    slots: [
      { id: 'f_invoice', name: '机票发票', required: true, note: '抬头「东南大学」' },
      { id: 'f_pay', name: '机票支付记录', required: true, note: '必附打印件，与发票金额核对；购票勿勾选保险等附加服务，避免金额不一致' },
      { id: 'f_order', name: '机票订单记录', required: false, note: '需显示「经济舱」；若发票已显示姓名、起止地点和「经济舱」可免附' },
    ],
  },
  train: {
    label: '高铁',
    ph: '如：10.24 G1234 南京南—长春',
    slots: [
      { id: 't_voucher', name: '车票报销凭证', required: true, note: '打印报销凭证即可，无需支付/预订记录；仅限二等座；购票勿勾选保险等附加服务' },
    ],
  },
  local: {
    label: '市内交通',
    ph: '如：10.24 市内地铁/打车',
    slots: [
      { id: 'l_invoice', name: '发票', required: true },
      { id: 'l_pay', name: '支付记录', required: true },
    ],
  },
  hotel: {
    label: '住宿',
    ph: '如：10.24–10.26 ××酒店',
    slots: [
      { id: 'h_invoice', name: '住宿发票', required: true, note: '尽量含入住人、入住和离店时间' },
      { id: 'h_pay', name: '住宿支付记录（或 POS 单）', required: true, note: '与发票金额核对；开票盖章单位需与支付对象一致（不一致可请酒店开具证明）' },
      { id: 'h_flow', name: '住宿流水记录', required: true, note: '酒店前台开具并盖章' },
    ],
  },
}

export const slotsOf = (type) => (TYPE_META[type] || TYPE_META.entryfee).slots

export const SCOPE_OPTIONS = [
  { id: 'outbound', name: '去程' },
  { id: 'return', name: '返程' },
]

export const scopeLabelOf = (groups) => {
  const labels = SCOPE_OPTIONS.filter((s) => groups.includes(s.id)).map((s) => s.name)
  return labels.length === SCOPE_OPTIONS.length ? '去程返程' : labels.join('') || '未标注'
}

export const parseAmount = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/** 外部 ZIP 条目路径净化：防 zip-slip */
export const safeRel = (path) =>
  String(path)
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg))
    .join('/')

/**
 * 按文件名（及所在文件夹路径）猜测材料归属（批量导入自动分类用）。
 * 返回 { groupId, type, slotId, scopeHint } 或 null。
 */
export function classifyMaterial(name, path = '') {
  const n = `${String(name || '')} ${String(path || '')}`
  const has = (...words) => words.some((w) => n.includes(w))
  // 「行程单」视为发票类（航空运输电子客票行程单可作报销凭证；12306 行程单已被下方火车分支优先拦下）
  const inv = has('发票', '开票', '行程单')
  const pay = has('支付', '付款', '账单', '扣款')
  const scopeHint = has('去程') ? ['outbound'] : has('返程', '回程') ? ['return'] : null
  if (has('邀请函')) return { groupId: 'entryfee', type: 'entryfee', slotId: 'invite', scopeHint: null }
  if (has('报名费', '参赛费', '注册费', '赛站')) {
    return { groupId: 'entryfee', type: 'entryfee', slotId: pay ? 'fee_pay' : 'fee_invoice', scopeHint: null }
  }
  if (has('酒店', '住宿', '宾馆', '民宿', '水单')) {
    const slotId = inv ? 'h_invoice' : has('流水', '水单') ? 'h_flow' : 'h_pay'
    return { groupId: 'stay', type: 'hotel', slotId, scopeHint: null }
  }
  // 火车类关键词优先于「行程单」（12306 行程单也含「行程单」字样）
  if (has('火车', '高铁', '动车', '铁路', '12306', '车票')) {
    return { groupId: 'transport', type: 'train', slotId: 't_voucher', scopeHint }
  }
  if (has('机票', '航空', '航班', '客票', '行程单', '登机', '值机')) {
    const slotId = inv ? 'f_invoice' : pay ? 'f_pay' : 'f_order'
    return { groupId: 'transport', type: 'flight', slotId, scopeHint }
  }
  if (has('出租', '滴滴', '网约车', '打车', '高德', '地铁', '公交', '市内')) {
    return { groupId: 'transport', type: 'local', slotId: inv ? 'l_invoice' : 'l_pay', scopeHint }
  }
  // 类型判不出但范围词命中：只携带范围提示（导入预览仍默认「不导入」，手动改类型后范围自动生效）
  return scopeHint ? { groupId: null, type: null, slotId: null, scopeHint } : null
}

/* ---------- 识别文本的纯检查（OCR / 提取后的落库判定） ---------- */

/** 从文本里识别金额候选（¥/￥/元，以及 金额/合计/实付 等关键词后的数字），按金额降序，最多 3 个 */
export function detectAmounts(text) {
  if (!text) return []
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

/** 需要做发票抬头检查的槽位（支付记录、行程单、车票凭证等一律不查抬头） */
export const INVOICE_HEADER_SLOTS = ['f_invoice', 'h_invoice', 'l_invoice', 'fee_invoice']

/** 支付类槽位（做收款方提取，供收付款核对） */
export const PAY_PARTY_SLOTS = ['f_pay', 'h_pay', 'l_pay', 'fee_pay']

/** 往返交通材料的槽位（可按起讫地自动勾选去程 / 返程） */
export const SCOPE_TRANSPORT_SLOTS = ['f_invoice', 'f_pay', 'f_order', 't_voucher']

export function cabinCheck(slotId, text) {
  if (slotId !== 'f_invoice' && slotId !== 'f_order') return null
  const norm = (text || '').replace(/\s+/g, '')
  if (norm.length < 10) return null
  return { ok: norm.includes('经济舱') }
}

export function trainSeatCheck(slotId, text) {
  if (slotId !== 't_voucher') return null
  const norm = (text || '').replace(/\s+/g, '')
  if (!norm) return null
  return norm.includes('二等座') ? { ok: true } : null
}

export function invoiceHeaderCheck(slotId, slotName, fileName, text) {
  if (!INVOICE_HEADER_SLOTS.includes(slotId)) return null
  const norm = (text || '').replace(/\s+/g, '')
  const hay = `${slotName || ''} ${fileName || ''} ${norm}`
  if (!/发票/.test(hay)) return null
  if (norm.length < 10) return null
  return { ok: norm.includes(SCHOOL) || norm.includes(TAX_ID) }
}

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

/**
 * 按 OCR 文本里的起讫地判断去程 / 返程。
 * 只认真实路线分隔符（→、-、至、到、飞往、抵达…）两侧 24 字窗口；无命中时
 * 两城紧邻（48 字内）共现按先出现者为出发地（行程单表格列序）；相距远不猜。
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
  const h = norm.indexOf(home)
  const d = norm.indexOf(dest)
  if (h !== -1 && d !== -1 && Math.abs(h - d) <= 48) {
    return h < d ? { scope: 'outbound', label: `${home}→${dest}` } : { scope: 'return', label: `${dest}→${home}` }
  }
  return null
}

/* ---------- 基于 (st, pg) 的检查 ---------- */

export function slotNameOf(leg, slotId) {
  const slots = slotsOf(leg.type)
  return (slots.find((s) => s.id === slotId) || {}).name || slotId
}

export function memberNamesOfIdx(st, memberIdx) {
  if (memberIdx == null) return { all: true, names: [] }
  return { all: false, names: (memberIdx || []).map((i) => st.members[i]?.name).filter(Boolean) }
}

export function missingRequiredCore(st, pg) {
  const out = []
  for (const leg of pg.legs) {
    for (const slot of slotsOf(leg.type)) {
      if (!slot.required) continue
      if (!leg.files.some((f) => f.slot === slot.id)) out.push({ leg, slot })
    }
  }
  return out
}

export function memberCoverageCore(st, pg) {
  const transport = pg.legs.filter((l) => l.group === 'transport')
  const stay = pg.legs.filter((l) => l.group === 'stay')
  const covers = (f, i) => f.members == null || (f.members || []).includes(i)
  const hasFile = (legs, i, pred) => legs.some((l) => (l.files || []).some((f) => covers(f, i) && pred(f)))
  return st.members.map((m, i) => ({
    idx: i,
    name: m.name || `成员${i + 1}`,
    card: m.card,
    outbound: hasFile(transport, i, (f) => (f.scope || []).includes('outbound')),
    back: hasFile(transport, i, (f) => (f.scope || []).includes('return')),
    invoice: hasFile(stay, i, (f) => f.slot === 'h_invoice'),
  }))
}

export function coverageGapsCore(st, pg) {
  return memberCoverageCore(st, pg)
    .filter((c) => !c.outbound || !c.back || !c.invoice)
    .map((c) => {
      const miss = []
      if (!c.outbound) miss.push('去程')
      if (!c.back) miss.push('返程')
      if (!c.invoice) miss.push('住宿发票')
      return { name: c.name, miss }
    })
}

export function invoiceHeaderIssuesCore(pg) {
  const issues = []
  let checked = 0
  for (const leg of pg.legs) {
    for (const f of leg.files) {
      const m = f.meta
      if (!m || !m.header || typeof m.header.ok !== 'boolean') continue
      checked++
      if (!m.header.ok) {
        const g = GROUPS.find((x) => x.id === leg.group)
        issues.push({ name: f.file?.name || f.name || '', group: g ? g.name : '' })
      }
    }
  }
  return { issues, checked }
}

export function cabinIssuesCore(pg) {
  const issues = []
  let checked = 0
  for (const leg of pg.legs) {
    if (leg.group !== 'transport') continue
    const g = GROUPS.find((x) => x.id === leg.group)
    for (const f of leg.files) {
      if (f.slot !== 'f_invoice' && f.slot !== 'f_order') continue
      const m = f.meta
      if (!m || !m.cabin || typeof m.cabin.ok !== 'boolean') continue
      checked++
      if (!m.cabin.ok) issues.push({ name: f.file?.name || f.name || '', group: g ? g.name : '' })
    }
  }
  return { issues, checked }
}

export function amountCheckCore(st, pg) {
  const out = []
  for (const g of GROUPS) {
    const legs = pg.legs.filter((l) => l.group === g.id)
    let invSum = 0
    let paySum = 0
    let invCount = 0
    let payCount = 0
    for (const leg of legs) {
      for (const f of leg.files) {
        const v = parseAmount(f.amount)
        if (v == null) continue
        if (f.slot === 'f_invoice' || f.slot === 'h_invoice') {
          invSum += v
          invCount++
        } else if (f.slot === 'f_pay' || f.slot === 'h_pay') {
          paySum += v
          payCount++
        }
      }
    }
    if (!invCount && !payCount) continue
    out.push({
      group: g.id,
      name: g.name,
      invSum: Math.round(invSum * 100) / 100,
      paySum: Math.round(paySum * 100) / 100,
      invCount,
      payCount,
      match: invCount && payCount ? Math.round(invSum * 100) === Math.round(paySum * 100) : null,
    })
  }
  return out
}

/** 收付款核对未通过的行程段（填了信息且未勾「核对一致」） */
export function payCheckIssuesCore(pg) {
  const CONTENT_LABEL = { hotel: '住宿费', flight: '机票款', train: '火车票款', local: '交通费' }
  const out = []
  for (const g of GROUPS) {
    for (const leg of pg.legs.filter((l) => l.group === g.id)) {
      const pc = leg.payCheck
      if (!pc || (!pc.issuer && !pc.payee) || pc.consistent) continue
      const invSlotIds = slotsOf(leg.type).filter((s) => /发票/.test(s.name)).map((s) => s.id)
      const invFiles = invSlotIds.length ? leg.files.filter((f) => invSlotIds.includes(f.slot)) : []
      const amounts = invFiles.map((f) => parseAmount(f.amount)).filter((v) => v != null)
      out.push({
        name: `${TYPE_META[leg.type] ? TYPE_META[leg.type].label : ''}${leg.label ? ' ' + leg.label : ''}`,
        contentLabel: CONTENT_LABEL[leg.type] || '',
        invSum: invFiles.length && amounts.length === invFiles.length ? Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
        issuer: pc.issuer || '（未识别/未填写）',
        payee: pc.payee || '（未识别/未填写）',
        note: (pc.note || '').trim(),
        filled: !!(pc.note || '').trim(),
      })
    }
  }
  return out
}

/* ---------- 打包（服务器版：不含发票汇总 PDF，其余与浏览器版一致） ---------- */

const extOf = (f) => {
  const n = f.file?.name || f.name || ''
  const m = n.match(/(\.[a-z0-9]+)$/i)
  return m ? m[1] : ''
}

/** 按浏览器版命名规则生成清单条目 [{ path, file, name }] */
export function zipManifest(st, pg) {
  const out = []
  GROUPS.forEach((g, gi) => {
    const legs = pg.legs.filter((l) => l.group === g.id)
    legs.forEach((leg, li) => {
      const legDir =
        `${String(gi + 1).padStart(2, '0')}-${g.name}/` +
        `${String(li + 1).padStart(2, '0')}-${TYPE_META[leg.type].label}${leg.label ? '-' + sanitizeName(leg.label) : ''}`
      ;(leg.files || []).forEach((f, fi) => {
        const scope = g.id === 'transport' ? `-${scopeLabelOf(f.scope)}` : ''
        const { names } = memberNamesOfIdx(st, f.members)
        const members = f.members == null ? '全体' : names.join('-') || '未归属'
        const amt = f.amount ? `-¥${parseAmount(f.amount)}` : ''
        const name = f.file?.name || f.name || ''
        const fname = `${String(fi + 1).padStart(2, '0')}-${slotNameOf(leg, f.slot)}${scope}-${members}${amt}${extOf(f)}`
        out.push({ path: `${legDir}/${fname}`, file: f.file || f, name })
      })
    })
  })
  return out
}

/** 精简版核对报告（服务器 ZIP 用；浏览器版 report.js 内容更全） */
export function teamReportText(st, pg) {
  const L = []
  L.push(`队伍：${st.teamName || '（未命名）'}　比赛：${st.meta?.contest || '（未填写）'}`)
  L.push(`队长 / 报销负责人：${st.meta?.leader || '（未填写）'}`)
  if (st.members?.length) {
    L.push('参赛同学：' + st.members.map((m) => `${m.name}(${m.card || '无卡号'})`).join('、'))
  }
  const miss = missingRequiredCore(st, pg)
  L.push('')
  L.push(`必附材料：${miss.length ? `缺 ${miss.length} 项 —— ` + miss.map((m) => `${TYPE_META[m.leg.type].label}·${m.slot.name}`).join('；') : '齐全'}`)
  const cov = coverageGapsCore(st, pg)
  L.push(`归属：${cov.length ? cov.map((c) => `${c.name}缺${c.miss.join('/')}`).join('；') : '全部同学归属齐全'}`)
  for (const a of amountCheckCore(st, pg)) {
    L.push(`金额核对【${a.name}】：发票 ¥${a.invSum.toFixed(2)}（${a.invCount} 张）vs 支付 ¥${a.paySum.toFixed(2)}（${a.payCount} 笔）—— ${a.match ? '一致' : '不一致，需说明'}`)
  }
  const hdr = invoiceHeaderIssuesCore(pg)
  if (hdr.checked) L.push(`抬头：已检查 ${hdr.checked} 张，${hdr.issues.length ? hdr.issues.length + ' 张未含「东南大学」需人工核对' : '全部通过'}`)
  const cab = cabinIssuesCore(pg)
  if (cab.checked) L.push(`舱位：已检查 ${cab.checked} 张，${cab.issues.length ? cab.issues.length + ' 张未见「经济舱」需人工核对' : '全部通过'}`)
  const pc = payCheckIssuesCore(pg)
  if (pc.length) L.push(`收付款核对：${pc.length} 个行程段不一致（${pc.map((p) => p.name).join('；')}），需附情况说明`)
  return L.join('\n')
}

/**
 * 服务器版队伍 ZIP（零依赖）：文件 + 队伍信息 + 同学清单 + 核对报告 + 说明文件。
 * 与浏览器版差异：不含「发票汇总-扫描打印版.pdf」（pdf-lib 依赖）与差旅审批单；
 * 收付款不一致说明为 txt 字段版（docx 正式版在浏览器打包路径）。
 */
export async function buildTeamZipCore(st, pg) {
  if (!String(st.teamName || '').trim()) throw new Error('请先填写队名')
  const enc = new TextEncoder()
  const root = sanitizeName(`${st.meta?.contest || 'XCPC'}-${st.teamName}-报销材料`)
  const files = []

  for (const m of zipManifest(st, pg)) {
    const rel = safeRel(m.path)
    if (!rel) continue
    const bytes = m.file.arrayBuffer ? new Uint8Array(await m.file.arrayBuffer()) : m.file.bytes
    files.push({ path: `${root}/${rel}`, data: bytes })
  }

  const info = [
    `比赛：${st.meta?.contest || ''}`,
    `队伍：${st.teamName || ''}`,
    `报销负责人：${st.meta?.leader || ''}`,
    st.members?.length ? '参赛同学：\n' + st.members.map((m, i) => `  ${i + 1}. ${m.name} ${m.card}`).join('\n') : '',
  ].filter(Boolean)
  files.push({ path: `${root}/队伍信息.txt`, data: enc.encode(info.join('\n')) })
  if (st.members?.length) {
    files.push({ path: `${root}/参赛同学清单.csv`, data: enc.encode(membersCSVString(st.members)) })
  }
  files.push({ path: `${root}/核对报告.txt`, data: enc.encode('\ufeff' + teamReportText(st, pg)) })

  const mismatches = amountCheckCore(st, pg).filter((a) => a.match === false)
  if (mismatches.length) {
    const L = ['支付金额与发票金额不一致情况说明', '']
    for (const mm of mismatches) {
      L.push(`【${mm.name}】`)
      L.push(`  发票金额合计：¥${mm.invSum.toFixed(2)}（${mm.invCount} 张发票）`)
      L.push(`  支付记录合计：¥${mm.paySum.toFixed(2)}（${mm.payCount} 笔支付）`)
      L.push(`  差额：¥${(Math.round((mm.invSum - mm.paySum) * 100) / 100).toFixed(2)}`)
      L.push('')
    }
    L.push('说明：以上差额需在报销前核实原因（如优惠券、退款、多人分摊等）。')
    files.push({ path: `${root}/支付不一致说明.txt`, data: enc.encode('\ufeff' + L.join('\n')) })
  }

  const payIssues = payCheckIssuesCore(pg)
  if (payIssues.length) {
    const L = [
      '发票与银行卡支付信息不符情况说明书（字段版）',
      '',
      '（注意事项要求：发票开票方 / 盖章单位应与支付记录收款方一致；正式 docx 版请用网页打包）',
      '',
    ]
    for (const p of payIssues) {
      L.push(`【${p.name}】`)
      L.push(`  发票内容：${p.contentLabel || '＿＿'}`)
      L.push(`  发票金额：${p.invSum != null ? p.invSum.toFixed(2) + ' 元' : '＿＿'}`)
      L.push(`  发票单位名称：${p.issuer}`)
      L.push(`  该笔费用银行卡支付单位：${p.payee}`)
      L.push(`  不符原因：${p.note || '（未填写）'}`)
      L.push('')
    }
    files.push({ path: `${root}/发票与银行卡支付信息不符情况说明书.txt`, data: enc.encode('\ufeff' + L.join('\n')) })
  }

  return makeZip(files.map((f) => ({ name: f.path, data: f.data })))
}
