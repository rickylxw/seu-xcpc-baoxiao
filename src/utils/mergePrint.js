/* 合并打印：按清单顺序把全部材料合并为一个大 PDF（图片排 A4 页、PDF 无损合并页面） */
import { state, pkg } from '../store'
import { GROUPS, TYPE_META, allSlotsOf, slotNameOf, scopeLabelOf } from '../data/packaging'
import { extractOfdTextItems } from './pdfText'
import { PDFDocument } from 'pdf-lib'

const isPdf = (name) => /\.pdf$/i.test(name)
const isOfd = (name) => /\.ofd$/i.test(name)
const isPng = (name) => /\.png$/i.test(name)
const isJpg = (name) => /\.jpe?g$/i.test(name)

const A4 = { w: 595.28, h: 841.89 }

function fileToDataUrlPng(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d').drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/png'))
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

async function embedImage(out, file) {
  const buf = await file.arrayBuffer()
  const head = new Uint8Array(buf, 0, Math.min(12, buf.byteLength))
  // 按文件头嗅探真实格式（扩展名常不可信，如 .png 实为 JPEG）
  if (head[0] === 0x89 && head[1] === 0x50) return out.embedPng(new Uint8Array(buf))
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return out.embedJpg(new Uint8Array(buf))
  const dataUrl = await fileToDataUrlPng(file)
  return out.embedPng(dataUrl)
}

export function mergeHeader() {
  return {
    title: `${state.meta.contest || 'XCPC'} · ${state.teamName || '未命名队'} 报销材料`,
    contest: state.meta.contest || '—',
    team: state.teamName || '未命名队',
    leader: state.meta.leader || '—',
    members: state.members.map((m) => `${m.name} ${m.card}`),
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
  }
}

/**
 * 按分组 → 段 → 材料顺序，把全部文件合并成一个 PDF。
 * - PDF 材料：页面原样无损拷贝（矢量与清晰度保留）
 * - 图片材料：等比例排版到 A4 页
 * - 浏览器内无法解析的文件（如 .docx、加密 PDF）跳过并记录在 skipped
 * 返回 { blob, fileCount, pageCount, manifest, skipped }
 */
export async function buildMergedPdf() {
  const out = await PDFDocument.create()
  out.setTitle(`${state.meta.contest || 'XCPC'} 报销材料（${state.teamName || '未命名队'}）`)
  const manifest = []
  const skipped = []
  let fileCount = 0

  for (const g of GROUPS) {
    const legs = pkg.legs.filter((l) => l.group === g.id && l.files.length)
    if (!legs.length) continue
    for (const [li, leg] of legs.entries()) {
      const slots = allSlotsOf(leg)
      const ordered = []
      for (const s of slots) ordered.push(...leg.files.filter((f) => f.slot === s.id))
      ordered.push(...leg.files.filter((f) => !slots.some((s) => s.id === f.slot)))
      const legTitle =
        `${String(li + 1).padStart(2, '0')} ${TYPE_META[leg.type].label}` +
        (leg.label ? ` · ${leg.label}` : '')

      for (const [fi, f] of ordered.entries()) {
        const scope = g.id === 'transport' ? `（${scopeLabelOf(f.scope)}）` : ''
        const amt = f.amount ? ` ¥${f.amount}` : ''
        const label = `${String(fi + 1).padStart(2, '0')} ${slotNameOf(leg, f.slot)}（${f.file.name}）${scope}${amt}`
        fileCount++
        try {
          let pages
          if (isOfd(f.file.name)) {
            // OFD：提取文字层，重绘为文字参考页（非原件版式；原件请用开票平台下载的 PDF 打印）
            const items = await extractOfdTextItems(f.file)
            if (!items.length) throw new Error('OFD 内未提取到文字')
            const cv = document.createElement('canvas')
            cv.width = 1191
            cv.height = 1684 // A4 @144dpi
            const ctx = cv.getContext('2d')
            ctx.fillStyle = '#fff'
            ctx.fillRect(0, 0, cv.width, cv.height)
            ctx.fillStyle = '#1c2b2a'
            ctx.font = '22px SimSun, serif'
            let y = 80
            for (const it of items) {
              const maxW = cv.width - 160
              let line = ''
              for (const ch of it) {
                if (ctx.measureText(line + ch).width > maxW) {
                  ctx.fillText(line, 80, y)
                  y += 34
                  line = ch
                } else line += ch
              }
              ctx.fillText(line, 80, y)
              y += 40
            }
            const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
            const img = await out.embedPng(await blob.arrayBuffer())
            const page = out.addPage([595.28, 841.89])
            page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 })
            pages = [page]
          } else if (isPdf(f.file.name)) {
            const src = await PDFDocument.load(await f.file.arrayBuffer(), { ignoreEncryption: true })
            pages = await out.copyPages(src, src.getPageIndices())
            pages.forEach((p) => out.addPage(p))
          } else {
            const img = await embedImage(out, f.file)
            const page = out.addPage([A4.w, A4.h])
            const scale = Math.min((A4.w - 40) / img.width, (A4.h - 40) / img.height, 1)
            const w = img.width * scale
            const h = img.height * scale
            page.drawImage(img, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h })
            pages = [page]
          }
          manifest.push({ group: g.name, legTitle, label, pages: pages.length, file: f.file })
        } catch (e) {
          skipped.push({ label, reason: (e && e.message) || '解析失败' })
        }
      }
    }
  }

  if (!out.getPageCount()) throw new Error('没有可合并的材料（支持的格式：PDF、PNG、JPG 等图片）')
  const bytes = await out.save()
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    fileCount,
    pageCount: out.getPageCount(),
    manifest,
    skipped,
  }
}
