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
  {
    t: '负责人：打印报销单汇总文件',
    d: '下载赛站总包 / 各队 ZIP，里面的「材料汇总-全部材料扫描打印版.pdf」「发票汇总-扫描打印版.pdf」就是财务要的扫描件；也可在下方「负责人 · 打印与预约」一键合成完整打印文档。',
  },
  {
    t: '负责人：财务系统网上填报',
    d: '打开财务系统网上报销（caiwuchujf.seu.edu.cn，统一身份认证登录，报销单管理 → 日常报销业务），照各队 ZIP 内「报销系统填写对照单.txt」逐字段填写：基本信息屏 + 差旅费明细屏（每名同学一行）。',
  },
  {
    t: '负责人：预约报销时间并上传预约报销单',
    d: '填报完成后在财务系统预约报销时间段，并按系统要求上传预约报销单与全部扫描材料；预约到的报销时间记在下方「负责人 · 打印与预约」卡里，方便群内同步。',  },
  {
    t: '负责人：核对全部发票抬头为「东南大学」',
    d: '所有可改抬头的发票抬头必须一字不差为「东南大学」（税号 12100000466006770Q），错误抬头无法报销；用下方「抬头总检」按钮扫一遍各队核对报告，有 ⚠ 的队先找队长换票。',
  },
  {
    t: '负责人：合成完整材料打印文档并打印',
    d: '点「合成完整材料打印版 PDF」把各队材料 + 参赛费合成一份按队分节的大 PDF，打印后随预约报销单一起提交。',
  },
]

export function defaultState() {
  return {
    version: 2,
    meta: {
      contest: '', dateContest: '', dateReturn: '', leader: '', homeCity: '南京',
      projectNo: '', // 财务系统「报销项目号」
      projectLeader: '', // 财务系统「项目负责人」
      leaderCard: '', // 负责人一卡通号（财务系统「申请人工号」）
      phone: '', // 财务系统「联系电话」
      email: '', // 财务系统「电子邮件」
      payMethod: '', // 财务系统「支付方式」
      appointmentTime: '', // 财务系统预约报销时间（负责人记录，供群内同步）
    },
    teamName: '',
    members: [], // { name, card }
    flow: [false, false, false, false],
    wizard: { enabled: true, role: '', step: 0, done: [], memberDone: false }, // 完全向导：持久化（刷新恢复角色/步骤/✓标记；memberDone=队员确认已交队长）
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
// （浏览器环境；Node 侧测试时无该全局，跳过）
if (typeof window !== 'undefined') addEventListener('beforeunload', saveNow)

/** 文件打包（材料分段与文件）：File 对象无法序列化，仅保存在内存中 */
export const pkg = reactive({ legs: [], cross: [] })

export const ui = reactive({ tab: 'overview', printTarget: '', preview: null })

/** 分步向导状态：随 state 持久化（刷新恢复角色/步骤/✓标记；role 为空 = 显示角色选择首屏） */
export const wizard = state.wizard

/** 材料打包页的视图模式（team / station）：向导可远程切换，故放 store */
export const filesUi = reactive({ mode: 'team' })

/** 赛站汇总（负责人）数据：FilesTab 录入、ReportTab 的「打印与预约」卡消费（如抬头总检 / 合成完整打印文档）。
    file 保持浏览器 File 对象（ZIP 原件 / 参赛费材料），条目字段见 FilesTab.addStationFiles */
export const stationState = reactive({ zips: [], efFiles: [] })
if (typeof window !== 'undefined') window.__stationState = stationState // 调试/测试钩

/** 材料预览浮层：图片 / PDF（浏览器原生查看器）/ OFD（渲染为页图）；关闭时释放 objectURL */
export function previewFile(file) {
  closePreview()
  const name = file.name
  if (/\.pdf$/i.test(name)) {
    ui.preview = { kind: 'pdf', url: URL.createObjectURL(file), name }
    return
  }
  if (/\.ofd$/i.test(name)) {
    ui.preview = { kind: 'ofd-loading', pages: [], name }
    import('./utils/ofd.js')
      .then(async ({ renderOfd, paintOfdPage }) => {
        const doc = await renderOfd(file)
        const cv = document.createElement('canvas')
        const pages = []
        for (const p of doc.pages) {
          await paintOfdPage(cv, p, doc.widthMm, doc.heightMm)
          pages.push(cv.toDataURL('image/png'))
        }
        if (ui.preview && ui.preview.name === name) {
          ui.preview = { kind: 'ofd', pages, name }
        }
      })
      .catch(() => {
        if (ui.preview && ui.preview.name === name) {
          ui.preview = { kind: 'error', message: 'OFD 渲染失败，请确认文件完整', name }
        }
      })
    return
  }
  ui.preview = { kind: 'image', url: URL.createObjectURL(file), name }
}
export function closePreview() {
  if (!ui.preview) return
  if (ui.preview.url) URL.revokeObjectURL(ui.preview.url)
  ui.preview = null
}

/** 识别进度统计（recognizeInto 每次调用自增；仅供界面展示进度与预计结束时间） */
export const recogStats = reactive({ total: 0, done: 0, running: 0, startedAt: 0, durationsMs: [] })
if (typeof window !== 'undefined') window.__recogStats = recogStats

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
