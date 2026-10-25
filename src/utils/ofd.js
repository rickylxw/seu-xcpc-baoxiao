/* OFD 发票文字提取：OFD 是 zip + XML 结构，TextCode 节点即文字内容 */
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
