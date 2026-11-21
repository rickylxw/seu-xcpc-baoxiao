/* 负责人最后阶段工具（浏览器端）：抬头总检 + 赛站完整材料打印版 PDF 合成。
   抬头总检：解析各队 ZIP 内核对报告的「发票抬头检查」段落（队长端已含服务端识别 + 严格检查结果）。
   打印合成：每队优先取包内「材料汇总-全部材料扫描打印版.pdf」，其次「发票汇总-扫描打印版.pdf」；
   都没有就用包内原件现场合成（图片按 A4 排版 / PDF 无损拷页 / OFD 渲染为页图）；
   每队前插一页队名分隔页（canvas 画中文 → PNG），参赛费材料排最前。 */

import { PDFDocument } from 'pdf-lib'
import { readZipEntries } from './unzip.js'
import { renderOfd } from './ofd.js'

const A4 = { w: 595.28, h: 841.89 }

/** 从核对报告文本提取抬头检查信息：返回 { checked, issues }；报告缺失返回 null */
export function parseHeaderSection(text) {
  if (!text) return null
  // 单行式：发票抬头检查：已检查 N 张，[M 张未含「东南大学」抬头 ⚠ | 均为「东南大学」✓]
  const line = text.match(/发票抬头检查：已检查\s*(\d+)\s*张，(.*)/)
  if (line) {
    const checked = Number(line[1]) || 0
    const issues = /未含|⚠/.test(line[2]) ? [line[2].trim()] : []
    return { checked, issues }
  }
  // 段落式：## 发票抬头检查 之后的「已检查 N 张…」
  const sec = text.split(/#+\s*发票抬头检查/)[1]
  if (sec) {
    const m = sec.match(/已检查\s*(\d+)\s*张发票，(.*)/)
    if (m) {
      const issues = /⚠/.test(m[2]) ? [m[2].trim()] : []
      return { checked: Number(m[1]) || 0, issues }
    }
  }
  return null
}

/** 提取各队 ZIP 内的「报销系统填写对照单.txt」（负责人填报时页内直读，无需解压）。返回 [{ team, text, error }] */
export async function extractFillGuides(zips) {
  const out = []
  for (const z of zips) {
    try {
      const entries = await readZipEntries(z.file)
      const e = entries.find((en) => en.name.includes('报销系统填写对照单'))
      out.push({ team: z.team, text: e ? new TextDecoder('utf-8').decode(e.data) : null })
    } catch (err) {
      out.push({ team: z.team, text: null, error: String(err?.message || err).slice(0, 60) })
    }
  }
  return out
}

/** 抬头总检：扫各队 ZIP 的核对报告。返回 [{ team, hasReport, hasSection, checked, issues }] */export async function stationHeaderCheck(zips) {
  const out = []
  for (const z of zips) {
    try {
      const entries = await readZipEntries(z.file)
      const report = entries.find((e) => e.name.includes('核对报告.txt'))
      const parsed = report ? parseHeaderSection(new TextDecoder('utf-8').decode(report.data)) : null
      out.push({
        team: z.team,
        hasReport: !!report,
        hasSection: !!parsed,
        checked: parsed?.checked ?? null,
        issues: parsed?.issues || [],
      })
    } catch {
      out.push({ team: z.team, hasReport: false, hasSection: false, checked: null, issues: [], error: true })
    }
  }
  return out
}

/** 队名分隔页：canvas 画中文标题 → PNG → 嵌入 PDF */
async function dividerPage(out, title, sub) {
  const cv = document.createElement('canvas')
  cv.width = 1190
  cv.height = 1684 // A4 @144dpi
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.fillStyle = '#0f766e'
  ctx.fillRect(0, 620, cv.width, 10)
  ctx.fillStyle = '#111'
  ctx.font = 'bold 110px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(title.slice(0, 18), cv.width / 2, 520)
  ctx.font = '46px sans-serif'
  ctx.fillStyle = '#444'
  ctx.fillText(sub.slice(0, 40), cv.width / 2, 800)
  const png = cv.toDataURL('image/png')
  const bin = atob(png.split(',')[1])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const img = await out.embedPng(bytes)
  const page = out.addPage([A4.w, A4.h])
  page.drawImage(img, { x: 0, y: 0, width: A4.w, height: A4.h })
  return page
}

/** 单文件 → PDF 页（图片排 A4 / PDF 拷页 / OFD 渲染为页图）。返回 { added, note } */
async function appendFile(out, name, bytes) {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (/\.pdf$/i.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
    return { added: pages.length }
  }
  if (/\.ofd$/i.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    try {
      const ofd = await renderOfd(new Blob([bytes]))
      const imgOf = (dataUrl) => {
        const bin = atob(dataUrl.split(',')[1])
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        return arr
      }
      for (const dataUrl of await ofdPageImages(ofd)) {
        const img = await out.embedPng(imgOf(dataUrl))
        const page = out.addPage([A4.w, A4.h])
        // 横版行程单：按宽适配居中
        const scale = Math.min((A4.w - 24) / img.width, (A4.h - 24) / img.height)
        page.drawImage(img, { x: (A4.w - img.width * scale) / 2, y: (A4.h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale })
      }
      return { added: ofd.pages.length }
    } catch (e) {
      return { added: 0, note: 'OFD 渲染失败：' + String(e?.message || e).slice(0, 50) }
    }
  }
  if (isPng || isJpg) {
    const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes)
    const page = out.addPage([A4.w, A4.h])
    const scale = Math.min((A4.w - 40) / img.width, (A4.h - 40) / img.height, 1)
    page.drawImage(img, { x: (A4.w - img.width * scale) / 2, y: (A4.h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale })
    return { added: 1 }
  }
  return { added: 0, note: '不支持的类型' }
}

/** OFD → 页图 dataURL 列表（复用浏览器 paintOfdPage，dpi 144） */
async function ofdPageImages(ofd) {
  const { paintOfdPage } = await import('./ofd')
  const urls = []
  for (const p of ofd.pages) {
    const cv = document.createElement('canvas')
    await paintOfdPage(cv, p, ofd.widthMm, ofd.heightMm, 144)
    urls.push(cv.toDataURL('image/png'))
  }
  return urls
}

/**
 * 赛站完整材料打印版：参赛费材料 + 每队（分隔页 + 汇总 PDF 优先，缺则原件现场合成）。
 * 返回 { blob, pages, teams: [{team, pages, source}] , warnings }
 */
export async function buildStationPrintPdf(stationName, zips, efFiles = []) {
  const out = await PDFDocument.create()
  out.setTitle(`${stationName} 完整材料打印版`)
  const warnings = []
  const teams = []
  let total = 0

  // 00 参赛费材料（负责人统一收取，排最前）
  if (efFiles.length) {
    await dividerPage(out, '参赛费材料', `${stationName} · 负责人统一收取`)
    for (const ef of efFiles) {
      try {
        const buf = new Uint8Array(await ef.file.arrayBuffer())
        const r = await appendFile(out, ef.file.name, buf)
        total += r.added
        if (r.note) warnings.push(`参赛费 ${ef.file.name}：${r.note}`)
      } catch (e) {
        warnings.push(`参赛费 ${ef.file.name} 无法合成：${String(e?.message || e).slice(0, 60)}`)
      }
    }
  }

  for (const z of zips) {
    const teamName = z.team || '未命名队伍'
    let teamPages = 0
    let source = ''
    await dividerPage(out, teamName, `${stationName} · 报销材料`)
    try {
      const entries = await readZipEntries(z.file)
      // 优先级：材料汇总 > 发票汇总 > 原件现场合成
      const full = entries.find((e) => /材料汇总.*\.pdf$/i.test(e.name))
      const inv = entries.find((e) => /发票汇总.*\.pdf$/i.test(e.name))
      const chosen = full || inv
      if (chosen) {
        source = full ? '包内材料汇总 PDF' : '包内发票汇总 PDF'
        const src = await PDFDocument.load(chosen.data, { ignoreEncryption: true })
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach((p) => out.addPage(p))
        teamPages += pages.length
        if (!full && inv) warnings.push(`${teamName}：包内无「材料汇总」，用「发票汇总」代替（缺非发票材料页）`)
      } else {
        source = '原件现场合成'
        const skip = ['核对报告', '参赛同学清单', '发票汇总', '材料汇总', '对照单', '说明书']
        for (const e of entries) {
          if (skip.some((k) => e.name.includes(k))) continue
          if (e.data.length < 8) continue
          try {
            const r = await appendFile(out, e.name, e.data)
            teamPages += r.added
            if (r.note) warnings.push(`${teamName}/${e.name.split('/').pop()}：${r.note}`)
          } catch (err) {
            warnings.push(`${teamName}/${e.name.split('/').pop()} 无法合成：${String(err?.message || err).slice(0, 50)}`)
          }
        }
        warnings.push(`${teamName}：包内无汇总 PDF（队长用服务器/AI 流程打包才有），已从原件现场合成；建议让队长改用服务器流程重打包以获得更完整排版`)
      }
    } catch (e) {
      warnings.push(`${teamName} ZIP 读取失败：${String(e?.message || e).slice(0, 60)}`)
    }
    teams.push({ team: teamName, pages: teamPages, source })
    total += teamPages
  }

  const bytes = await out.save()
  return { blob: new Blob([bytes], { type: 'application/pdf' }), pages: out.getPageCount(), total, teams, warnings }
}
