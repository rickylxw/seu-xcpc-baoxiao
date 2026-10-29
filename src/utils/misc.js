/* 通用小工具：金额、日期、剪贴板、下载 */

export function parseAmt(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

export function round2(n) {
  return Math.round(n * 100) / 100
}

export function fmtAmt(n) {
  return n == null ? '—' : '¥' + n.toFixed(2)
}

export function fmtDateCN(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日（周${'日一二三四五六'[d.getDay()]}）`
}

/** Windows 文件名非法字符清理 */
export function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '-').trim() || '报销材料'
}

export async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t)
      return
    }
  } catch {
    /* 降级到 execCommand */
  }
  const ta = document.createElement('textarea')
  ta.value = t
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } catch {
    /* 忽略 */
  }
  ta.remove()
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
}

/** 参赛同学清单：CSV（带 BOM，Excel 直接打开不乱码）；防公式注入（= + - @ 开头加 ' 前缀） */
export function membersCSVString(members) {
  const guard = (c) => {
    const s = String(c ?? '')
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s
  }
  const rows = [['姓名', '一卡通号'], ...members.map((m) => [guard(m.name), guard(m.card)])]
  return (
    '\ufeff' +
    rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  )
}

export function membersText(members) {
  return ['姓名\t一卡通号', ...members.map((m) => `${m.name || '—'}\t${m.card || '—'}`)].join('\n')
}

/** 常见图片扩展名（决定文件名是否可点击预览；浏览器按内容嗅探渲染，扩展名误标无碍） */
export function isImageName(n) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(n || '')
}

/** 解析队伍 ZIP 内的「参赛同学清单.csv」（membersCSVString 生成的格式），返回 [{ name, card }] */
export function parseMembersCSV(text) {
  const clean = String(text || '').replace(/^\ufeff/, '')
  const rows = clean.split(/\r?\n/).filter((r) => r.trim())
  const out = []
  for (const row of rows.slice(1)) {
    // 首行是表头；单元格带引号包裹，个别卡号有防公式前缀 '
    const cells = row.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/^'/, '').trim())
    const name = cells[0] || ''
    const card = cells[1] || ''
    if (name && name !== '姓名') out.push({ name, card })
  }
  return out
}
