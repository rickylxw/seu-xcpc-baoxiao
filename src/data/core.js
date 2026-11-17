/* 纯逻辑核心：浏览器与服务器（零依赖部署）共用。
   本文件禁止引入 store / vue / pdfjs-dist / pdf-lib —— 只允许 utils/zip 与 utils/misc。
   所有函数都接受 (st, pg) 形式的普通对象（结构与 store 的 state / pkg 一致），
   不读取任何单例，服务器可为每个会话构造独立实例。 */
import { makeZip } from '../utils/zip.js'
import { readZipEntries, commonRoot } from '../utils/unzip.js'
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
      { id: 't_pay', name: '购票支付记录', required: false, note: '按需（规则未要求）；12306 购票支付记录想收集可附在这里' },
    ],
  },
  local: {
    label: '市内交通',
    ph: '如：10.24 市内地铁/打车',
    slots: [
      { id: 'l_invoice', name: '发票', required: true, note: '抬头「东南大学」；开票时选「发送到邮箱」，邮件里可同时拿到发票和行程单' },
      { id: 'l_pay', name: '支付记录', required: true },
      { id: 'l_order', name: '行程单', required: false, note: '打车 / 网约车需附行程单（对照起终点与金额）；在 App 开票时选「发送到邮箱」即可同时获得发票与行程单；地铁公交无行程单可不附' },
    ],
  },
  hotel: {
    label: '住宿',
    ph: '如：10.24–10.26 ××酒店',
    slots: [
      { id: 'h_invoice', name: '住宿发票', required: true, note: '尽量含入住人、入住和离店时间' },
      { id: 'h_pay', name: '住宿支付记录（或 POS 单）', required: true, note: '与发票金额核对；开票盖章单位需与支付对象一致（不一致可请酒店开具证明）；盖章结账流水含收款/POS 信息时视同满足' },
      { id: 'h_flow', name: '住宿流水记录', required: true, note: '酒店前台开具并盖章；含收款/POS 信息的盖章结账流水可兼任支付记录（一文件多槽）' },
    ],
  },
  /* 仅 AI Agent 会话使用：文件名判不出类别的落点，不参与任何核对与打包（网页端不会产生该段） */
  unsorted: {
    label: '未分类',
    ph: '',
    slots: [{ id: 'unsorted', name: '未分类材料', required: false, note: '文件名不含可识别关键词；读取内容后 PATCH group/type/slot 归位' }],
  },
}

/** 文件名分类关键词映射（与 classifyMaterial 保持一致；agent_guide 与上传警告共用） */
export const CLASSIFY_HINTS = [
  '邀请函 → 参赛费·邀请函',
  '报名费/参赛费/注册费/赛站 → 参赛费（文件名含「支付/付款/账单/扣款」→ 支付记录，否则 → 发票）',
  '酒店/住宿/宾馆/民宿/水单 → 住宿（含「发票/开票」→ 住宿发票；含「流水/水单」→ 住宿流水；其余 → 住宿支付记录）',
  '火车/高铁/动车/铁路/12306/车票 → 高铁·车票报销凭证',
  '机票/航空/航班/客票/行程单/登机/值机 → 飞机（含「发票/开票/行程单」→ 机票发票；含「支付/付款/账单/扣款」→ 机票支付记录；其余 → 机票订单）',
  '出租/滴滴/网约车/打车/高德/花小猪/T3出行/地铁/公交/市内 → 市内交通，市内强词优先于火车/飞机（含「行程单」→ 行程单；含「发票/开票」→ 发票；含「支付/付款/账单/扣款」→ 支付记录；其余 → 行程单）',
  '文件名含「去程/返程/回程」自动标注去程/返程',
].join('；')

/** AI Agent 专用虚拟槽位：超额/说明性材料，不参与核对，ZIP 归入该段「补充材料」文件夹 */
export const SUPPLEMENT_SLOT = 'supplement'
export const SUPPLEMENT_SLOT_NAME = '补充材料'

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
  // 市内交通强词（含打车 / 地铁）优先于火车与飞机（「滴滴行程单」「地铁行程单」不是机票也不是火车票）
  if (has('出租', '滴滴', '网约车', '打车', '高德', '花小猪', 'T3出行', '地铁', '公交', '市内')) {
    const slotId = inv && !has('行程单')
      ? 'l_invoice'
      : has('行程单') ? 'l_order' : pay ? 'l_pay' : 'l_order'
    return { groupId: 'transport', type: 'local', slotId, scopeHint }
  }
  // 火车类关键词优先于「行程单」（12306 行程单也含「行程单」字样）
  if (has('火车', '高铁', '动车', '铁路', '12306', '车票')) {
    return { groupId: 'transport', type: 'train', slotId: 't_voucher', scopeHint }
  }
  if (has('机票', '航空', '航班', '客票', '行程单', '登机', '值机')) {
    const slotId = inv ? 'f_invoice' : pay ? 'f_pay' : 'f_order'
    return { groupId: 'transport', type: 'flight', slotId, scopeHint }
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

/** 需要做发票抬头检查的槽位（含 t_voucher：12306 电子发票（铁路电子客票）自带购买方抬头；老式纯车票无「发票」字样自然跳过） */
export const INVOICE_HEADER_SLOTS = ['f_invoice', 'h_invoice', 'l_invoice', 'fee_invoice', 't_voucher']

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

/** 「名称：」后取值的终止字段（遇到即认为名称值结束） */
const NAME_TERMINATORS = [
  '统一社会信用代码', '纳税人识别号', '税号', '销售方', '售方', '购买方', '购方', '开户行',
  '开户银行', '账  号', '账号', '地  址', '地址', '电话', '密码区', '项目名称', '货物或',
  '开票人', '收款人', '复核', '金额', '备注', '机器编号', '机打号码', '校验码', '合计',
]

/** 提取文本里所有「名称：」/「发票抬头：」后的值（购买方区段优先由调用方截取） */
function nameValuesIn(text) {
  const out = []
  const re = /(?:名\s*称|抬\s*头)\s*[：:]/g
  let m
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length
    let end = text.length
    for (const term of NAME_TERMINATORS) {
      const t = text.indexOf(term, start)
      if (t !== -1 && t < end) end = t
    }
    const v = text
      .slice(start, end)
      .replace(/^[：:\s]+/, '')
      .replace(/[；;，,。．\s]+$/, '')
    if (v) out.push(v)
  }
  return out
}

/** 税号三态判定：'pass' = 出现且严格为我税号（所在字母数字段恰为税号，或以税号开头——数电票购买/销售方税号相邻）；'fail' = 出现了明确的他人税号；null = 未出现 */
function taxJudgment(norm) {
  const labeled = []
  const lre = /(?:统一社会信用代码|纳税人识别号|税号)\s*[:：]?\s*([0-9A-Za-z]{12,30})/g
  let m
  while ((m = lre.exec(norm))) {
    const run = m[1]
    if (run.includes(TAX_ID)) {
      if (run === TAX_ID || run.startsWith(TAX_ID)) labeled.push(true)
    } else labeled.push(false)
  }
  if (labeled.length) return labeled.some(Boolean) ? 'pass' : 'fail'
  // 无标签：全文按字母数字段判定（含我校税号的最大段，恰为税号或以税号开头 → 通过）
  const runRe = /[0-9A-Za-z]{10,}/g
  while ((m = runRe.exec(norm))) {
    if (!m[0].includes(TAX_ID)) continue
    if (m[0] === TAX_ID || m[0].startsWith(TAX_ID)) return 'pass'
    return 'fail'
  }
  return null
}

/** 购买方（发票抬头）名称值：数电 / 增值税票取「购买方」至「销售方」区段；无结构时取全文「名称：」值 */
function buyerNameValues(norm) {
  const b = norm.indexOf('购买方')
  const s = norm.indexOf('销售方')
  const section = b !== -1 ? norm.slice(b, s !== -1 && s > b ? s : undefined) : norm
  return nameValuesIn(section)
}

export function invoiceHeaderCheck(slotId, slotName, fileName, text) {
  if (!INVOICE_HEADER_SLOTS.includes(slotId)) return null
  const norm = (text || '').replace(/\s+/g, '')
  const hay = `${slotName || ''} ${fileName || ''} ${norm}`
  if (!/发票/.test(hay)) return null
  if (norm.length < 10) return null
  // 严格核对（用户要求）：① 名称值必须严格等于「东南大学」——多字（校区 / 附属）或少字都不过；
  // ② 税号出现时必须与我们完全一致（出现他人税号即拒）；文本层缺名称值时以税号判定兜底。
  const names = buyerNameValues(norm)
  const tax = taxJudgment(norm)
  let ok
  if (names.length) {
    ok = names.some((v) => v === SCHOOL) && tax !== 'fail'
  } else {
    ok = tax === 'pass'
  }
  return { ok }
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
  if (slotId === SUPPLEMENT_SLOT) return SUPPLEMENT_SLOT_NAME
  const slots = slotsOf(leg.type)
  return (slots.find((s) => s.id === slotId) || {}).name || slotId
}

/** 该行程段允许的槽位（预设 + 补充材料 + 自定义），供 Agent PATCH 校验与报错提示 */
export function agentSlotIdsOf(leg) {
  const ids = slotsOf(leg.type).map((s) => s.id)
  if (leg.group !== 'unsorted') ids.push(SUPPLEMENT_SLOT)
  for (const cs of leg.customSlots || []) ids.push(cs.id)
  return ids
}

/** 一文件多槽：主槽位之外的附加槽位（如盖章结账流水主槽 h_flow、附加 h_pay） */
export const extraSlotsOf = (f) => (Array.isArray(f.extraSlots) ? f.extraSlots : [])

export function memberNamesOfIdx(st, memberIdx) {
  if (memberIdx == null) return { all: true, names: [] }
  return { all: false, names: (memberIdx || []).map((i) => st.members[i]?.name).filter(Boolean) }
}

export function missingRequiredCore(st, pg) {
  const out = []
  for (const leg of pg.legs) {
    for (const slot of slotsOf(leg.type)) {
      if (!slot.required) continue
      if (!leg.files.some((f) => f.slot === slot.id || extraSlotsOf(f).includes(slot.id))) out.push({ leg, slot })
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
        const slots = [f.slot, ...extraSlotsOf(f)]
        if (slots.includes('f_invoice') || slots.includes('h_invoice')) {
          invSum += v
          invCount++
        } else if (slots.includes('f_pay') || slots.includes('h_pay')) {
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
      const invFiles = invSlotIds.length
        ? leg.files.filter((f) => invSlotIds.includes(f.slot) || extraSlotsOf(f).some((s) => invSlotIds.includes(s)))
        : []
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
        if (f.slot === 'unsorted') return // 未归位材料不进正式 ZIP（status 的 next 会提醒）
        const scope = g.id === 'transport' ? `-${scopeLabelOf(f.scope)}` : ''
        const { names } = memberNamesOfIdx(st, f.members)
        const members = f.members == null ? '全体' : names.join('-') || '未归属'
        const amt = f.amount ? `-¥${parseAmount(f.amount)}` : ''
        const name = f.file?.name || f.name || ''
        const fname = `${String(fi + 1).padStart(2, '0')}-${slotNameOf(leg, f.slot)}${scope}-${members}${amt}${extOf(f)}`
        // 补充材料（如支付流水副本、说明附件）：归入「补充材料」子文件夹，不与必附材料混放
        const dir = f.slot === SUPPLEMENT_SLOT ? `${legDir}/${SUPPLEMENT_SLOT_NAME}` : legDir
        out.push({ path: `${dir}/${fname}`, file: f.file || f, name })
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
 * 服务器版队伍 ZIP（零依赖）：文件 + 队伍信息 + 同学清单 + [调用方注入的附加文件] + 核对报告 + 说明文件。
 * extraFiles：调用方（server.js）生成的 { path, data } 附加条目（如发票汇总 PDF），插在同学清单之后；
 * 收付款不一致说明为 txt 字段版（docx 正式版在浏览器打包路径）。
 */
export async function buildTeamZipCore(st, pg, extraFiles = []) {
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
  for (const extra of extraFiles) {
    files.push({ path: safeRel(extra.path), data: extra.data })
  }
  files.push({ path: `${root}/核对报告.txt`, data: enc.encode('\ufeff' + teamReportText(st, pg)) })
  files.push({ path: `${root}/报销系统填写对照单.txt`, data: enc.encode('\ufeff' + sysFillText(st, pg)) })

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

/* ---------- 赛站汇总打包（负责人）---------- */

/** 解析核对报告文本的「四、待办事项」区段（原 report.js 的实现，纯文本解析） */
export function parseTodosSection(reportTextStr) {
  const lines = String(reportTextStr || '').split('\n')
  const start = lines.findIndex((l) => l.startsWith('【四、待办事项'))
  if (start === -1) return []
  const todos = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim()
    if (l.startsWith('【')) break
    const m = l.match(/^\d+\.\s+(.*)$/)
    if (m) todos.push(m[1])
  }
  return todos
}

/**
 * 赛站汇总 ZIP（负责人）：各队 ZIP 解包按队合并 + 00-参赛费 + 问题清单 + 汇总说明。
 * items: [{ file: Blob/File/Uint8Array 兼容对象, team: '队名（可空，取 ZIP 顶层目录）' }]
 * entryFeeFiles: [{ file: Blob/File/Uint8Array 兼容对象, name, slot: 'invite'|'fee_invoice'|'fee_pay' }]
 * opts.approvalDocxBytes: 可选——差旅审批单 docx 字节（浏览器端由表单生成；服务器端缺省时汇总说明会注明另行提交）
 */
export async function buildStationZipCore(stationName, items, entryFeeFiles = [], opts = {}) {
  const enc = new TextEncoder()
  const root = sanitizeName(`${stationName}-报销材料汇总`)
  const files = []
  const summary = [
    '赛站报销材料汇总',
    `赛站：${stationName}`,
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `队伍数：${items.length}`,
    '',
  ]
  const used = new Set()
  const teamIssues = []
  for (const it of items) {
    const entries = await readZipEntries(it.file)
    const strip = commonRoot(entries.map((e) => e.name))
    const fallbackZip = it.file && it.file.name ? it.file.name.replace(/\.zip$/i, '') : ''
    const rootName = strip ? strip.replace(/\/$/, '') : ''
    let team = safeRel(sanitizeName(it.team || rootName || fallbackZip || '未命名队')) || '未命名队'
    const base = team
    let k = 2
    while (used.has(team)) team = `${base}-${k++}`
    used.add(team)

    let cnt = 0
    for (const e of entries) {
      const rel = safeRel(strip && e.name.startsWith(strip) ? e.name.slice(strip.length) : e.name)
      if (!rel) continue
      files.push({ name: `${root}/${team}/${rel}`, data: e.data })
      cnt++
    }
    // 解析该队核对报告中的待办事项，汇总到问题清单
    const reportEntry = entries.find((e) => e.name.includes('核对报告.txt'))
    let todos = []
    if (reportEntry) {
      todos = parseTodosSection(new TextDecoder('utf-8').decode(reportEntry.data))
    }
    teamIssues.push({ team, todos })
    summary.push(`- ${team}：${cnt} 个文件${todos.length ? `，待办 ${todos.length} 项 ⚠` : ''}`)
  }

  // 问题清单：跨队伍汇总各队未完成待办（从各队核对报告解析）
  const allIssues = teamIssues.filter((t) => t.todos.length)
  if (allIssues.length) {
    const L = ['各队伍待办事项清单（提交前请逐项核实）', '']
    for (const t of allIssues) {
      L.push(`【${t.team}】共 ${t.todos.length} 项`)
      t.todos.forEach((td, i) => L.push(`  ${i + 1}. ${td}`))
      L.push('')
    }
    files.push({
      name: `${root}/问题清单.txt`,
      data: enc.encode('\ufeff' + L.join('\n')),
    })
  }

  // 参赛费材料（赛站级，负责人统一收取），放进 00-参赛费/
  if (entryFeeFiles.length) {
    const efSlots = TYPE_META.entryfee.slots
    const ordered = []
    for (const s of efSlots) ordered.push(...entryFeeFiles.filter((fl) => fl.slot === s.id))
    ordered.push(...entryFeeFiles.filter((fl) => !efSlots.some((s) => s.id === fl.slot)))
    let n = 0
    for (const fl of ordered) {
      const slotName = efSlots.find((s) => s.id === fl.slot)?.name || '其他材料'
      const bytes = fl.bytes || (fl.file && fl.file.arrayBuffer ? new Uint8Array(await fl.file.arrayBuffer()) : null)
      if (!bytes) continue
      const ext = (fl.file?.name || fl.name || '').match(/\.[^.]+$/)?.[0] || ''
      files.push({
        name: `${root}/00-参赛费/${String(++n).padStart(2, '0')}-${slotName}${ext}`,
        data: bytes,
      })
    }
    summary.push(`- 参赛费材料：${n} 个文件（负责人统一收取）`)
  }

  // 差旅审批单：调用方提供字节则打包（服务器版由负责人另行用网页生成或线下提交）
  if (opts.approvalDocxBytes) {
    files.push({
      name: `${root}/差旅审批单.docx`,
      data: opts.approvalDocxBytes,
    })
    summary.push('- 差旅审批单：1 份')
  } else {
    summary.push('- 差旅审批单：另行提交（可用网页端「差旅审批单」页生成后加入）')
  }
  summary.push(
    '',
    '说明：各队伍材料由《XCPC 报销材料整理工具》按队打包后汇总，材料明细见各队伍文件夹内的队伍信息.txt 与核对报告.txt。',
  )
  files.push({ name: `${root}/汇总说明.txt`, data: enc.encode('\ufeff' + summary.join('\n')) })
  return makeZip(files)
}

/* ---------- 财务系统「报销单管理」填写对照（生成对照单文档）---------- */

/** 按队员汇总费用：车船费（机票发票+车票凭证）/ 市内交通（交通发票）/ 住宿费（住宿发票）。
 *  members 为 null（全员共享）的金额单独计入 unassigned，不摊到个人。 */
export function memberAmountsCore(st, pg) {
  const per = st.members.map((m) => ({ idx: st.members.indexOf(m), name: m.name || `成员${st.members.indexOf(m) + 1}`, carShip: 0, local: 0, hotel: 0 }))
  const un = { carShip: 0, local: 0, hotel: 0 }
  const bucketOf = (slot) => {
    if (slot === 'f_invoice' || slot === 't_voucher') return 'carShip'
    if (slot === 'l_invoice') return 'local'
    if (slot === 'h_invoice') return 'hotel'
    return null
  }
  for (const leg of pg.legs) {
    for (const f of leg.files) {
      const bucket = bucketOf(f.slot)
      if (!bucket) continue
      const amt = parseAmount(f.amount)
      if (amt == null) continue
      if (f.members == null || !(f.members || []).length) {
        un[bucket] += amt
      } else {
        for (const i of f.members) {
          const row = per.find((p) => p.idx === i)
          if (row) row[bucket] += amt
        }
      }
    }
  }
  const round = (v) => Math.round(v * 100) / 100
  return {
    per: per.map((p) => ({ name: p.name, carShip: round(p.carShip), local: round(p.local), hotel: round(p.hotel) })),
    unassigned: { carShip: round(un.carShip), local: round(un.local), hotel: round(un.hotel) },
  }
}

/** 「报销系统填写对照单」文本：基本信息屏 + 差旅费明细屏（财务系统字段 → 工具值） */
export function sysFillText(st, pg) {
  const L = []
  const amt = (v) => (v ? `¥${v}` : '')
  L.push('【一、报销基本信息（财务系统「报销单管理 → 请填写报销基本信息」）】')
  L.push(`选择业务大类：日常报销业务`)
  L.push(`报销项目号：${st.meta?.projectNo || '（未填写）'}`)
  L.push(`项目负责人：${st.meta?.projectLeader || '（未填写）'}`)
  L.push(`申请人工号：${st.meta?.leaderCard || '（未填写）'}`)
  L.push(`申请人姓名：${st.meta?.leader || '（未填写）'}`)
  L.push(`实际报销人：${st.meta?.leader || '（未填写）'}`)
  L.push(`电话：${st.meta?.phone || '（未填写）'}`)
  L.push(`手机：${st.meta?.phone || '（未填写）'}`)
  L.push(`电子邮件：${st.meta?.email || '（未填写）'}`)
  const attach = pg.legs.reduce((n, leg) => n + leg.files.length, 0)
  L.push(`附件张数：${attach}`)
  L.push(`摘要：${st.meta?.contest ? `参加${st.meta.contest}差旅费报销` : '（未填写：建议「参加XX比赛差旅费报销」）'}`)
  L.push(`支付方式：${st.meta?.payMethod || '（未填写）'}`)
  L.push(`币种：人民币`)
  L.push('')
  L.push('【二、差旅费明细（财务系统「差旅费」页，每名出差人一行）】')
  L.push(`出差地点：${st.approval?.place || st.meta?.homeCity || '（未填写）'}`)
  const days = st.meta?.dateContest && st.meta?.dateReturn
    ? Math.round((new Date(st.meta.dateReturn) - new Date(st.meta.dateContest)) / 86400000) + 1
    : null
  L.push(`出差期间：${st.meta?.dateContest || '____'} 至 ${st.meta?.dateReturn || '____'}${days ? `（${days} 天）` : ''}`)
  L.push('')
  const ma = memberAmountsCore(st, pg)
  const anyAmt = ma.per.some((p) => p.carShip || p.local || p.hotel) || ma.unassigned.carShip || ma.unassigned.local || ma.unassigned.hotel
  if (anyAmt) {
    L.push('姓名｜职称｜出差地点｜车船费｜市内交通｜住宿费')
    for (const p of ma.per) {
      L.push(`${p.name}｜学生｜${st.approval?.place || ''}｜车船费 ¥${p.carShip.toFixed(2)}｜市内交通 ¥${p.local.toFixed(2)}｜住宿费 ¥${p.hotel.toFixed(2)}`)
    }
    const un = ma.unassigned
    if (un.carShip || un.local || un.hotel) {
      L.push(`（未按人拆分的全员共享费用：车船费 ¥${un.carShip.toFixed(2)}、市内交通 ¥${un.local.toFixed(2)}、住宿费 ¥${un.hotel.toFixed(2)}——如需按人拆分请在材料归属中指定队员）`)
    }
  } else {
    L.push('（暂无按人归属的费用数据；导入发票并填写金额 / 归属后自动生成）')
  }
  L.push('')
  L.push('【三、其他费用与补贴（财务系统对应输入框）】')
  L.push('培训费 / 机场费 / 保险费 / 行李费 / 会务费 / 其他费用：见材料（本工具未单独跟踪，按发票手工填写）')
  L.push('教工伙食补贴 / 教工交通补贴：仅教工出差填写（学生参赛一般为 0）')
  L.push('学生伙食补贴 / 学生交通补贴：按财务标准与出差天数填写')
  L.push('')
  L.push('【四、注意事项】')
  L.push('1. 附件张数 = 本 ZIP 内材料文件数；支付方式 / 币种（人民币）按财务系统下拉选择')
  L.push('2. 「选择已认证发票」：上传数电票后财务系统自动带出，无需手工录入')
  L.push('3. 报销等级：飞机仅限经济舱，高铁仅限二等座；住宿超标准部分不能报销')
  return L.join('\n')
}
