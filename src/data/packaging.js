/* 材料打包：按队伍打包（分段 + 材料槽位 + 规范命名）与赛站汇总 */
import { state, pkg } from '../store'
import { makeZip } from '../utils/zip'
import { readZipEntries, commonRoot } from '../utils/unzip'
import { renderOfd, paintOfdPage } from '../utils/ofd'
import { membersCSVString, sanitizeName } from '../utils/misc'
import { buildApprovalDocxBlob, buildPayCheckDocxBlob } from './approval'
import { PDFDocument } from 'pdf-lib'
import { reportText, parseTodosSection } from './report'

/** 打包分组：往返交通 / 赛站住宿（参赛费材料归赛站汇总负责人统一收取，见 buildStationZipBlob） */
export const GROUPS = [
  { id: 'transport', name: '往返交通', types: ['flight', 'train', 'local'] },
  { id: 'stay', name: '赛站住宿', types: ['hotel'] },
]

/** 每种行程类型的材料槽位（依据注意事项的材料要求） */
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
      { id: 'f_pay', name: '机票支付记录', required: true, note: '必附打印件，与发票金额核对' },
      { id: 'f_order', name: '机票订单记录', required: false, note: '需显示「经济舱」；若发票已显示姓名、起止地点和「经济舱」可免附' },
    ],
  },
  train: {
    label: '高铁',
    ph: '如：10.24 G1234 南京南—长春',
    slots: [
      { id: 't_voucher', name: '车票报销凭证', required: true, note: '打印报销凭证即可，无需支付/预订记录；仅限二等座' },
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
      { id: 'h_pay', name: '住宿支付记录（或 POS 单）', required: true, note: '与发票金额核对；开票盖章单位需与支付对象一致' },
      { id: 'h_flow', name: '住宿流水记录', required: true, note: '酒店前台开具并盖章' },
    ],
  },
}

export const slotsOf = (type) => (TYPE_META[type] || TYPE_META.entryfee).slots

/**
 * 按文件名（及其所在文件夹路径，如「…/酒店/xxx.pdf」）猜测材料归属（批量导入自动分类用）。
 * 返回 { groupId, type, slotId, scopeHint } 或 null（无法判断，导入预览里默认「不导入」）。
 * scopeHint：文件名明确写「去程 / 返程」时给出，优先级高于识别文本的起讫地判断。
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

/** 预设槽位 + 该段的自定义材料项（自定义项不参与必附检查） */
export function allSlotsOf(leg) {
  return [
    ...slotsOf(leg.type),
    ...(leg.customSlots || []).map((cs) => ({ id: cs.id, name: cs.name || '其他材料', required: false, custom: true })),
  ]
}

export function slotNameOf(leg, slotId) {
  const s = allSlotsOf(leg).find((x) => x.id === slotId)
  return (s && s.name) || '其他材料'
}

/** 文件归属队员的姓名列表（members 为 null 表示全员）；isAll 标记是否默认全员 */
export function memberNamesOfIdx(memberIdx) {
  if (memberIdx == null) return { all: true, names: [] }
  return { all: false, names: memberIdx.map((i) => state.members[i]?.name).filter(Boolean) }
}

/** 往返交通材料的适用范围勾选项 */
export const SCOPE_OPTIONS = [
  { id: 'outbound', name: '去程' },
  { id: 'return', name: '返程' },
]

export const scopeLabelOf = (groups) => {
  const labels = SCOPE_OPTIONS.filter((s) => groups.includes(s.id)).map((s) => s.name)
  return labels.length === SCOPE_OPTIONS.length ? '去程返程' : labels.join('') || '未标注'
}

/**
 * 每位队员的材料归属进度：
 * 往返交通：去程、返程各至少有一份归属到该队员的材料（文件的适用范围勾选 + 归属队员决定）；
 * 住宿发票：至少有一份归属到该队员、且材料类别为「住宿发票」的文件。
 */
export function memberCoverage() {
  const transport = pkg.legs.filter((l) => l.group === 'transport')
  const stay = pkg.legs.filter((l) => l.group === 'stay')
  const covers = (f, i) => f.members == null || (f.members || []).includes(i)
  const hasFile = (legs, i, pred) =>
    legs.some((l) => (l.files || []).some((f) => covers(f, i) && pred(f)))
  return state.members.map((m, i) => ({
    idx: i,
    name: m.name || `成员${i + 1}`,
    card: m.card,
    outbound: hasFile(transport, i, (f) => (f.scope || []).includes('outbound')),
    back: hasFile(transport, i, (f) => (f.scope || []).includes('return')),
    invoice: hasFile(stay, i, (f) => f.slot === 'h_invoice'),
  }))
}

/** 归属不完整的队员清单，如 [{ name: '李四', miss: ['去程', '住宿发票'] }] */
export function coverageGaps() {
  const gaps = []
  for (const c of memberCoverage()) {
    const miss = []
    if (!c.outbound) miss.push('去程')
    if (!c.back) miss.push('返程')
    if (!c.invoice) miss.push('住宿发票')
    if (miss.length) gaps.push({ name: c.name, miss })
  }
  return gaps
}

/**
 * 机票舱位检查：机票发票 / 机票订单记录需含「经济舱」字样（飞机仅限经济舱）。
 * 返回 { issues: [{name, group}], checked }
 */
export function cabinIssues() {
  const issues = []
  let checked = 0
  for (const leg of pkg.legs) {
    if (leg.group !== 'transport') continue
    const g = GROUPS.find((x) => x.id === leg.group)
    for (const f of leg.files) {
      if (f.slot !== 'f_invoice' && f.slot !== 'f_order') continue
      const m = f.meta
      if (!m || !m.cabin || typeof m.cabin.ok !== 'boolean') continue
      checked++
      if (!m.cabin.ok) {
        issues.push({ name: f.file.name, group: g ? g.name : '' })
      }
    }
  }
  return { issues, checked }
}

const parseAmount = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

/**
 * 金额一致性检查（按注意事项通用要求：支付金额合计必须与发票金额一致）。
 * 返回各分组 { group, name, invSum, paySum, match: true|false|null(缺一边), invCount, payCount }
 */
export function amountCheck() {
  const out = []
  for (const g of GROUPS) {
    const legs = pkg.legs.filter((l) => l.group === g.id)
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

/**
 * 收集全部发票/报销凭证类文件（往返交通发票、住宿发票、车票凭证），按清单顺序
 */
export function collectInvoiceFiles() {
  const out = []
  for (const g of GROUPS) {
    const legs = pkg.legs.filter((l) => l.group === g.id)
    legs.forEach((leg, li) => {
      for (const fl of leg.files) {
        if (fl.slot === 'f_invoice' || fl.slot === 'h_invoice' || fl.slot === 't_voucher') {
          const label = `${g.name} · ${TYPE_META[leg.type] ? TYPE_META[leg.type].label : ''}${leg.label ? ' · ' + leg.label : ''}`
          out.push({ file: fl.file, slot: fl.slot, label })
        }
      }
    })
  }
  return out
}

/**
 * 发票汇总 PDF：仅含发票/报销凭证，按清单顺序合并成一份文档（便捷扫描/打印）。
 * PDF 材料原样无损合并；图片等比排版到 A4 页。返回 { blob, fileCount, pageCount }
 */
export async function buildInvoicesPdf() {
  const out = await PDFDocument.create()
  out.setTitle(`${state.meta.contest || 'XCPC'} 报销发票汇总（${state.teamName || '未命名队'}）`)
  const items = collectInvoiceFiles()
  let fileCount = 0
  const skipped = []
  for (const it of items) {
    try {
      if (/\.ofd$/i.test(it.file.name)) {
        // OFD：按坐标原样渲染（模板框线、印章图片、定位文字），页面尺寸用 OFD 原始 mm 尺寸
        const ofd = await renderOfd(it.file)
        if (!ofd.pages.length) throw new Error('OFD 内没有页面')
        for (const p of ofd.pages) {
          const cv = document.createElement('canvas')
          await paintOfdPage(cv, p, ofd.widthMm, ofd.heightMm)
          const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
          const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()))
          const page = out.addPage([(ofd.widthMm * 72) / 25.4, (ofd.heightMm * 72) / 25.4])
          page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
        }
        fileCount++
        continue
      }
      if (/\.pdf$/i.test(it.file.name)) {
        const src = await PDFDocument.load(await it.file.arrayBuffer(), { ignoreEncryption: true })
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach((p) => out.addPage(p))
      } else if (/\.(jpe?g|png)$/i.test(it.file.name)) {
        const buf = await it.file.arrayBuffer()
        const head = new Uint8Array(buf, 0, Math.min(12, buf.byteLength))
        let img
        if (head[0] === 0x89 && head[1] === 0x50) img = await out.embedPng(new Uint8Array(buf))
        else if (head[0] === 0xff && head[1] === 0xd8) img = await out.embedJpg(new Uint8Array(buf))
        else throw new Error('不支持的图片格式')
        const page = out.addPage([595.28, 841.89])
        const scale = Math.min((595.28 - 40) / img.width, (841.89 - 40) / img.height, 1)
        page.drawImage(img, {
          x: (595.28 - img.width * scale) / 2,
          y: (841.89 - img.height * scale) / 2,
          width: img.width * scale,
          height: img.height * scale,
        })
      } else {
        throw new Error('不支持的格式')
      }
      fileCount++
    } catch (e) {
      skipped.push({ name: it.file.name, reason: (e && e.message) || String(e) })
    }
  }
  if (!fileCount) throw new Error('没有可合并的发票材料（支持 PDF 与图片）')
  const bytes = await out.save()
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    fileCount,
    pageCount: out.getPageCount(),
    skipped,
  }
}

/** 发票抬头检查：已检查张数与未含「东南大学」抬头的存疑清单 */
export function invoiceHeaderIssues() {
  const issues = []
  let checked = 0
  for (const leg of pkg.legs) {
    for (const f of leg.files) {
      const m = f.meta
      if (!m || !m.header || typeof m.header.ok !== 'boolean') continue
      checked++
      if (!m.header.ok) {
        const g = GROUPS.find((x) => x.id === leg.group)
        issues.push({ name: f.file.name, group: g ? g.name : '' })
      }
    }
  }
  return { issues, checked }
}

/** 尚未上传的必附材料（自定义材料项不参与必附检查） */
export function missingRequired() {
  const out = []
  for (const leg of pkg.legs) {
    for (const slot of slotsOf(leg.type)) {
      if (!slot.required) continue
      if (!leg.files.some((f) => f.slot === slot.id)) out.push({ leg, slot })
    }
  }
  return out
}

export function teamFolderName() {
  return sanitizeName(`${state.meta.contest || 'XCPC'}-${state.teamName || '未命名队'}-报销材料`)
}

/** 外部 ZIP 条目路径净化：防 zip-slip（剥掉 ../、绝对路径与反斜杠），只保留安全相对路径 */
export function safeRel(path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg))
    .join('/')
}

/**
 * 生成队伍材料包 ZIP（Blob）。
 * 目录结构：
 *   {赛站}-{队名}-报销材料/
 *     01-往返交通/01-飞机-去程 MU2801/01-机票发票-去程-张三.pdf …
 *     02-赛站住宿/01-住宿-林业宾馆/…
 *     队伍信息.txt、参赛同学清单.csv、核对报告.txt
 * （参赛费与差旅审批单不含在内：归赛站汇总负责人统一收取/填写）
 */
export async function buildTeamZipBlob() {
  if (!state.teamName.trim()) throw new Error('请先填写队名')
  const enc = new TextEncoder()
  const root = teamFolderName()
  const files = []
  const manifest = []

  GROUPS.forEach((g, gi) => {
    const legs = pkg.legs.filter((l) => l.group === g.id)
    if (!legs.length) return
    const gFolder = `${String(gi + 1).padStart(2, '0')}-${g.name}`
    legs.forEach((leg, li) => {
      if (!leg.files.length) return
      const slots = allSlotsOf(leg)
      // 按材料槽位顺序整理文件，再全局编号，保证清单顺序
      const ordered = []
      for (const s of slots) ordered.push(...leg.files.filter((f) => f.slot === s.id))
      ordered.push(...leg.files.filter((f) => !slots.some((s) => s.id === f.slot)))
      const fileNameOf = (f) => {
        const raw = slots.find((s) => s.id === f.slot)?.name || '其他材料'
        return sanitizeName(raw || '其他材料')
      }

      const legFolder = `${gFolder}/${String(li + 1).padStart(2, '0')}-${
        TYPE_META[leg.type].label
      }${leg.label ? '-' + sanitizeName(leg.label) : ''}`
      const fileLines = []
      ordered.forEach((f, i) => {
        const ext = (f.file.name.match(/\.[^.]+$/) || [''])[0]
        let fname = `${String(i + 1).padStart(2, '0')}-${fileNameOf(f)}`
        if (g.id === 'transport') fname += `-${scopeLabelOf(f.scope)}`
        const { all, names } = memberNamesOfIdx(f.members)
        if (!all && names.length) fname += `-${names.join('-')}`
        else if (!all) fname += '-队员未标注'
        files.push({ path: `${root}/${legFolder}/${fname}${ext}`, file: f.file })
        const amt = f.amount ? ` ¥${f.amount}` : ''
        fileLines.push(`${fname}${amt}`)
      })
      manifest.push(`  [${g.name}] ${leg.label || '—'}\n${fileLines.map((t) => `    ${t}`).join('\n')}`)
    })
  })

  // 读取全部文件内容
  for (const f of files) f.data = new Uint8Array(await f.file.arrayBuffer())

  // 队伍信息
  const memberLines = state.members.length
    ? state.members.map((m, i) => `  ${i + 1}. ${m.name} ${m.card}`).join('\n')
    : '  （未录入）'
  const info =
    `XCPC 队伍报销材料包
` +
    `队名：${state.teamName || '未命名队'}
` +
    `赛站：${state.meta.contest || '—'}
` +
    `报销负责人：${state.meta.leader || '—'}
` +
    `成员：
${memberLines}
` +
    (manifest.length ? `分段与材料：\n${manifest.join('\n')}\n` : '') +
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}
`
  files.push({ path: `${root}/队伍信息.txt`, data: enc.encode('﻿' + info) })

  // 配套材料
  if (state.members.length) {
    files.push({ path: `${root}/参赛同学清单.csv`, data: enc.encode(membersCSVString(state.members)) })
  }
  // 发票汇总文档：全部发票/凭证按顺序合并，便于整体扫描打印
  try {
    const inv = await buildInvoicesPdf()
    files.push({
      path: `${root}/发票汇总-扫描打印版.pdf`,
      data: new Uint8Array(await inv.blob.arrayBuffer()),
    })
  } catch {
    /* 无发票文件时跳过 */
  }
  // 金额不一致说明（通用要求：支付金额合计必须与发票金额一致）
  const mismatches = amountCheck().filter((a) => a.match === false)
  if (mismatches.length) {
    const L = ['支付金额与发票金额不一致情况说明', '']
    for (const mm of mismatches) {
      L.push(`【${mm.name}】`)
      L.push(`  发票金额合计：¥${mm.invSum.toFixed(2)}（${mm.invCount} 张发票）`)
      L.push(`  支付记录合计：¥${mm.paySum.toFixed(2)}（${mm.payCount} 笔支付）`)
      L.push(`  差额：¥${(Math.round((mm.invSum - mm.paySum) * 100) / 100).toFixed(2)}`)
      L.push('')
    }
    L.push('说明：以上差额需在报销前核实原因（如优惠券、退款、多人分摊等），必要时按财务要求补充说明或调整材料。')
    files.push({
      path: `${root}/支付不一致说明.txt`,
      data: enc.encode('\ufeff' + L.join('\n')),
    })
  }
  // 收付款方不一致：按官方模板生成情况说明书 docx（注意事项：开票盖章单位需与支付对象一致）
  const payIssues = payCheckIssues()
  if (payIssues.length) {
    const blob = await buildPayCheckDocxBlob(payIssues)
    files.push({
      path: `${root}/发票与银行卡支付信息不符情况说明书.docx`,
      data: new Uint8Array(await blob.arrayBuffer()),
    })
  }
  files.push({ path: `${root}/核对报告.txt`, data: enc.encode('﻿' + reportText()) })

  return makeZip(files.map((f) => ({ name: f.path, data: f.data })))
}


/** 收付款核对未通过的行程段（填了信息且未勾「核对一致」），用于生成官方模板的情况说明书 docx */
export function payCheckIssues() {
  const CONTENT_LABEL = { hotel: '住宿费', flight: '机票款', train: '火车票款', local: '交通费' }
  const out = []
  for (const g of GROUPS) {
    for (const leg of pkg.legs.filter((l) => l.group === g.id)) {
      const pc = leg.payCheck
      if (!pc || (!pc.issuer && !pc.payee) || pc.consistent) continue
      const invSlotIds = (TYPE_META[leg.type] || TYPE_META.entryfee).slots
        .filter((s) => /发票/.test(s.name))
        .map((s) => s.id)
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

/**
 * 生成赛站汇总 ZIP（Blob）。
 * @param {string} stationName 赛站名称
 * @param {Array<{file: File|Blob, team: string}>} items 各队伍 ZIP
 * @param {Array<{file: File, slot: string}>} entryFeeFiles 参赛费材料（负责人统一上传）
 */
export async function buildStationZipBlob(stationName, items, entryFeeFiles = []) {
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
      const ext = (fl.file.name.match(/\.[^.]+$/) || [''])[0]
      files.push({
        name: `${root}/00-参赛费/${String(++n).padStart(2, '0')}-${slotName}${ext}`,
        data: new Uint8Array(await fl.file.arrayBuffer()),
      })
    }
    summary.push(`- 参赛费材料：${n} 个文件（负责人统一收取）`)
  }

  // 差旅审批单（负责人填写，一次一行程）
  files.push({
    name: `${root}/差旅审批单.docx`,
    data: new Uint8Array(await buildApprovalDocxBlob().arrayBuffer()),
  })
  summary.push('- 差旅审批单：1 份（负责人填写）')
  summary.push(
    '',
    '说明：各队伍材料由《XCPC 报销材料整理工具》按队打包后汇总，材料明细见各队伍文件夹内的队伍信息.txt 与核对报告.txt。',
  )
  files.push({ name: `${root}/汇总说明.txt`, data: enc.encode('\ufeff' + summary.join('\n')) })
  return makeZip(files)
}
