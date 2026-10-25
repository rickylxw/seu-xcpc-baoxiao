/* ZIP 解包：支持 store 与 deflate 两种压缩方式，文件名自动识别 UTF-8 / GBK */

const decUtf8 = new TextDecoder('utf-8')
let decGbk = null
function gbkDecoder() {
  try {
    decGbk = decGbk || new TextDecoder('gb18030')
    return decGbk
  } catch {
    return decUtf8
  }
}

/** 单条目解压上限（防解压炸弹）：256MB */
const MAX_INFLATED = 256 * 1024 * 1024

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw')
  const reader = new Blob([u8]).stream().pipeThrough(ds).getReader()
  const chunks = []
  let total = 0
  let over = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_INFLATED) over = true
    else if (!over) chunks.push(value)
    // 超限后继续读完并丢弃：输入字节有限，干净收尾避免中途取消流引发的上游错误
  }
  if (over) throw new Error('ZIP 条目解压后超过 256MB，疑似解压炸弹，已中止')
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * 解析 ZIP 文件（File / Blob），返回 [{ name, data: Uint8Array }]。
 * 跳过目录条目；只读取中央目录里登记的文件。
 */
export async function readZipEntries(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  if (buf.length < 22) throw new Error('文件太小，不是有效的 ZIP')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // 从尾部向前找 EOCD（0x06054b50）
  let eocd = -1
  const scanFrom = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到目录）')

  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)

  const entries = []
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 目录损坏')
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const cmtLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const nameBytes = buf.slice(p + 46, p + 46 + nameLen)
    const name = flags & 0x0800 ? decUtf8.decode(nameBytes) : gbkDecoder().decode(nameBytes)
    p += 46 + nameLen + extraLen + cmtLen

    if (name.endsWith('/')) continue

    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`ZIP 条目损坏：${name}`)
    const lnLen = dv.getUint16(localOffset + 26, true)
    const leLen = dv.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lnLen + leLen
    const raw = buf.slice(dataStart, dataStart + compSize)

    let data
    if (method === 0) data = raw
    else if (method === 8) data = await inflateRaw(raw)
    else throw new Error(`暂不支持的 ZIP 压缩方式（${name}），请重新用本工具打包`)
    entries.push({ name, data })
  }
  return entries
}

/** 取所有条目的公共顶层目录（最多一个），如「ICPC-XX队-报销材料/」，用于解包时剥掉 */
export function commonRoot(names) {
  if (!names.length) return ''
  const first = new Set(names.map((n) => n.split('/')[0]))
  if (first.size !== 1) return ''
  const root = [...first][0]
  return names.some((n) => n.includes('/')) ? root + '/' : ''
}
