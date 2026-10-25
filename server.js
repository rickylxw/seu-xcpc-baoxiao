// 部署服务器：静态托管 dist/ + 识别代理（浏览器 → 本服务器 → 本机 Ollama）
// 用法：npm run build && node server.js
// 环境变量：PORT（默认 8080）、OLLAMA_URL（默认 http://127.0.0.1:11434）、OLLAMA_NUM_CTX（默认 8192）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 8080)
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', ...headers })
  res.end(body)
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' })
}

function readBody(req, limitMB = 64) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limitMB * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// OpenAI 格式 → Ollama 原生 /api/chat 格式（图片 data URL → images 数组；自动扩 num_ctx）
function toOllamaChat(body) {
  const messages = (body.messages || []).map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    let text = ''
    const images = []
    for (const part of m.content || []) {
      if (part.type === 'text') text += part.text
      else if (part.type === 'image_url') {
        const url = part.image_url?.url || ''
        const i = url.indexOf('base64,')
        if (i >= 0) images.push(url.slice(i + 'base64,'.length))
      }
    }
    return { role: m.role, content: text, ...(images.length ? { images } : {}) }
  })
  return {
    model: body.model,
    stream: false,
    messages,
    options: { num_ctx: NUM_CTX },
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

    if (req.method === 'OPTIONS') {
      send(res, 204, null, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      return
    }

    // ---- 识别代理：浏览器 → 本服务器 → 本机 Ollama ----
    if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/api/chat')) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const ollamaBody = pathname === '/api/chat' ? body : toOllamaChat(body)
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaBody),
      })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        sendJSON(res, r.status, { error: { message: `Ollama 返回 ${r.status}：${t.slice(0, 200)}` } })
        return
      }
      const j = await r.json()
      // 统一返回 OpenAI 格式（原生响应也包一层），前端解析逻辑不变
      const content = j?.message?.content ?? j?.choices?.[0]?.message?.content ?? ''
      sendJSON(res, 200, { choices: [{ message: { role: 'assistant', content } }] })
      return
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      const r = await fetch(`${OLLAMA_URL}/api/tags`).catch(() => null)
      if (!r || !r.ok) {
        sendJSON(res, 502, { error: { message: '无法连接 Ollama' } })
        return
      }
      const j = await r.json()
      sendJSON(res, 200, {
        object: 'list',
        data: (j.models || []).map((m) => ({ id: m.name, object: 'model' })),
      })
      return
    }

    // ---- 静态文件（dist/）----
    if (req.method === 'GET') {
      let rel = pathname === '/' ? '/index.html' : pathname
      let file = path.normalize(path.join(DIST, rel))
      if (!file.startsWith(DIST)) {
        send(res, 403, 'Forbidden')
        return
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html') // 单页应用回退
      }
      if (!fs.existsSync(file)) {
        send(res, 404, 'Not Found')
        return
      }
      const ext = path.extname(file).toLowerCase()
      send(res, 200, fs.readFileSync(file), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
      })
      return
    }

    send(res, 405, 'Method Not Allowed')
  } catch (e) {
    sendJSON(res, 500, { error: { message: (e && e.message) || String(e) } })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[deploy] 服务已启动: http://0.0.0.0:${PORT}/\n` +
      `[deploy] 静态目录: ${DIST}\n` +
      `[deploy] 识别代理: POST /v1/chat/completions → ${OLLAMA_URL} (num_ctx ${NUM_CTX})`,
  )
})
