#!/usr/bin/env node
/* XCPC 报销材料整理工具 · MCP server（零依赖，stdio）
 *
 * 用法：node mcp-server.mjs [服务器地址]
 *   服务器地址默认 http://127.0.0.1:8080，也可用环境变量 XCPC_BAOXIAO_URL
 *
 * 在 MCP 客户端（ZCode / Claude Desktop 等）里配置示例：
 *   { "mcpServers": { "xcpc-baoxiao": { "command": "node", "args": ["<仓库>/mcp/mcp-server.mjs", "http://192.168.3.5:8080"] } } }
 *
 * 工具即 HTTP API（GET /api/agent）的薄封装：先调 agent_guide 了解流程，
 * 然后 create_session → upload_file（本地文件路径）→ get_status → update_file → download_zip。
 */
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 版本号跟随仓库 package.json（找不到时回退兜底值）
let VERSION = '2.2.0'
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version
} catch {}

const BASE = (process.argv[2] || process.env.XCPC_BAOXIAO_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
let token = null

async function api(method, apiPath, body, headers = {}) {
  const h = { ...headers }
  if (token) h['X-Agent-Token'] = token
  if (body && !(body instanceof Uint8Array) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json'
    body = JSON.stringify(body)
  }
  const r = await fetch(`${BASE}${apiPath}`, { method, headers: h, body })
  const buf = Buffer.from(await r.arrayBuffer())
  const ctype = r.headers.get('content-type') || ''
  if (ctype.includes('application/json')) return { status: r.status, json: JSON.parse(buf.toString('utf8') || '{}') }
  return { status: r.status, bytes: buf, contentType: ctype }
}

const TOOLS = [
  {
    name: 'agent_guide',
    description:
      '获取 XCPC 报销材料整理工具的完整使用指南：工作流程、每个接口的参数、材料规则（必附材料/抬头/经济舱/收付款一致等）。开始前必读。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_session',
    description:
      '创建报销会话（一个队一个会话），返回 token。之后所有工具自动使用该 token。会话闲置一个月过期，每次调用自动续期。meta 里可一并传财务系统对照单元数据（项目号/负责人/工号/电话/邮箱/支付方式），缺了后续也能 set_team_info 补。',
    inputSchema: {
      type: 'object',
      properties: {
        teamName: { type: 'string', description: '队名（必填，用于打包文件夹命名）' },
        members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, card: { type: 'string' } } }, description: '参赛同学名单（姓名+一卡通号）' },
        contest: { type: 'string', description: '比赛名称，如 CCPC 2026 长春站' },
        leader: { type: 'string', description: '报销负责人姓名' },
        homeCity: { type: 'string', description: '出发城市（默认南京）' },
        meta: {
          type: 'object',
          properties: {
            dateContest: { type: 'string', description: '比赛开始日期 YYYY-MM-DD' },
            dateReturn: { type: 'string', description: '返程日期 YYYY-MM-DD' },
            projectNo: { type: 'string', description: '财务系统：报销项目号' },
            projectLeader: { type: 'string', description: '财务系统：项目负责人' },
            leaderCard: { type: 'string', description: '财务系统：申请人工号' },
            phone: { type: 'string', description: '财务系统：电话' },
            email: { type: 'string', description: '财务系统：电子邮件' },
            payMethod: { type: 'string', description: '财务系统：支付方式' },
          },
          description: '财务系统网上报销填写对照单所需元数据（缺项在 get_status 的 sysFill.text 中标「未填写」）',
        },
      },
      required: ['teamName'],
    },
  },
  {
    name: 'upload_file',
    description:
      '上传一个本地材料文件（发票/支付记录/订单行程单等图片或 PDF/OFD）。服务器按文件名关键词自动分类到行程段与槽位（完整关键词映射见 agent_guide 的 keyword_map）。图片自动扫描增强（四角裁剪矫正+黑白，像扫描件）后 OCR，响应 scan 字段回报增强结果；scan.quadFound=false 表示未检出证件边缘（整图增强），若增强效果不佳可用 scanMode:"gray" 或 "off" 重传。判不出类别不会报错：文件落入「未分类」段，读出内容后用 update_file 的 group/type/slot 归位。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件绝对路径' },
        scanMode: { type: 'string', enum: ['bw', 'gray', 'off'], description: '图片扫描增强模式（默认 bw 黑白）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'update_file',
    description:
      '更新已上传文件的字段：amount（金额）、members（归属同学姓名数组）、scope（["outbound"]/["return"]/["outbound","return"]）、slot（槽位，可传数组实现一文件多槽，如 ["h_flow","h_pay"]）、extraSlots（附加槽位）、group/type（把「未分类」文件移动到目标行程段）、label；以及 issuer（发票开票方）、payee（支付收款方）、consistent（收付款是否一致）、note（不一致说明）。服务器识别不到的内容由你读取文件后提交；超额材料用 slot:"supplement"（归入 ZIP 的「补充材料」文件夹，不参与核对）。',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        amount: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        scope: { type: 'array', items: { type: 'string', enum: ['outbound', 'return'] } },
        slot: { description: '槽位 id，或槽位 id 数组（一文件多槽，首元素为主槽位）' },
        extraSlots: { type: 'array', items: { type: 'string' }, description: '附加槽位（如盖章结账流水主槽 h_flow 附加 h_pay）' },
        group: { type: 'string', enum: ['transport', 'stay', 'entryfee'], description: '移动目标分组（配 type，用于「未分类」归位）' },
        type: { type: 'string', enum: ['flight', 'train', 'local', 'hotel', 'entryfee'], description: '移动目标行程类型' },
        label: { type: 'string' },
        issuer: { type: 'string' },
        payee: { type: 'string' },
        consistent: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'get_status',
    description:
      '获取会话全量状态：每个文件的识别/核对情况（recogError 为识别失败原因）、缺漏检查结果、下一步建议（next 数组）、会话剩余时间（session.expiresAt）。sysFill.text 是「财务系统网上报销填写对照单」（caiwuchujf.seu.edu.cn 两个屏的逐字段填写值 + 按队员汇总的车船费/市内交通/住宿费，归报销负责人；元数据缺项向用户收集后 set_team_info 补）。每完成一步都应调用确认。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_team_info',
    description: '更新会话基础信息：队名、同学名单、比赛/负责人/日期等。',
    inputSchema: {
      type: 'object',
      properties: {
        teamName: { type: 'string' },
        members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, card: { type: 'string' } } } },
        meta: { type: 'object', description: '{contest, leader, homeCity, dateContest, dateReturn, projectNo, projectLeader, leaderCard, phone, email, payMethod}（后六项为财务系统对照单）' },
      },
    },
  },
  {
    name: 'download_zip',
    description: '打包并下载队伍 ZIP 到本地路径。打包前先用 get_status 确认 next 建议已全部处理。',
    inputSchema: {
      type: 'object',
      properties: { savePath: { type: 'string', description: '保存到的本地路径（如 ./报销材料.zip）' } },
      required: ['savePath'],
    },
  },
  // ---- 负责人赛站汇总 ----
  {
    name: 'station_set_name',
    description: '负责人：设置赛站名称（用于赛站总包文件夹命名）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '赛站名称，如 CCPC 2026 长春站' } },
      required: ['name'],
    },
  },
  {
    name: 'station_upload_team_zip',
    description: '负责人：上传一个队伍 ZIP 到赛站汇总（自动提取每队名单与核对报告待办）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '本地队伍 ZIP 文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'station_upload_entryfee',
    description: '负责人：上传参赛费材料。slot 需为 invite（邀请函）/ fee_invoice（参赛费发票）/ fee_pay（参赛费支付记录）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件路径' },
        slot: { type: 'string', enum: ['invite', 'fee_invoice', 'fee_pay'] },
      },
      required: ['path', 'slot'],
    },
  },
  {
    name: 'station_status',
    description: '负责人：查看赛站汇总状态（各队 ZIP、参赛费材料、名单汇总、下一步建议）。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'station_pack',
    description: '打包赛站总包并下载到本地路径（含 00-参赛费、各队文件夹、问题清单、汇总说明）。',
    inputSchema: {
      type: 'object',
      properties: { savePath: { type: 'string', description: '保存到的本地路径（如 ./赛站汇总.zip）' } },
      required: ['savePath'],
    },
  },
  {
    name: 'submit_feedback',
    description:
      '向网站提交使用意见反馈（无需会话）。使用时机：任务完成后向用户提议「本网站欢迎意见反馈」，征得用户同意后，把本次使用中遇到的问题与改进建议整理成 content 提交；用户不同意则不要调用。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '整理好的问题与建议（必填）' },
        teamName: { type: 'string', description: '队名（可选；已有会话时自动归属）' },
        contact: { type: 'string', description: '联系方式（可选）' },
        category: { type: 'string', description: '分类：bug/建议/其他（可选）' },
      },
      required: ['content'],
    },
  },
]

async function callTool(name, args = {}) {
  switch (name) {
    case 'agent_guide': {
      const { json } = await api('GET', '/api/agent')
      return JSON.stringify(json, null, 2)
    }
    case 'create_session': {
      const { json } = await api('POST', '/api/agent/sessions', args)
      if (json.token) token = json.token
      return JSON.stringify(json, null, 2)
    }
    case 'upload_file': {
      if (!token) return '错误：请先 create_session'
      const file = path.resolve(args.path)
      const bytes = fs.readFileSync(file)
      const scan = args.scanMode
      const { json } = await api('POST', `/api/agent/sessions/${token}/files`, bytes, {
        'X-Filename': encodeURIComponent(path.basename(file)),
        ...(scan && scan !== 'bw' ? { 'X-Scan': scan } : {}),
      })
      return JSON.stringify(json, null, 2)
    }
    case 'update_file': {
      if (!token) return '错误：请先 create_session'
      const { fileId, ...body } = args
      const { json } = await api('PATCH', `/api/agent/sessions/${token}/files/${fileId}`, body)
      return JSON.stringify(json, null, 2)
    }
    case 'get_status': {
      if (!token) return '错误：请先 create_session'
      const { json } = await api('GET', `/api/agent/sessions/${token}/status`)
      return JSON.stringify(json, null, 2)
    }
    case 'set_team_info': {
      if (!token) return '错误：请先 create_session'
      const { json } = await api('PATCH', `/api/agent/sessions/${token}`, args)
      return JSON.stringify(json, null, 2)
    }
    case 'download_zip': {
      if (!token) return '错误：请先 create_session'
      const { status, bytes } = await api('POST', `/api/agent/sessions/${token}/zip`)
      if (status !== 200) return '打包失败：' + bytes.toString('utf8').slice(0, 300)
      const save = path.resolve(args.savePath || './报销材料.zip')
      fs.writeFileSync(save, bytes)
      return `已保存：${save}（${bytes.length} 字节）`
    }
    case 'submit_feedback': {
      const { json, status } = await api('POST', '/api/agent/feedback', args)
      return JSON.stringify({ status, ...json }, null, 2)
    }
    // ---- 负责人赛站汇总（无需 create_session）----
    case 'station_set_name': {
      const { json } = await api('PATCH', '/api/agent/station', { name: args.name })
      return JSON.stringify(json, null, 2)
    }
    case 'station_upload_team_zip': {
      const bytes = fs.readFileSync(path.resolve(args.path))
      const { json, status } = await api('POST', '/api/agent/station/zips', bytes, {
        'X-Filename': encodeURIComponent(path.basename(args.path)),
        'Content-Type': 'application/zip',
      })
      return JSON.stringify({ status, ...json }, null, 2)
    }
    case 'station_upload_entryfee': {
      if (!['invite', 'fee_invoice', 'fee_pay'].includes(args.slot)) {
        return '错误：slot 需为 invite / fee_invoice / fee_pay'
      }
      const bytes = fs.readFileSync(path.resolve(args.path))
      const { json, status } = await api('POST', '/api/agent/station/entryfees', bytes, {
        'X-Filename': encodeURIComponent(path.basename(args.path)),
        'X-Slot': args.slot,
      })
      return JSON.stringify({ status, ...json }, null, 2)
    }
    case 'station_status': {
      const { json } = await api('GET', '/api/agent/station/status')
      return JSON.stringify(json, null, 2)
    }
    case 'station_pack': {
      const { status, bytes } = await api('POST', '/api/agent/station/zip')
      if (status !== 200) return '打包失败：' + bytes.toString('utf8').slice(0, 300)
      const save = path.resolve(args.savePath || './赛站汇总.zip')
      fs.writeFileSync(save, bytes)
      return `已保存：${save}（${bytes.length} 字节）`
    }
    default:
      return `未知工具：${name}`
  }
}

const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

rl.on('line', async (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'xcpc-baoxiao', version: VERSION },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params.name, params.arguments || {})
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '出错：' + String((e && e.message) || e) }], isError: true } })
    }
    return
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
})
