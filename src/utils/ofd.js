/* OFD（GB/T 33190，zip + XML）处理：文字提取 + 按坐标渲染为绘图指令
   覆盖数电发票 / 行程单这类税务 OFD 的常用子集：
   模板层 + 正文层的 TextObject（Boundary/Size/TextCode X,Y,DeltaX）、
   ImageObject（ResourceID → Res 图片）、PathObject（M/L/C 直线表格框线）。 */
import { readZipEntries } from './unzip'

export async function extractOfdText(file) {
  const entries = await readZipEntries(file)
  let text = ''
  for (const e of entries) {
    if (!/\.xml$/i.test(e.name)) continue
    if (!/Content\.xml$/i.test(e.name) && !/Attachs\//i.test(e.name)) continue
    const xml = new TextDecoder('utf-8').decode(e.data)
    const re = /<(?:[\w-]+:)?TextCode[^>]*>([^<]*)</g
    let m
    while ((m = re.exec(xml))) text += m[1]
  }
  return text
}

/* ---------- 渲染（纯解析，无 DOM 依赖，浏览器 / Node 均可运行） ---------- */

const num = (v, d = 0) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : d
}
const attr = (s, name) => {
  const m = s && s.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : ''
}
const box = (s) => {
  const p = attr(s, 'Boundary').trim().split(/\s+/).map(Number)
  return { x: num(p[0]), y: num(p[1]), w: num(p[2]), h: num(p[3]) }
}

/** 解析一条 Content/Tpl XML 里的 Layer，产出绘图指令（坐标单位 mm，Y 轴向下） */
function parseLayers(xml, res) {
  const ops = []
  const layerRe = /<(?:[\w-]+:)?Layer\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Layer>/g
  let lm
  while ((lm = layerRe.exec(xml))) {
    const defaultDp = attr(lm[1], 'DrawParam')
    collectOps(lm[2], defaultDp, res, ops)
  }
  return ops
}

function collectOps(fragment, defaultDp, res, ops) {
  // PathObject：表格框线（Boundary 内的相对坐标 AbbreviatedData）
  const pathRe = /<(?:[\w-]+:)?PathObject\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?PathObject>/g
  let pm
  while ((pm = pathRe.exec(fragment))) {
    const b = box(pm[1])
    const dp = res.dp(attr(pm[1], 'DrawParam') || defaultDp)
    const ad = (pm[2].match(/<(?:[\w-]+:)?AbbreviatedData[^>]*>([\s\S]*?)</) || [])[1] || ''
    const cmds = []
    const tokenRe = /(M|L|C|B)\s*((?:[-\d.]+\s+[-\d.]+)(?:\s+[-\d.]+\s+[-\d.]+)*)/g
    let tm
    while ((tm = tokenRe.exec(ad.replace(/\n/g, ' ')))) {
      const pts = tm[2].trim().split(/\s+/).map(Number)
      const list = []
      for (let i = 0; i + 1 < pts.length; i += 2) list.push([pts[i], pts[i + 1]])
      cmds.push({ cmd: tm[1], list })
    }
    if (cmds.length) ops.push({ type: 'path', bx: b.x, by: b.y, cmds, stroke: dp.stroke, lineWidth: dp.lineWidth })
  }
  // TextObject：Boundary + Size + TextCode(X,Y 起点，DeltaX/DeltaY 逐字间距)
  const textRe = /<(?:[\w-]+:)?TextObject\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?TextObject>)/g
  let tm2
  while ((tm2 = textRe.exec(fragment))) {
    const b = box(tm2[1])
    const size = num(attr(tm2[1], 'Size'), 3)
    const font = res.font(attr(tm2[1], 'Font'))
    const dp = res.dp(attr(tm2[1], 'DrawParam') || defaultDp)
    const codeRe = /<(?:[\w-]+:)?TextCode\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?TextCode>)/g
    let cm
    while ((cm = codeRe.exec(tm2[2]))) {
      const text = (cm[2] || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      if (!text) continue
      const deltaX = attr(cm[1], 'DeltaX').trim() ? attr(cm[1], 'DeltaX').trim().split(/\s+/).map(Number) : null
      const deltaY = attr(cm[1], 'DeltaY').trim() ? attr(cm[1], 'DeltaY').trim().split(/\s+/).map(Number) : null
      ops.push({
        type: 'text',
        x: b.x + num(attr(cm[1], 'X')),
        y: b.y + num(attr(cm[1], 'Y'), size),
        text,
        size,
        font,
        color: dp.fill,
        deltaX,
        deltaY,
      })
    }
  }
  // ImageObject：ResourceID → MultiMedia → Res 里的图片字节
  const imgRe = /<(?:[\w-]+:)?ImageObject\b([^>]*?)\/?>/g
  let im
  while ((im = imgRe.exec(fragment))) {
    const b = box(im[1])
    if (!b.w && !b.h) continue
    const media = res.media(attr(im[1], 'ResourceID'))
    if (media) ops.push({ type: 'image', x: b.x, y: b.y, w: b.w, h: b.h, ...media })
  }
}

/**
 * 解析 OFD 为带坐标的绘图指令。
 * 返回 { widthMm, heightMm, pages: [{ ops }] }，ops 含
 * text {x,y,text,size,font,color,deltaX,deltaY} / path {bx,by,cmds,stroke,lineWidth} / image {x,y,w,h,bytes,mime}
 */
export async function renderOfd(file) {
  const entries = await readZipEntries(file)
  const find = (loc) => {
    const p = String(loc || '').replace(/^\//, '')
    return entries.find((e) => e.name === p || e.name.endsWith('/' + p) || e.name.endsWith(p))
  }
  const xmlOf = (loc) => {
    const e = find(loc)
    return e ? new TextDecoder('utf-8').decode(e.data) : ''
  }

  const docRoot = (xmlOf('OFD.xml').match(/DocRoot>\s*([^<\s]+)/) || [])[1] || '/Doc_0/Document.xml'
  const docDir = docRoot.replace(/[^/]+$/, '')
  const doc = xmlOf(docRoot)
  const phys = (doc.match(/PhysicalBox>\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/) || [])
  const widthMm = num(phys[3], 210)
  const heightMm = num(phys[4], 297)

  // 资源：DrawParam 颜色 / Font 字体 / MultiMedia 图片（都挂在 Doc_0 下）
  const resFiles = ['PublicRes', 'DocumentRes']
    .map((tag) => (doc.match(new RegExp(`${tag}>\\s*([^<\\s]+)`)) || [])[1])
    .filter(Boolean)
  const drawParams = {}
  const fonts = {}
  const medias = {}
  let mediaBase = 'Res'
  for (const rf of resFiles) {
    const xml = xmlOf(rf)
    if (!xml) continue
    const base = (xml.match(/BaseLoc="([^"]*)"/) || [])[1] || 'Res'
    for (const m of xml.matchAll(/<(?:[\w-]+:)?DrawParam\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?DrawParam>)/g)) {
      const id = attr(m[1], 'ID')
      const fill = (m[2].match(/FillColor\s+Value="([\d. ]+)"/) || [])[1]
      const stroke = (m[2].match(/StrokeColor\s+Value="([\d. ]+)"/) || [])[1]
      drawParams[id] = {
        fill: fill ? `rgb(${fill.trim().split(/\s+/).join(',')})` : null,
        stroke: stroke ? `rgb(${stroke.trim().split(/\s+/).join(',')})` : null,
        lineWidth: num(attr(m[1], 'LineWidth'), 0.25),
        relative: attr(m[1], 'Relative'),
      }
    }
    for (const f of xml.matchAll(/<(?:[\w-]+:)?Font\b([^>]*?)\/>/g)) fonts[attr(f[1], 'ID')] = attr(f[1], 'FontName') || attr(f[1], 'FamilyName')
    for (const mm of xml.matchAll(/<(?:[\w-]+:)?MultiMedia\b([^>]*?)>([\s\S]*?)<\/(?:[\w-]+:)?MultiMedia>/g)) {
      const fileLoc = ((mm[2].match(/MediaFile>\s*([^<\s]+)/) || [])[1] || '').replace(/^\//, '')
      const raw = find(`${base}/${fileLoc}`) || find(fileLoc)
      if (raw) {
        medias[attr(mm[1], 'ID')] = {
          bytes: raw.data,
          mime: /png/i.test(attr(mm[1], 'Format')) || /\.png$/i.test(fileLoc) ? 'image/png' : 'image/jpeg',
        }
      }
    }
  }
  const FONT_MAP = { 楷体: 'KaiTi', 宋体: 'SimSun', 黑体: 'SimHei', 仿宋: 'FangSong' }
  const res = {
    dp(id) {
      let cur = drawParams[id]
      const seen = new Set()
      while (cur && cur.relative && drawParams[cur.relative] && !seen.has(id)) {
        seen.add(id)
        const parent = drawParams[cur.relative]
        cur = { lineWidth: cur.lineWidth || parent.lineWidth, fill: cur.fill || parent.fill, stroke: cur.stroke || parent.stroke, relative: null }
      }
      return { fill: (cur && cur.fill) || 'rgb(0,0,0)', stroke: (cur && cur.stroke) || 'rgb(0,0,0)', lineWidth: (cur && cur.lineWidth) || 0.25 }
    },
    font(id) {
      const name = fonts[id] || '宋体'
      return FONT_MAP[name] || name
    },
    media(id) {
      return medias[id] || null
    },
  }

  // 模板层（背景）+ 各页正文
  const tplLoc = (doc.match(/TemplatePage[^>]*BaseLoc="([^"]+)"/) || [])[1]
  const tplZ = (doc.match(/TemplatePage[^>]*ZOrder="([^"]+)"/) || [])[1] || 'Background'
  const tplOps = tplLoc ? parseLayers(xmlOf(`${docDir}${tplLoc}`.replace('//', '/')), res) : []
  const pageRe = /<(?:[\w-]+:)?Page\b[^>]*BaseLoc="([^"]+)"/g
  const pages = []
  let pgm
  while ((pgm = pageRe.exec(doc))) {
    const pageOps = parseLayers(xmlOf(`${docDir}${pgm[1]}`.replace('//', '/')), res)
    pages.push({ ops: tplZ === 'Foreground' ? [...pageOps, ...tplOps] : [...tplOps, ...pageOps] })
  }
  if (!pages.length) pages.push({ ops: [...tplOps] })
  return { widthMm, heightMm, pages }
}

/**
 * 把一页 OFD 指令画到 canvas（浏览器用；自动按 mm 设定画布尺寸，DPI 默认 144）。
 * 返回实际缩放系数（px/mm）。图片 / 字体缺失时跳过对应元素。
 */
export async function paintOfdPage(canvas, page, widthMm, heightMm, dpi = 144) {
  const scale = dpi / 25.4
  canvas.width = Math.max(1, Math.round(widthMm * scale))
  canvas.height = Math.max(1, Math.round(heightMm * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'alphabetic'
  for (const op of page.ops) {
    if (op.type === 'image') {
      try {
        const bmp = await createImageBitmap(new Blob([op.bytes], { type: op.mime || 'image/jpeg' }))
        ctx.drawImage(bmp, op.x * scale, op.y * scale, op.w * scale, op.h * scale)
        bmp.close && bmp.close()
      } catch {
        /* 图片缺失跳过 */
      }
    } else if (op.type === 'path') {
      ctx.strokeStyle = op.stroke
      ctx.lineWidth = Math.max(0.5, op.lineWidth * scale)
      ctx.beginPath()
      for (const { cmd, list } of op.cmds) {
        const pt = (i) => [(op.bx + list[i][0]) * scale, (op.by + list[i][1]) * scale]
        if (cmd === 'M' && list[0]) ctx.moveTo(...pt(0))
        else if ((cmd === 'L' || cmd === 'M') && list[0]) ctx.lineTo(...pt(0))
        else if (cmd === 'C' && list.length >= 3) ctx.bezierCurveTo(...pt(0), ...pt(1), ...pt(2))
      }
      ctx.stroke()
    } else if (op.type === 'text') {
      ctx.fillStyle = op.color
      ctx.font = `${Math.max(1, op.size * scale)}px "${op.font}", SimSun, serif`
      let cx = op.x
      for (let i = 0; i < op.text.length; i++) {
        const ch = op.text[i]
        ctx.fillText(ch, cx * scale, op.y * scale)
        const adv =
          op.deltaX && op.deltaX[i] != null
            ? op.deltaX[i]
            : op.deltaY && op.deltaY[i] != null
              ? op.deltaY[i]
              : ctx.measureText(ch).width / scale
        cx += adv
      }
    }
  }
  return scale
}
