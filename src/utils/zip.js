/* 极简 ZIP 打包器（仅存储、不压缩），支持中文文件名（UTF-8 标志位）。 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(u8) {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

/**
 * files: [{ name: string（使用 / 作为目录分隔符）, data: Uint8Array }]
 * 返回 Blob（application/zip）
 */
export function makeZip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  const now = dosDateTime(new Date())

  for (const f of files) {
    const nameB = enc.encode(f.name)
    const data = f.data
    const crc = crc32(data)

    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true) // local file header signature
    lh.setUint16(4, 20, true) // version needed
    lh.setUint16(6, 0x0800, true) // flags: UTF-8 文件名
    lh.setUint16(8, 0, true) // method: store
    lh.setUint16(10, now.time, true)
    lh.setUint16(12, now.date, true)
    lh.setUint32(14, crc, true)
    lh.setUint32(18, data.length, true) // compressed size
    lh.setUint32(22, data.length, true) // uncompressed size
    lh.setUint16(26, nameB.length, true)
    lh.setUint16(28, 0, true) // extra length
    parts.push(new Uint8Array(lh.buffer), nameB, data)

    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true) // central directory signature
    ch.setUint16(4, 20, true) // version made by
    ch.setUint16(6, 20, true) // version needed
    ch.setUint16(8, 0x0800, true) // flags
    ch.setUint16(10, 0, true) // method
    ch.setUint16(12, now.time, true)
    ch.setUint16(14, now.date, true)
    ch.setUint32(16, crc, true)
    ch.setUint32(20, data.length, true)
    ch.setUint32(24, data.length, true)
    ch.setUint16(28, nameB.length, true)
    ch.setUint16(30, 0, true) // extra
    ch.setUint16(32, 0, true) // comment
    ch.setUint16(34, 0, true) // disk number
    ch.setUint16(36, 0, true) // internal attrs
    ch.setUint32(38, 0, true) // external attrs
    ch.setUint32(42, offset, true) // local header offset
    central.push(new Uint8Array(ch.buffer), nameB)

    offset += 30 + nameB.length + data.length
  }

  const cdSize = central.reduce((s, p) => s + p.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true)

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' })
}
