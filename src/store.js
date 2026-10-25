/* 全局响应式状态：表单数据持久化到 localStorage；文件列表仅存内存。 */
import { reactive, watch } from 'vue'
import { downloadBlob, sanitizeName } from './utils/misc'

const KEY = 'xcpc-bx-v2'

export const FLOW = [
  {
    t: '赛前：确定报销负责人',
    d: '同一行程有多支队伍时，必须在参赛前协商确定本次负责报销的同学，并提前收集本次行程全体同学的一卡通号（「同学清单」页可整理导出）。',
  },
  {
    t: '返宁后 1 天内：整理并提交材料',
    d: '整理好全部报销材料，发给本次负责汇总报销的同学。例如周日返回南京，建议周一晚上之前整理并提交。',
  },
  {
    t: '收齐发票：立刻联系教练办理',
    d: '负责人收齐发票后立刻与教练约时间，线下由教练协助审核、确认报销材料并完成报销预约；随后由该同学和教练签字，提交学院审核。报销单可指定款项打到某一位或某几位同学关联的银行卡。',
  },
  {
    t: '收到报销款：立刻转付并群内告知',
    d: '收到报销款后，立刻将费用转给对应队伍和同学，并在参赛队员微信群告知。',
  },
]

export function defaultState() {
  return {
    version: 2,
    meta: { contest: '', dateContest: '', dateReturn: '', leader: '' },
    teamName: '',
    members: [], // { name, card }
    flow: [false, false, false, false],
    serverOcr: {
      enabled: true, // 启用后图片/扫描件改走服务端视觉模型识别（默认同源 /v1，由部署侧 server.js 代理到其本机 Ollama）
      baseUrl: '/v1', // 同源代理（server.js）；也可改为任意 OpenAI 兼容接口或 Ollama 地址
      apiKey: '', // 仅保存在本机浏览器（Ollama 无需填写）
      model: 'glm-ocr:latest', // OCR 视觉模型
    },
    approval: {
      done: false, // 负责人已填写/核对完成审批单（未勾选时进核对报告待办）
      fillDate: '', // 填表日期，留空则用当天
      personType: '校内人员',
      reason: '', // 出差事由，留空则用「参加」+ 比赛名称
      place: '', // 所到省份、城市
      unit: '', // 所到单位
      funding: '', // 项目经费
      rank: '学生', // 职务/职称级别
      rideOk: true, // 是否符合规定的乘坐等级
      trainRide: false, // 乘坐高铁二等座
      flightRide: false, // 乘坐飞机经济舱
      otherRide: '', // 其他交通工具及等级
      hotelOption: 'standard', // standard=按标准限额据实报销 / over=超标准自理
      hotelOver: '', // 超标准自理金额
      mealOption: 'none', // none=不领取补贴 / package=按包干标准直接领取
      cityOption: 'none', // none / package / actual
      note: '', // 特殊事项备注
    },
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function mergeState(base, over) {
  if (over === undefined) return base
  if (Array.isArray(base) || Array.isArray(over)) return Array.isArray(over) ? over : base
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base }
    for (const k of Object.keys(over)) {
      if (UNSAFE_KEYS.has(k)) continue
      out[k] = mergeState(base[k], over[k])
    }
    return out
  }
  return over
}

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultState()
    return mergeState(defaultState(), JSON.parse(raw))
  } catch {
    return defaultState()
  }
}

export const state = reactive(loadState())

let saveTimer = null
function saveNow() {
  clearTimeout(saveTimer)
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}
watch(
  state,
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, 250)
  },
  { deep: true },
)
// 关闭/刷新页面前立即落盘，避免防抖窗口内的最后一批输入随刷新丢失
addEventListener('beforeunload', saveNow)

/** 文件打包（材料分段与文件）：File 对象无法序列化，仅保存在内存中 */
export const pkg = reactive({ legs: [], cross: [] })

export const ui = reactive({ tab: 'overview', printTarget: '' })

let toastTimer = null
export const toast = reactive({ msg: '', show: false })
export function showToast(msg) {
  toast.msg = msg
  toast.show = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.show = false), 1800)
}

export function resetAll() {
  Object.assign(state, defaultState())
  pkg.legs.splice(0)
  showToast('已清空全部数据')
}

export function exportData() {
  const name = sanitizeName(`报销数据-${state.meta.contest || '未命名'}-${new Date().toISOString().slice(0, 10)}.json`)
  downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), name)
  showToast('已导出当前数据')
}

export async function importDataFile(file) {
  try {
    const data = JSON.parse(await file.text())
    Object.assign(state, mergeState(defaultState(), data))
    showToast('导入成功')
  } catch {
    alert('导入失败：不是有效的数据文件')
  }
}
