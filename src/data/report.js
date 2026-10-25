/* 核对报告：打包状态 + 办理流程 + 待办事项（纯文本 / Markdown 导出） */
import { state, pkg, FLOW } from '../store'
import { GROUPS, TYPE_META, missingRequired, slotsOf, memberCoverage, coverageGaps, scopeLabelOf, memberNamesOfIdx, invoiceHeaderIssues, cabinIssues, amountCheck } from './packaging'
import { fmtDateCN } from '../utils/misc'

export function deadlineText() {
  if (!state.meta.dateReturn) return '填写「返宁日期」后自动计算'
  const d = new Date(state.meta.dateReturn + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return `${fmtDateCN(d)}晚上前（返宁后 1 天内）`
}

export function reportTodos() {
  const todos = []
  if (!state.teamName.trim()) todos.push('尚未填写队名（「材料打包」页）')
  const gName = (id) => (GROUPS.find((g) => g.id === id) || {}).name || ''
  for (const m of missingRequired()) {
    todos.push(`「${gName(m.leg.group)}·${TYPE_META[m.leg.type].label}」缺必附材料：${m.slot.name}`)
  }
  for (const g of coverageGaps()) {
    todos.push(`「${g.name}」材料归属不完整：缺${g.miss.join('、')}`)
  }
  const hdr = invoiceHeaderIssues()
  for (const x of hdr.issues) {
    todos.push(`发票「${x.name}」（${x.group}）未识别到「东南大学」抬头，请人工核对，错误抬头无法报销`)
  }
  for (const a of amountCheck()) {
    if (a.match === false) {
      todos.push(
        `「${a.name}」支付金额合计 ¥${a.paySum.toFixed(2)} 与发票合计 ¥${a.invSum.toFixed(2)} 不一致，请核实原因或补充说明`,
      )
    }
  }
  if (!state.members.length) {
    todos.push('参赛同学清单（一卡通号＋姓名）尚未录入，「同学清单」页可生成')
  }
  if (!state.approval.done) {
    todos.push('差旅审批单待负责人填写：「差旅审批单」页核对内容并下载/打印（随赛站汇总包提交；勾选「负责人已填写/核对完成」后不再提醒）')
  }
  state.flow.forEach((f, i) => {
    if (!f) todos.push(FLOW[i].t)
  })
  return todos
}

/** 各分组的行程段与材料明细行（每个文件含金额、适用范围与归属队员） */
export function packageLines() {
  const L = []
  for (const g of GROUPS) {
    const legs = pkg.legs.filter((l) => l.group === g.id)
    if (!legs.length) {
      L.push(`[${g.name}]（未添加行程段）`)
      continue
    }
    legs.forEach((leg, li) => {
      const slots = slotsOf(leg.type)
      const ordered = []
      for (const s of slots) ordered.push(...leg.files.filter((f) => f.slot === s.id))
      ordered.push(...leg.files.filter((f) => !slots.some((s) => s.id === f.slot)))
      L.push(
        `  ${li + 1}. [${TYPE_META[leg.type].label}] ${leg.label || '—'}`,
      )
      const miss = slots.filter((s) => s.required && !leg.files.some((f) => f.slot === s.id)).map((s) => s.name)
      if (miss.length) L.push(`     缺必附：${miss.join('、')}`)
      ordered.forEach((f, fi) => {
        const members = memberNamesOfIdx(f.members)
        const mStr = members.all ? '全员' : members.names.join('、') || '未标注'
        const scope = g.id === 'transport' ? `（${scopeLabelOf(f.scope)}）` : ''
        const amt = f.amount ? ` ¥${f.amount}` : ''
        L.push(`     ${String(fi + 1).padStart(2, '0')} ${f.file.name}${scope}${amt} → ${mStr}`)
      })
    })
  }
  return L
}

/** 队员归属检查行：张三：去程✓ 返程✓ 住宿发票✗ */
export function coverageLines() {
  if (!state.members.length) return []
  return memberCoverage().map(
    (c) =>
      `  ${c.name}：去程${c.outbound ? '✓' : '✗'}　返程${c.back ? '✓' : '✗'}　住宿发票${c.invoice ? '✓' : '✗'}`,
  )
}

function memberLines() {
  if (!state.members.length) return ['  （未录入）']
  return state.members.map((m, i) => `  ${i + 1}. ${m.name} ${m.card}`)
}

export function msgTemplates() {
  const c = state.meta.contest || 'ICPC 南京站'
  return [
    `【到达通知】${c}：我队已到达并完成报到。`,
    `【报销完成】${c} 报销已完成，款项已收到，已转给大家，请查收。`,
  ]
}

/** 从核对报告文本中解析【四、待办事项】清单（用于赛站汇总时读取各队 ZIP 内的报告） */
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

const TIPS = [
  '发票抬头必须为「东南大学」，税务识别号：12100000466006770Q。',
  '报销等级：飞机仅限经济舱；高铁仅限二等座。',
  '各类报销均有时效性，材料提交不及时、不完整或错误将不能报销。',
  '参赛费材料由赛站汇总负责人统一收取打包，队伍包中不含参赛费。',
  '本报告由《XCPC 报销材料整理工具》生成，依据《2026 年 CPC 参赛注意事项》（东南大学）。',
]

export function reportText() {
  const todos = reportTodos()
  const L = []
  L.push('XCPC 报销材料核对报告')
  L.push(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  L.push('')
  L.push('【一、基本信息】')
  L.push(`比赛名称：${state.meta.contest || '—'}`)
  L.push(`比赛日期：${state.meta.dateContest || '—'}`)
  L.push(`返宁日期：${state.meta.dateReturn || '—'}`)
  L.push(`建议提交时间：${deadlineText()}`)
  L.push(`报销负责人：${state.meta.leader || '—'}`)
  L.push(`队名：${state.teamName || '—'}`)
  L.push('成员：')
  L.push(...memberLines())
  L.push('')
  L.push('【二、材料打包明细】')
  L.push(...packageLines())
  const cov = coverageLines()
  if (cov.length) {
    L.push('队员归属检查（去程/返程/住宿发票）：')
    L.push(...cov)
  }
  const hdr = invoiceHeaderIssues()
  L.push('')
  L.push(
    hdr.checked
      ? `发票抬头检查：已检查 ${hdr.checked} 张，${hdr.issues.length ? hdr.issues.length + ' 张未含「东南大学」抬头 ⚠' : '均为「东南大学」✓'}`
      : '发票抬头检查：（无已识别的发票）',
  )
  hdr.issues.forEach((x) => L.push(`  ⚠ ${x.name}（${x.group}）`))
  const cab = cabinIssues()
  L.push(
    cab.checked
      ? `机票舱位检查：已检查 ${cab.checked} 张，${cab.issues.length ? cab.issues.length + ' 张未含「经济舱」字样 ⚠' : '均含「经济舱」✓'}`
      : '机票舱位检查：（无已识别的机票材料）',
  )
  cab.issues.forEach((x) => L.push(`  ⚠ ${x.name}（${x.group}）`))
  for (const a of amountCheck()) {
    const con = a.match === true ? '一致 ✓' : a.match === false ? '不一致 ⚠' : '金额待填写'
    L.push(
      `  [${a.name}] 发票 ${a.invCount} 张合计 ¥${a.invSum.toFixed(2)}，支付 ${a.payCount} 笔合计 ¥${a.paySum.toFixed(2)} —— ${con}`,
    )
  }
  L.push('')
  L.push('【三、办理流程】')
  FLOW.forEach((f, i) => L.push(`${state.flow[i] ? '[已完成]' : '[未完成]'} ${f.t}`))
  L.push('')
  if (todos.length) {
    L.push(`【四、待办事项（共 ${todos.length} 项）】`)
    todos.forEach((t, i) => L.push(`${i + 1}. ${t}`))
  } else {
    L.push('【四、待办事项】全部完成 ✓')
  }
  L.push('')
  L.push('【提示】')
  L.push(...TIPS)
  return L.join('\n')
}

export function reportMarkdown() {
  const todos = reportTodos()
  const L = []
  L.push('# XCPC 报销材料核对报告', '')
  L.push(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, '')
  L.push('## 一、基本信息', '')
  L.push(`- 比赛名称：${state.meta.contest || '—'}`)
  L.push(`- 比赛日期：${state.meta.dateContest || '—'}`)
  L.push(`- 返宁日期：${state.meta.dateReturn || '—'}`)
  L.push(`- 建议提交时间：${deadlineText()}`)
  L.push(`- 报销负责人：${state.meta.leader || '—'}`)
  L.push(`- 队名：${state.teamName || '—'}`)
  L.push('- 成员：')
  for (const m of state.members) L.push(`  - ${m.name} ${m.card}`)
  if (!state.members.length) L.push('  - （未录入）')
  L.push('')
  L.push('## 二、材料打包明细', '')
  L.push('```')
  L.push(...packageLines())
  L.push(...coverageLines())
  L.push('```', '')
  L.push(
    '## 发票抬头检查',
    '',
    (() => {
      const h = invoiceHeaderIssues()
      return h.checked
        ? `已检查 ${h.checked} 张发票，${h.issues.length ? h.issues.length + ' 张未含「东南大学」抬头 ⚠' : '均为「东南大学」✓'}`
        : '（无已识别的发票）'
    })(),
    '',
    '## 机票舱位检查',
    '',
    (() => {
      const c = cabinIssues()
      return c.checked
        ? `已检查 ${c.checked} 张，${c.issues.length ? c.issues.length + ' 张未含「经济舱」字样 ⚠' : '均含「经济舱」✓'}`
        : '（无已识别的机票材料）'
    })(),
    '',
    '## 三、办理流程',
    '',
  )
  FLOW.forEach((f, i) => L.push(`- [${state.flow[i] ? 'x' : ' '}] ${f.t}`))
  L.push('')
  L.push('## 四、待办事项', '')
  if (todos.length) todos.forEach((t, i) => L.push(`${i + 1}. ${t}`))
  else L.push('全部完成 ✓')
  L.push('')
  L.push('## 提示', '')
  L.push(...TIPS.map((t) => `- ${t}`))
  return L.join('\n')
}
