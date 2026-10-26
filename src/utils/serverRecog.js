/* 服务器端识别：调用 OpenAI 兼容的视觉模型接口（如智谱 GLM-4V、通义 Qwen-VL），
 * 识别材料中的金额与同学姓名。密钥仅保存在本机浏览器，材料将发送到你配置的服务端。 */

function toBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function endpointOf(baseUrl) {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('未配置服务器地址')
  return b.endsWith('/chat/completions') ? b : b + '/chat/completions'
}

/** 获取模型列表（GET {base}/models，OpenAI 兼容；Ollama 亦支持） */
export async function fetchModelList(baseUrl, apiKey) {
  const b = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!b) throw new Error('请先填写接口地址')
  const resp = await fetch(b + '/models', {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  })
  if (!resp.ok) throw new Error(`获取模型列表失败：${resp.status}`)
  const json = await resp.json()
  const data = json?.data || json?.models || []
  return data.map((m) => m.id || m.name).filter(Boolean)
}

function parseResultJSON(content) {
  if (!content) throw new Error('模型返回为空')
  let t = content.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const brace = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (brace >= 0 && end > brace) t = t.slice(brace, end + 1)
  const obj = JSON.parse(t)
  // 金额：兼容 金额/amount；同学：兼容 同学/members/names
  let amount = obj['金额'] ?? obj.amount ?? obj['总价'] ?? null
  if (typeof amount === 'string') amount = parseFloat(amount.replace(/[^\d.]/g, ''))
  if (!Number.isFinite(amount)) amount = ''
  let names = obj['同学'] ?? obj.members ?? obj.names ?? obj['姓名'] ?? []
  if (!Array.isArray(names)) names = []
  // 舱位（机票材料）：是否含「经济舱」
  let cabin = null
  const cabinRaw = obj['舱位'] ?? obj.cabin ?? obj['乘坐舱位'] ?? null
  if (typeof cabinRaw === 'string' && cabinRaw.trim()) {
    cabin = { ok: cabinRaw.includes('经济舱') }
  }
  // 发票抬头：购买方名称需含「东南大学」或税号；非发票 / 识别不出为 null
  const headerRaw = obj['抬头'] ?? obj.header ?? null
  let header = null
  if (typeof headerRaw === 'string' && headerRaw.trim()) {
    header = {
      ok: headerRaw.includes('东南大学') || headerRaw.includes('12100000466006770Q'),
    }
  }
  return { amount, names: names.map((n) => String(n)), header, cabin }
}

/**
 * 规范化图片：解码后重编码为标准 JPEG（最长边 ≤ 1600）。
 * 服务端 llama.cpp 只认标准 JPEG/PNG/WebP 等位图——扫描件 PDF 抽出的内嵌图、
 * HEIC 照片等会 400（failed to decode buffer），统一经 canvas 重编码可保证可解码；
 * 同时缩小超大图，明显加快纯 CPU 服务端的图片编码。
 * @returns {string|null} 纯 base64 JPEG；null = 原样发送（已是标准小图）
 */
async function normalizeImage(file) {
  if (typeof document === 'undefined') return null // 非浏览器环境（Node 测试）原样发送
  const stdMime = /^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type || '')
  const small = (file.size || 0) < 1.2 * 1024 * 1024
  if (stdMime && small) return null // 标准小图直接发原字节
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () =>
        reject(new Error('浏览器无法解码该图片（可能为 HEIC/扫描件内嵌格式），请转为 JPG/PNG 后上传'))
      el.src = url
    })
    const MAX = 1600
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff' // 透明底转 JPEG 前铺白底
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * 调用服务端视觉模型识别材料。
 * @returns {Promise<{ text: string, amounts: string[], members: {i:number,name:string}[] }>}
 */
export async function recognizeViaServer(file, members, cfg) {
  const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '')
  // Ollama 本地服务（11434/11435 端口）走原生 /api/chat：支持 options.num_ctx 扩大上下文，
  // 否则大图会超默认 4096 token 上下文被拒
  const isOllama = /:1143[45]/.test(base) || cfg.ollama === true
  if (!cfg.model) throw new Error('未配置模型名')
  if (!base) throw new Error('未配置服务器地址')

  let b64, mime
  const norm = await normalizeImage(file)
  if (norm) {
    b64 = norm
    mime = 'image/jpeg'
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer())
    b64 = toBase64(bytes)
    mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/png')
  }
  const dataUrl = `data:${mime};base64,${b64}`

  const roster = members.map((m) => m.name).filter(Boolean).join('、')
  const prompt =
    '你是报销材料识别助手。这是一张参赛报销材料（可能是发票、支付记录、行程单截图）。\n' +
    '请识别其中的信息，只输出一行 JSON，格式：{"金额": 数字, "同学": ["人名"], "抬头": "发票购买方名称"}。\n' +
    '金额为材料中的实付/票面金额（数字，不要货币符号）；' +
    (roster ? `同学只能从以下名单中选择出现的人名：${roster}。` : '同学为材料中出现的人名。') +
    '抬头为发票上的购买方名称（非发票或识别不出输出 null）。\n' +
    '识别不出就输出 null / 空数组；如果无法输出 JSON，就直接输出图中全部文字。'

  const doFetch = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    })

  // Ollama 原生 /api/chat：支持 options.num_ctx，图片走 images 数组
  if (isOllama) {
    const origin = base.replace(/\/v1$/, '') // 兼容用户填了 /v1 的情况
    const messages = [{ role: 'user', content: prompt, images: [b64] }]
    const resp = await doFetch(origin + '/api/chat', {
      model: cfg.model,
      stream: false,
      messages,
      options: { num_ctx: 8192 },
    })
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      throw new Error(`Ollama 返回 ${resp.status}：${t.slice(0, 120)}`)
    }
    const j = await resp.json()
    const content = j?.message?.content ?? ''
    const out = finalize(content, members)
    return { text: content, ...out }
  }

  // OpenAI 兼容 /chat/completions
  const resp = await doFetch(endpointOf(base), {
    model: cfg.model,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`接口返回 ${resp.status}：${t.slice(0, 120)}`)
  }
  const json = await resp.json()
  const content = json?.choices?.[0]?.message?.content ?? ''
  return finalize(content, members)
}

/** 从模型输出提取结果：JSON 优先，失败则按纯文字本地检测 */
function finalize(content, members) {
  let amounts = []
  let detected = []
  let header = null
  try {
    const parsed = parseResultJSON(content)
    amounts = Number.isFinite(parsed.amount) && parsed.amount !== '' ? ['¥' + Number(parsed.amount).toFixed(2)] : []
    detected = members
      .map((m, idx) => ({ i: idx, name: m.name }))
      .filter((m) => parsed.names.some((n) => n && (n === m.name || n.includes(m.name) || m.name.includes(n))))
    header = parsed.header || null
  } catch {
    // 模型输出非 JSON（如 OCR 模型的纯文字）：本地检测金额
    const found = detectPlainAmounts(content)
    amounts = found
  }
  return { text: content, amounts, detected, header, cabin: [] }
}

function detectPlainAmounts(t) {
  if (!t) return []
  const norm = t.replace(/\s+/g, '')
  const found = new Set()
  const re = /(￥|¥)\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)|([0-9]+(?:\.[0-9]{1,2})?)\s*元/g
  let m
  while ((m = re.exec(norm))) {
    const v = parseFloat((m[2] || m[3]).replace(/,/g, ''))
    if (Number.isFinite(v) && v > 0) found.add(v)
  }
  return [...found].sort((a, b) => b - a).slice(0, 3).map((v) => '¥' + v.toFixed(2))
}
