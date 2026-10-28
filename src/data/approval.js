/* 差旅审批单（东南大学公务出差财务核算审批单）：数据组装 + .docx 导出 */
import { state } from '../store'
import { makeZip } from '../utils/zip'

export const PERSON_TYPES = ['校内人员', '邀请专家', '主持或参与项目研究的校外人员']

/* 选项编号 ①②③ 齐全（用户确认原模板带圈1），勾选框放在文字后面 */
export const HOTEL_OPTIONS = [
  { v: 'standard', t: '①按标准限额据实报销' },
  { v: 'over', t: '②超标准自理金额：' },
]

export const MEAL_OPTIONS = [
  { v: 'none', t: '①不领取补贴' },
  { v: 'package', t: '②按包干标准直接领取' },
]

export const CITY_OPTIONS = [
  { v: 'none', t: '①不领取补贴' },
  { v: 'package', t: '②按包干标准领取' },
  { v: 'actual', t: '③按规定据实报销' },
]

export function todayCN() {
  const d = new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

function fmtDotted(iso) {
  const [y, m, d] = iso.split('-')
  return `${y}．${Number(m)}.${Number(d)}`
}

/** 出差起讫日期，如「2026．10.24-10.26」（跨年则两端带年份） */
export function tripRange() {
  const { dateContest, dateReturn } = state.meta
  if (!dateContest && !dateReturn) return ''
  if (dateContest && dateReturn) {
    if (dateContest.slice(0, 4) === dateReturn.slice(0, 4)) {
      const [, m, d] = dateReturn.split('-')
      return `${fmtDotted(dateContest)}-${Number(m)}.${Number(d)}`
    }
    return `${fmtDotted(dateContest)}-${fmtDotted(dateReturn)}`
  }
  return fmtDotted(dateContest || dateReturn)
}

function rideList() {
  const a = state.approval
  const L = []
  if (a.trainRide) L.push('高铁二等座')
  if (a.flightRide) L.push('飞机经济舱')
  const other = (a.otherRide || '').trim()
  if (other) L.push(other)
  return L
}

export function optText(options, val) {
  // 勾选框在文字后面，如「①按标准限额据实报销☑」
  return options
    .map((o) => {
      const on = val === o.v
      if (o.v === 'over') {
        return `${o.t}${on ? state.approval.hotelOver || '＿＿＿＿' : ''}${on ? '☑' : '□'}`
      }
      return `${o.t}${on ? '☑' : '□'}`
    })
    .join('　　')
}

/** 组装审批单展示数据（页面预览与 docx 导出共用） */
export function approvalView() {
  const a = state.approval
  return {
    fillDate: a.fillDate || todayCN(),
    members: state.members,
    personType: a.personType,
    range: tripRange(),
    reason: a.reason || (state.meta.contest ? `参加${state.meta.contest}` : ''),
    place: a.place,
    unit: a.unit,
    funding: a.funding || '【填写报销文档前与我联系，到时候发送给大家】',
    rank: a.rank || '学生',
    rideOkText: a.rideOk ? '①是☑　②否□' : '①是□　②否☑',
    rides: rideList(),
    hotelText: optText(HOTEL_OPTIONS, a.hotelOption),
    mealText: optText(MEAL_OPTIONS, a.mealOption),
    cityText: optText(CITY_OPTIONS, a.cityOption),
    note: a.note,
  }
}

export const FOOTNOTES = [
  '如出差人为多人且乘坐交通工具类型、等级、住宿费、伙食补助费、市内交通费报销选择有差异的请分别造表填报；请在相应选项后的□内打√或在备注中说明。',
  '公务接待的餐费报销按照公务接待的相关规定办理，异地公务接待的餐费、公务用车费报销和差旅费一并办理报销。',
  '公务出差租车的，按照《东南大学公务用车费核算管理办法（暂行）》办理，由单位负责人在《东南大学公务出差财务核算审批单》上单独审签，公务出差为租车前往的，不得领取交通补助费。',
  '经相关负责人批准的《东南大学公务出差财务核算审批单》是差旅费财务报销的依据之一。公务出差审批需一事一批、一事一结。',
]

/* ---------- 最小 .docx（Office Open XML）生成 ---------- */
/* 版式逐项对齐原《东南大学公务出差财务核算审批单》模板：
   全篇仿宋、正文 14pt（sz 28）、标题 16pt 加粗下划线、说明 10.5pt 加粗；
   所有段落固定行距 20pt（line=400 exact，说明 15pt）；
   表格总宽 9180 twips 居中，列宽 2057/2545/1775/2803；
   「出差事由」「是否符合规定的乘坐等级」纵向合并跨两行；
   页边距 720 twips（1.27cm）。 */

const escXml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

// 原模板含数字/西文也用仿宋（ascii/hAnsi 一并设置）
const FONT = '<w:rFonts w:ascii="仿宋" w:hAnsi="仿宋" w:eastAsia="仿宋" w:cs="仿宋"/>'

function run(text, { b = false, sz = 28, u = false } = {}) {
  const rPr = `${FONT}${b ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>${u ? '<w:u w:val="single"/>' : ''}`
  return text ? `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escXml(text)}</w:t></w:r>` : ''
}

function para(text, { b = false, sz = 28, u = false, center = false, line = 400 } = {}) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:lineRule="exact" w:line="${line}"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text, { b, sz, u })}</w:p>`
}

const paras = (lines, opts) => lines.map((t) => para(t, opts)).join('')

const COLW = [2057, 2545, 1775, 2803] // 与原模板一致
const TBLW = 9180
const SPANW = COLW[1] + COLW[2] + COLW[3]

function cell(lines, width, { span = 1, vmerge = '', valign = '', b = false, center = false } = {}) {
  const tcPr =
    `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
    (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') +
    (vmerge === 'restart' ? '<w:vMerge w:val="restart"/>' : vmerge === 'cont' ? '<w:vMerge/>' : '') +
    (valign ? `<w:vAlign w:val="${valign}"/>` : '') +
    '</w:tcPr>'
  return `<w:tc>${tcPr}${paras(lines.length ? lines : [''], { b, center })}</w:tc>`
}

function row(cells, { height = 0 } = {}) {
  return `<w:tr>${height ? `<w:trPr><w:trHeight w:val="${height}" w:hRule="atLeast"/></w:trPr>` : ''}${cells.join('')}</w:tr>`
}

/** 生成标准 .docx（zip 容器 + WordprocessingML），返回 Blob */
export function buildApprovalDocxBlob() {
  const v = approvalView()
  const [w0, w1, w2, w3] = COLW
  const memberLines = v.members.map((m) => `${m.card} ${m.name}`)
  const typeLines = PERSON_TYPES.map((t) => `${v.personType === t ? '☑' : '□'}${t}`) // 模板：勾选框在文字前
  const rides = v.rides
  const opinion = `意见：${'　'.repeat(9)}签名：`

  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
    .join('')

  const table =
    `<w:tbl><w:tblPr><w:tblW w:w="${TBLW}" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:start w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:end w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${COLW.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    row(
      [cell(['出差人姓名'], w0, { valign: 'center' }), cell(memberLines, w1), cell(['出差人类型'], w2, { valign: 'center' }), cell(typeLines, w3)],
      { height: 1224 },
    ) +
    row(
      [
        cell(['出差起讫日期'], w0),
        cell([v.range], w1),
        cell(['出差事由'], w2, { vmerge: 'restart', valign: 'center' }),
        cell([v.reason], w3, { vmerge: 'restart' }),
      ],
      { height: 544 },
    ) +
    row(
      [
        cell(['所到省份、城市'], w0),
        cell([v.place], w1),
        cell([''], w2, { vmerge: 'cont', valign: 'center' }),
        cell([''], w3, { vmerge: 'cont' }),
      ],
      { height: 606 },
    ) +
    row([cell(['所到单位'], w0), cell([v.unit], w1), cell(['项目经费'], w2), cell([v.funding], w3)], { height: 513 }) +
    row([
      cell(['出差人职务/职称级别'], w0),
      cell([v.rank], w1),
      cell(['是否符合规定的乘坐等级'], w2, { vmerge: 'restart', valign: 'center' }),
      cell([v.rideOkText], w3, { vmerge: 'restart', valign: 'center', center: true }),
    ]) +
    row([
      cell(['乘坐的交通工具及等级'], w0),
      cell(rides.length ? rides : [''], w1),
      cell([''], w2, { vmerge: 'cont' }),
      cell([''], w3, { vmerge: 'cont' }),
    ]) +
    row([cell(['住宿费'], w0), cell([v.hotelText], SPANW, { span: 3 })]) +
    row([cell(['伙食补助费'], w0), cell([v.mealText], SPANW, { span: 3 })]) +
    row([cell(['市内交通费'], w0), cell([v.cityText], SPANW, { span: 3 })]) +
    row([cell(['项目负责人审核意见'], w0), cell([opinion], SPANW, { span: 3, valign: 'center' })], { height: 562 }) +
    row([cell(['特殊事项备注'], w0), cell([v.note], SPANW, { span: 3 })], { height: 436 }) +
    row([cell(['公务出差租车（自驾车）的审批：'], TBLW, { span: 4, b: true })]) +
    row([cell(['单位负责人审批意见'], w0), cell([opinion], SPANW, { span: 3, valign: 'center' })], { height: 458 }) +
    '</w:tbl>'

  const body =
    para('东南大学公务出差财务核算审批单', { b: true, sz: 32, u: true, center: true }) +
    para(v.fillDate, { center: true }) +
    para('单位（公章）：') +
    table +
    para(`说明：1. ${FOOTNOTES[0]}`, { b: true, sz: 21, line: 300 }) +
    FOOTNOTES.slice(1)
      .map((t, i) => para(`　${i + 2}. ${t}`, { b: true, sz: 21, line: 300 }))
      .join('')

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  const enc = new TextEncoder()
  return makeZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(documentXml) },
  ])
}

/**
 * 按《发票与银行卡支付信息不符情况说明书》官方模板生成说明 docx。
 * items: [{ name, contentLabel, invSum, issuer, payee, note }]（每个行程段一笔）
 * 版式对齐模板：标题 / 发票信息四行 / 不符事项勾选（此处勾「商户名称不符」）/ 承诺与签字栏。
 */
export function buildPayCheckDocxBlob(items) {
  const paraRight = (text, opts = {}) =>
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:lineRule="exact" w:line="360"/><w:jc w:val="right"/></w:pPr>${run(text, opts)}</w:p>`

  let body = para('发票与银行卡支付信息不符情况说明书', { b: true, sz: 32, center: true })
  body += para('')
  for (const it of items) {
    body += para('发票信息', { b: true })
    body += para('发票开具时间：        年      月      日')
    body += para('发票号码：')
    body += para(`发票内容：${it.contentLabel || '＿＿＿＿'}`)
    body += para(`发票金额：${it.invSum != null ? it.invSum.toFixed(2) + ' 元' : '＿＿＿＿＿＿'}`)
    body += para('不符事项及说明', { b: true })
    body += para('☑ 商户名称不符')
    body += para(
      `发票单位名称为：${it.issuer} ，该笔费用银行卡支付单位为：${it.payee} ，不符原因为：${it.note || '（未填写）'} 。`,
    )
    body += para('□ 金额不符')
    body += para(
      '发票金额为：______元，该笔费用银行卡支付金额为：_______元 ，其中_________元用于本笔费用，差额原因为: _____________________________________________________ 。',
    )
    body += para('')
  }
  body += para('    本人承诺此次经济行为事项真实，以上说明情况属实，如有不实，愿承担与此相关的一切责任。')
  body += para('')
  body += paraRight('银行卡持卡人签字：')
  body += paraRight('        年      月      日')
  body += para('')
  body += para('')
  body += paraRight('项目负责人审批（签字、盖章）：')

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  const enc = new TextEncoder()
  return makeZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'word/document.xml', data: enc.encode(documentXml) },
  ])
}
