<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { state, pkg, showToast, recogStats, previewFile } from '../store'
import {
  GROUPS,
  TYPE_META,
  slotsOf,
  classifyMaterial,
  missingRequired,
  memberCoverage,
  coverageGaps,
  invoiceHeaderIssues,
  cabinIssues,
  amountCheck,
  payCheckIssues,
  buildTeamZipBlob,
  buildStationZipBlob,
  buildInvoicesPdf,
} from '../data/packaging'
import { readZipEntries } from '../utils/unzip'
import { downloadBlob, sanitizeName, isImageName } from '../utils/misc'
import { parseTodosSection } from '../data/report'
import { buildMergedPdf, mergeHeader } from '../utils/mergePrint'
import { fetchModelList } from '../utils/serverRecog'
import { recognizeInto } from '../utils/pdfText'
import LegCard from './LegCard.vue'

const mode = ref('team') // team | station

// 服务器端识别配置（部署形态：同源 /v1 代理，由 server.js 转发到服务器本机的 Ollama）
const modelList = ref([])
const modelLoading = ref(false)
const modelErr = ref('')
async function loadModels() {
  modelErr.value = ''
  modelLoading.value = true
  try {
    modelList.value = await fetchModelList(state.serverOcr.baseUrl, state.serverOcr.apiKey)
    if (!modelList.value.length) modelErr.value = '服务端未返回任何模型'
  } catch (e) {
    modelErr.value = '连接失败：' + ((e && e.message) || String(e)) + '（可点「部署服务器」预设恢复）'
  } finally {
    modelLoading.value = false
  }
}
function presetDeploy() {
  state.serverOcr.baseUrl = '/v1'
  state.serverOcr.model = 'glm-ocr:latest'
  state.serverOcr.apiKey = ''
  showToast('已切换为部署服务器同源代理（/v1）')
}
const busy = ref(false)

// 识别进度与预计结束时间：每秒刷新一次（仅在识别进行中时启动计时器）
const nowTick = ref(Date.now())
let recogTimer = null
const recogActive = computed(() => recogStats.total > 0 && recogStats.done < recogStats.total)
watch(
  recogActive,
  (on) => {
    if (on && !recogTimer) recogTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
    if (!on && recogTimer) {
      clearInterval(recogTimer)
      recogTimer = null
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => recogTimer && clearInterval(recogTimer))
const recogProgress = computed(() => {
  const { total, done, running, startedAt, durationsMs } = recogStats
  if (!total || done >= total) return null
  const avg = durationsMs.length ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length : 0
  // 首个文件完成前没有实测耗时，用 3 秒兜底；之后按滚动平均耗时 × 剩余数 ÷ 当前进度并行数估算
  const remainMs = (Math.max(avg, 3000) * (total - done)) / Math.max(1, running)
  return {
    total,
    done,
    running,
    pct: Math.round((done / total) * 100),
    elapsedMs: startedAt ? nowTick.value - startedAt : 0,
    remainMs,
    finishAt: new Date(nowTick.value + remainMs),
  }
})
const fmtDur = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`
}
const fmtClock = (d) => d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

// ===== 批量导入（自动分类填充） =====
const impEl = ref(null)
const impDirEl = ref(null)
const impBusy = ref(false)
const impList = reactive([]) // { file, name(含文件夹相对路径), target: 'groupId|type|slotId' | 'skip' }
let impFid = 1
const impOptions = [
  ...GROUPS.flatMap((g) =>
    g.types.flatMap((t) =>
      slotsOf(t).map((s) => ({ value: `${g.id}|${t}|${s.id}`, label: `${g.name} · ${TYPE_META[t].label} · ${s.name}` })),
    ),
  ),
  ...TYPE_META.entryfee.slots.map((s) => ({ value: `entryfee|entryfee|${s.id}`, label: `赛站汇总 · ${s.name}` })),
  { value: 'skip', label: '不导入' },
]
const IMP_EXT = /\.(pdf|ofd|png|jpe?g|webp|bmp)$/i
function onImpPick(e) {
  const seen = new Set(impList.map((r) => `${r.name}:${r.file.size}`))
  for (const f of e.target.files) {
    // 文件夹模式下会带出全部文件：只收支持的类型，跳过隐藏文件与重复选择
    const rel = f.webkitRelativePath || f.name
    if (f.name.startsWith('.') || !IMP_EXT.test(f.name)) continue
    const key = `${rel}:${f.size}`
    if (seen.has(key)) continue
    seen.add(key)
    const c = classifyMaterial(f.name, rel)
    impList.push({ file: f, name: rel, target: c && c.groupId ? `${c.groupId}|${c.type}|${c.slotId}` : 'skip' })
  }
  e.target.value = ''
}
function ensureLeg(groupId, type) {
  let leg = pkg.legs.find((l) => l.group === groupId && l.type === type)
  if (!leg) {
    pkg.legs.push({ id: `L${uidN++}`, group: groupId, type, label: '', memberIdx: null, files: [], customSlots: [] })
    leg = pkg.legs[pkg.legs.length - 1]
  }
  return leg
}
function slotNameOfId(type, slotId) {
  const slots = TYPE_META[type] ? TYPE_META[type].slots : TYPE_META.entryfee.slots
  return (slots.find((s) => s.id === slotId) || {}).name || slotId
}
function applyImport() {
  impBusy.value = true
  let n = 0
  try {
    for (const row of impList) {
      if (row.target === 'skip') continue
      const [groupId, type, slotId] = row.target.split('|')
      const slotName = slotNameOfId(type, slotId)
      const hint = (classifyMaterial(row.name) || {}).scopeHint || null
      if (groupId === 'entryfee') {
        efFiles.push({ id: `EF${efFid++}_${Date.now()}`, file: row.file, slot: slotId })
        const obj = efFiles[efFiles.length - 1]
        recognizeInto(obj, state.members, state.serverOcr, slotName)
      } else {
        const leg = ensureLeg(groupId, type)
        leg.files.push({
          id: `FI${impFid++}_${Date.now()}`,
          file: row.file,
          slot: slotId,
          amount: '',
          members: null,
          scope: groupId === 'transport' ? hint || ['outbound', 'return'] : [],
          meta: null,
        })
        const obj = leg.files[leg.files.length - 1]
        recognizeInto(obj, state.members, state.serverOcr, slotName)
      }
      n++
    }
    impList.splice(0)
    showToast(`已导入 ${n} 个文件，识别进行中…`)
  } finally {
    impBusy.value = false
  }
}

const legsOf = (gid) => pkg.legs.filter((l) => l.group === gid)
let uidN = 100
function addLeg(g) {
  pkg.legs.push({ id: `L${uidN++}`, group: g.id, type: g.types[0], label: '', memberIdx: null, files: [], customSlots: [] })
}
function removeLeg(leg) {
  if (leg.files.length && !confirm('该段已有材料文件，确定删除本段？')) return
  const i = pkg.legs.indexOf(leg)
  if (i >= 0) pkg.legs.splice(i, 1)
}

const missing = computed(() => missingRequired())
const missingText = computed(() =>
  missing.value.map(({ leg, slot }) => {
    const g = GROUPS.find((x) => x.id === leg.group)
    return `${g ? g.name : ''}·${TYPE_META[leg.type] ? TYPE_META[leg.type].label : ''}：${slot.name}`
  }),
)

// 材料准备进度：每位同学的归属检查
const coverage = computed(() => memberCoverage())
const coveredCount = computed(
  () => coverage.value.filter((c) => c.outbound && c.back && c.invoice).length,
)
const allCovered = computed(
  () => state.members.length > 0 && coveredCount.value === state.members.length,
)
const gapsText = computed(() =>
  coverageGaps()
    .map((g) => `${g.name}缺${g.miss.join('、')}`)
    .join('；'),
)

// 发票抬头检查
const headerInfo = computed(() => invoiceHeaderIssues())
const headerText = computed(() =>
  headerInfo.value.issues.map((x) => `${x.name}（${x.group}）`).join('；'),
)

// 机票舱位检查（经济舱字样）
const cabinInfo = computed(() => cabinIssues())
const cabinText = computed(() =>
  cabinInfo.value.issues.map((x) => `${x.name}（${x.group}）`).join('；'),
)

// 金额一致性核对（各组发票合计 vs 支付合计）
const amountRows = computed(() => amountCheck())
const amountIssues = computed(() => amountRows.value.filter((a) => a.match === false))
const amountText = computed(() =>
  amountIssues.value
    .map((a) => `${a.name}:发票 ¥${a.invSum.toFixed(2)} vs 支付 ¥${a.paySum.toFixed(2)}`)
    .join('；'),
)

function folderName() {
  return sanitizeName(`${state.meta.contest || 'XCPC'}-${state.teamName || '未命名队'}-报销材料`)
}

/* ---------- 合并为一个 PDF ---------- */
const mergeOpen = ref(false)
const mergeBusy = ref(false)
const mergeDoc = ref(null)

const invoicesBusy = ref(false)
async function downloadInvoices() {
  invoicesBusy.value = true
  try {
    const inv = await buildInvoicesPdf()
    downloadBlob(inv.blob, `发票汇总-${state.teamName || '未命名队'}.pdf`)
    showToast(`发票汇总 PDF 已下载（${inv.fileCount} 个文件 ${inv.pageCount} 页）`)
  } catch (e) {
    showToast((e && e.message) || String(e))
  } finally {
    invoicesBusy.value = false
  }
}

async function openMerge() {
  const hasFiles = pkg.legs.some((l) => l.files.length)
  if (!hasFiles) return showToast('还没有上传任何材料文件')
  mergeBusy.value = true
  try {
    const doc = await buildMergedPdf()
    mergeDoc.value = { ...doc, header: mergeHeader() }
    mergeOpen.value = true
  } catch (err) {
    alert('合并失败：' + (err?.message || err))
  } finally {
    mergeBusy.value = false
  }
}
function downloadMerged() {
  if (!mergeDoc.value) return
  downloadBlob(mergeDoc.value.blob, `${folderName()}-合并.pdf`)
  showToast('合并 PDF 已下载，可用浏览器或 PDF 阅读器打开后打印')
}
function openOriginal(file) {
  window.open(URL.createObjectURL(file), '_blank')
}

async function packTeam() {
  if (!state.teamName.trim()) {
    showToast('请先填写队名')
    return
  }
  if (
    missing.value.length &&
    !confirm(
      `还有 ${missing.value.length} 项必附材料未上传（${missingText.value.slice(0, 3).join('；')}${
        missing.value.length > 3 ? ' 等' : ''
      }），确定仍要打包？`,
    )
  ) {
    return
  }
  const gaps = coverageGaps()
  if (
    gaps.length &&
    !confirm(
      `仍有 ${gaps.length} 位同学的材料归属不完整（${gaps
        .slice(0, 3)
        .map((g) => `${g.name}缺${g.miss.join('、')}`)
        .join('；')}${gaps.length > 3 ? ' 等' : ''}），确定仍要打包？`,
    )
  ) {
    return
  }
  const headerIssues = headerInfo.value.issues
  if (
    headerIssues.length &&
    !confirm(
      `有 ${headerIssues.length} 张发票未识别到「东南大学」抬头，请人工核对（${headerText.value.slice(0, 120)}${
        headerText.value.length > 120 ? '…' : ''
      }），确定仍要打包？`,
    )
  ) {
    return
  }
  const amtIssues = amountIssues.value
  if (
    amtIssues.length &&
    !confirm(
      `有 ${amtIssues.length} 组支付金额与发票金额不一致（${amountText.value.slice(0, 140)}），打包将附「支付不一致说明.txt」。确定仍要打包？`,
    )
  ) {
    return
  }
  const pcIssues = payCheckIssues()
  const pcNoNote = pcIssues.filter((p) => !p.filled)
  if (
    pcNoNote.length &&
    !confirm(
      `有 ${pcNoNote.length} 个行程段收付款方核对不一致且未填写说明（${pcNoNote
        .slice(0, 3)
        .map((p) => p.name)
        .join('；')}${pcNoNote.length > 3 ? ' 等' : ''}），说明中将标注「未填写」。确定仍要打包？`,
    )
  ) {
    return
  }
  const cabins = cabinInfo.value.issues
  if (
    cabins.length &&
    !confirm(
      `有 ${cabins.length} 张机票材料未识别到「经济舱」字样（飞机仅限经济舱，${cabins
        .slice(0, 3)
        .map((x) => x.name)
        .join('；')}${cabins.length > 3 ? ' 等' : ''}），确定仍要打包？`,
    )
  ) {
    return
  }
  busy.value = true
  try {
    downloadBlob(await buildTeamZipBlob(), `${folderName()}.zip`)
    showToast('队伍材料包已下载')
  } catch (err) {
    alert('打包失败：' + (err?.message || err))
  } finally {
    busy.value = false
  }
}

/* ---------- 赛站汇总 ---------- */
const stationName = ref(state.meta.contest || '')
const stationZips = reactive([])
let zid = 1
const dragging = ref(false)
const fileEl = ref(null)

// 参赛费材料（赛站级，负责人统一收取）
const efFiles = reactive([])
const efFileEl = ref(null)
let efPending = null
let efFid = 1
const EF_SLOTS = TYPE_META.entryfee.slots
function browseEf(slotId) {
  efPending = slotId
  efFileEl.value.click()
}
function onPickEf(e) {
  for (const f of e.target.files) {
    efFiles.push({ id: `EF${efFid++}_${Date.now()}`, file: f, slot: efPending })
  }
  e.target.value = ''
}
const efFilesOf = (slotId) => efFiles.filter((f) => f.slot === slotId)
function removeEf(f) {
  const i = efFiles.indexOf(f)
  if (i >= 0) efFiles.splice(i, 1)
}

async function addStationFiles(list) {
  for (const f of list) {
    const item = reactive({ id: `Z${zid++}`, file: f, team: f.name.replace(/\.zip$/i, ''), count: null, todos: [], error: '' })
    stationZips.push(item)
    try {
      const entries = await readZipEntries(f)
      item.count = entries.length
      const roots = new Set(entries.map((en) => en.name.split('/')[0]))
      if (roots.size === 1) item.team = [...roots][0]
      // 解析该队核对报告中的待办事项
      const reportEntry = entries.find((e2) => e2.name.includes('核对报告.txt'))
      if (reportEntry) item.todos = parseTodosSection(new TextDecoder('utf-8').decode(reportEntry.data))
    } catch (err) {
      item.error = err?.message || String(err)
    }
  }
}
function onDrop(e) {
  dragging.value = false
  addStationFiles(e.dataTransfer.files)
}
function onPickZip(e) {
  addStationFiles(e.target.files)
  e.target.value = ''
}
function removeZip(it) {
  const i = stationZips.indexOf(it)
  if (i >= 0) stationZips.splice(i, 1)
}

async function packStation() {
  const name = stationName.value.trim()
  if (!name) return showToast('请先填写赛站名称')
  if (!stationZips.length) return showToast('请先上传各队伍 ZIP')
  if (stationZips.some((z) => z.error)) return showToast('存在无法读取的 ZIP，请先移除后再打包')
  const names = stationZips.map((z) => z.team.trim() || '未命名')
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup && !confirm(`存在重名队伍「${dup}」，重名的将自动加序号区分。确定继续？`)) return
  const totalTodos = stationZips.reduce((s2, z) => s2 + (z.todos?.length || 0), 0)
  if (
    totalTodos &&
    !confirm(
      `各队共有 ${totalTodos} 项待办事项未完成（将写入「问题清单.txt」随汇总包提交），确定仍要打包？`,
    )
  ) {
    return
  }
  busy.value = true
  try {
    downloadBlob(await buildStationZipBlob(name, stationZips, efFiles), `${sanitizeName(name)}-报销材料汇总.zip`)
    showToast('赛站汇总包已下载')
  } catch (err) {
    alert('汇总失败：' + (err?.message || err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section id="tab-files" class="tab-pane">
    <div class="mode-seg">
      <button :class="{ active: mode === 'team' }" @click="mode = 'team'">按队伍打包</button>
      <button :class="{ active: mode === 'station' }" @click="mode = 'station'">赛站汇总（负责人）</button>
    </div>

    <div v-if="recogProgress" class="notice amber" style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
      <div style="flex: 1; height: 8px; border-radius: 4px; background: rgba(0, 0, 0, 0.08); overflow: hidden">
        <div
          :style="{
            width: recogProgress.pct + '%',
            height: '100%',
            borderRadius: '4px',
            background: '#2e7d6b',
            transition: 'width .4s',
          }"
        ></div>
      </div>
      <span style="white-space: nowrap">
        识别中 {{ recogProgress.done }}/{{ recogProgress.total }} · 已用时 {{ fmtDur(recogProgress.elapsedMs) }} ·
        预计还需约 {{ fmtDur(recogProgress.remainMs) }} · 预计 <b>{{ fmtClock(recogProgress.finishAt) }}</b> 全部完成
      </span>
    </div>

    <!-- ========== 按队伍打包 ========== -->
    <template v-if="mode === 'team'">
      <div class="card">
        <h2>队伍信息</h2>
        <div class="form-grid">
          <label class="field">
            <span>队名（必填，用于文件夹与文件命名）</span>
            <input v-model="state.teamName" placeholder="如：金陵一队" />
          </label>
          <label class="field">
            <span>参赛同学（到「同学清单」页录入后用于归属勾选）</span>
            <input disabled :value="state.members.length ? state.members.map((m) => m.name).join('、') : '（未录入）'" />
          </label>
        </div>
        <p class="hint">
          按「往返交通 → 赛站住宿」逐段添加行程并上传对应材料；交通分为飞机 / 高铁 /
          市内交通，每段可添加多段；每个文件单独勾选去程 / 返程、金额与归属队员，打包时自动规范命名。参赛费材料归赛站汇总负责人统一收取，不在队伍包内。
          <b>报销要求：所有支付尽量由队长一人承担，减少报销负责同学的核对负担。</b>
        </p>
      </div>

      <div class="card">
        <h2>批量导入（自动分类填充）</h2>
        <p class="hint">
          一次选择全套材料或整个文件夹（自动跳过不支持的文件类型），按文件名与文件夹名自动分类到对应槽位；文件名含「去程 /
          返程」会直接勾好，导入后自动识别金额、归属队员与起讫地。分类不对的可在下拉框里改，识别不出类别的默认「不导入」。
        </p>
        <div class="btn-row" style="margin: 0 0 8px">
          <button type="button" class="btn" @click="impEl.click()">选择材料文件</button>
          <button type="button" class="btn" @click="impDirEl.click()">选择材料文件夹</button>
          <span v-if="impList.length" class="hint" style="margin: 0">已选 {{ impList.length }} 个</span>
          <span style="flex: 1"></span>
          <template v-if="impList.length">
            <button type="button" class="btn" @click="impList.splice(0)">取消</button>
            <button type="button" class="btn btn-primary" :disabled="impBusy" @click="applyImport">
              确认导入
            </button>
          </template>
        </div>
        <input ref="impEl" type="file" multiple hidden accept=".pdf,.ofd,.png,.jpg,.jpeg,.webp,.bmp" @change="onImpPick" />
        <input ref="impDirEl" type="file" multiple hidden webkitdirectory directory @change="onImpPick" />
        <div v-if="impList.length" class="imp-list">
          <div v-for="(row, i) in impList" :key="row.name + i" class="imp-row">
            <span class="file-name" :title="row.name">{{ row.name }}</span>
            <select v-model="row.target" class="imp-select">
              <option v-for="o in impOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row-between">
          <h2>识别方式（图片 / 扫描件 PDF）</h2>
          <label class="mem-chk">
            <input type="checkbox" v-model="state.serverOcr.enabled" />使用服务器端模型
          </label>
        </div>
        <template v-if="state.serverOcr.enabled">
          <div class="btn-row" style="margin: 0 0 10px">
            <span class="hint" style="margin: 0">预设：</span>
            <button type="button" class="btn btn-sm" @click="presetDeploy">部署服务器（同源 /v1）</button>
          </div>

          <div class="form-grid">
            <label class="field">
              <span>接口地址（OpenAI 兼容，到 /v1 这一级；部署站同源代理填 /v1）</span>
              <input v-model="state.serverOcr.baseUrl" placeholder="/v1 或 https://…/v1" />
            </label>
            <label class="field">
              <span>模型名（服务器 Ollama 中已安装的视觉模型）</span>
              <input v-model="state.serverOcr.model" placeholder="如 glm-ocr:latest" />
            </label>
          </div>
          <div class="btn-row" style="margin: 0 0 10px">
            <button type="button" class="btn btn-sm" :disabled="modelLoading" @click="loadModels">
              {{ modelLoading ? '测试连接中…' : '测试连接 / 获取模型列表' }}
            </button>
          </div>
          <div v-if="modelErr" class="notice red" style="margin-bottom: 10px">{{ modelErr }}</div>
          <div v-if="modelList.length" class="file-members" style="margin-bottom: 10px">
            <span class="hint" style="margin: 0">连接正常，点击填入模型：</span>
            <button
              v-for="m in modelList"
              :key="m"
              type="button"
              class="btn btn-sm"
              @click="state.serverOcr.model = m"
            >
              {{ m }}
            </button>
          </div>
          <div class="notice amber">
            启用后，图片与扫描件将发送到部署服务器识别（材料含姓名、金额等个人信息，请确认服务器可信）。文本型 PDF 与
            OFD 仍使用本地解析；服务器失败会自动回退本地 OCR。
          </div>
        </template>
        <p v-else class="hint" style="margin: 0">
          当前使用本地识别：文本型 PDF 提取文字，图片 / 扫描件使用浏览器内 OCR（中文模型已内置，离线可用）。
        </p>
      </div>

      <div v-for="g in GROUPS" :key="g.id" class="card">
        <div class="row-between">
          <h2><span class="g-badge">{{ GROUPS.indexOf(g) + 1 }}</span>{{ g.name }}</h2>
          <button class="btn btn-sm btn-primary" @click="addLeg(g)">＋ 添加一段</button>
        </div>
        <p v-if="!legsOf(g.id).length" class="empty">还没有添加行程段，点击右上角「＋ 添加一段」。</p>
        <div v-else class="leg-list">
          <LegCard
            v-for="leg in legsOf(g.id)"
            :key="leg.id"
            :leg="leg"
            :types="g.types"
            @remove="removeLeg(leg)"
          />
        </div>
      </div>

      <div class="card">
        <div class="row-between">
          <h2>材料准备进度</h2>
          <span class="pill" :class="allCovered ? 'ok' : 'bad'">
            {{ state.members.length ? `${coveredCount} / ${state.members.length} 名同学归属齐全` : '尚未录入同学' }}
          </span>
        </div>
        <p class="hint">
          每位同学都必须至少归属一段<b>去程</b>、一段<b>返程</b>，以及一段已上传<b>住宿发票</b>的住宿（在各段的「材料归属队员」里勾选即可计入；默认全员段对所有人都生效）。
        </p>
        <p v-if="!state.members.length" class="empty">请先到「同学清单」页录入同学，再回到本页查看归属进度。</p>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>队员</th>
              <th style="width: 18%">去程</th>
              <th style="width: 18%">返程</th>
              <th style="width: 18%">住宿发票</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in coverage" :key="c.idx">
              <td>{{ c.name }}<span v-if="c.card" class="hint">　{{ c.card }}</span></td>
              <td><span :class="c.outbound ? 'cov-ok' : 'cov-miss'">{{ c.outbound ? '✓ 已归属' : '✗ 缺' }}</span></td>
              <td><span :class="c.back ? 'cov-ok' : 'cov-miss'">{{ c.back ? '✓ 已归属' : '✗ 缺' }}</span></td>
              <td><span :class="c.invoice ? 'cov-ok' : 'cov-miss'">{{ c.invoice ? '✓ 已归属' : c.stay ? '✗ 该段未传发票' : '✗ 缺' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="row-between">
          <h2>合并与打包</h2>
          <div class="btn-row" style="margin: 0">
            <button class="btn" :disabled="invoicesBusy" @click="downloadInvoices">发票汇总 PDF（便捷扫描）</button>
            <button class="btn" :disabled="mergeBusy" @click="openMerge">合并为一个 PDF</button>
            <button class="btn btn-primary" :disabled="busy" @click="packTeam">打包下载队伍 ZIP</button>
          </div>
          <p class="hint" style="margin: 0 0 8px">
            「发票汇总 PDF」只含发票/报销凭证（按清单顺序合并成一份文档），适合整体扫描或打印后随材料提交。
          </p>
        </div>
        <p class="hint">
          「合并为一个 PDF」会把全部材料按清单顺序合成一份大文档：图片等比排版到 A4 页，PDF
          材料原样无损合并（矢量保留），下载后用浏览器或 PDF 阅读器打开即可打印。
          「打包 ZIP」则生成 <b>{{ folderName() }}/</b> 分类文件夹，另含队伍信息.txt、参赛同学清单
          CSV、核对报告 TXT（差旅审批单由负责人随赛站汇总包提交，不在队伍包内）。
        </p>
        <div v-if="missing.length" class="notice amber">
          尚有 {{ missing.length }} 项必附材料未上传：{{ missingText.join('；') }}。
        </div>
        <div v-if="headerInfo.issues.length" class="notice red">
          有 {{ headerInfo.issues.length }} 张发票未识别到「东南大学」抬头（{{ headerText }}）。发票抬头必须为「东南大学」+ 税号
          12100000466006770Q，请人工核对该发票，错误抬头无法报销。
        </div>
        <div v-if="cabinInfo.issues.length" class="notice red">
          有 {{ cabinInfo.issues.length }} 张机票材料未识别到「经济舱」字样（{{ cabinText }}）。飞机仅限经济舱，请人工核对。
        </div>
        <div
          v-for="a in amountRows"
          :key="a.group"
          class="notice"
          :class="a.match === false ? 'red' : a.match ? '' : 'amber'"
          style="border: 1px solid"
        >
          <b>{{ a.name }}</b>：发票 {{ a.invCount }} 张合计 <b>¥{{ a.invSum.toFixed(2) }}</b>，支付
          {{ a.payCount }} 笔合计 <b>¥{{ a.paySum.toFixed(2) }}</b>
          <template v-if="a.match === true">—— 一致 ✓</template>
          <template v-else-if="a.match === false">—— <b>不一致</b>（通用要求：支付金额合计必须与发票金额一致）</template>
          <template v-else>—— 金额待填写（在上方对应文件的金额框中填写）</template>
        </div>
      </div>

      <!-- 合并结果浮层 -->
      <div v-if="mergeOpen" class="merge-overlay">
        <div class="merge-bar no-print">
          <b>合并结果</b>
          <span v-if="mergeDoc" class="hint" style="margin: 0; color: #d8efeb">
            {{ mergeDoc.fileCount }} 个文件 → {{ mergeDoc.pageCount }} 页
          </span>
          <span style="flex: 1"></span>
          <button class="btn btn-primary" @click="downloadMerged">下载合并 PDF</button>
          <button class="btn" @click="mergeOpen = false">关闭</button>
        </div>
        <div v-if="mergeBusy" class="empty" style="margin: 40px">正在按顺序合并材料…</div>
        <div v-else-if="mergeDoc" class="merge-pages">
          <div class="merge-title">{{ mergeDoc.header.title }}</div>
          <div class="merge-meta">
            赛站：{{ mergeDoc.header.contest }} ｜ 队名：{{ mergeDoc.header.team }} ｜ 负责人：{{ mergeDoc.header.leader }}
            <br />成员：{{ mergeDoc.header.members.join('；') || '（未录入）' }}
            <br />生成时间：{{ mergeDoc.header.time }}
          </div>

          <div v-if="mergeDoc.skipped.length" class="notice red" style="margin-bottom: 14px">
            有 {{ mergeDoc.skipped.length }} 个文件无法合并（
            {{ mergeDoc.skipped.map((s) => `${s.label}：${s.reason}`).join('；') }} ），请单独打印后再附上。
          </div>

          <p class="hint">点击「下载合并 PDF」后，用浏览器或 PDF 阅读器打开即可打印（共 {{ mergeDoc.pageCount }} 页）。合并顺序如下：</p>
          <table class="tbl">
            <thead>
              <tr>
                <th class="cell-num">#</th>
                <th>分组 / 行程段</th>
                <th>材料</th>
                <th style="width: 60px">页数</th>
                <th style="width: 90px">原件</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(m, i) in mergeDoc.manifest" :key="i">
                <td class="cell-num">{{ i + 1 }}</td>
                <td>{{ m.group }} · {{ m.legTitle }}</td>
                <td>{{ m.label }}</td>
                <td>{{ m.pages }}</td>
                <td><a href="javascript:;" @click="openOriginal(m.file)">打开</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ========== 赛站汇总 ========== -->
    <template v-else>
      <div class="card">
        <h2>赛站汇总（报销负责人用）</h2>
        <p class="hint">上传各队伍在本工具中打包的 ZIP，自动解包合并为一个赛站总包，每队一个文件夹。</p>
        <div class="form-grid">
          <label class="field">
            <span>赛站名称（必填）</span>
            <input v-model="stationName" placeholder="如：ICPC 2026 南京站" />
          </label>
        </div>

        <div
          class="dropzone"
          :class="{ drag: dragging }"
          @click="fileEl.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <b>拖拽队伍 ZIP 到这里</b>
          <span class="dz-or">或</span>
          <button class="btn btn-primary" @click.stop="fileEl.click()">选择 ZIP 文件</button>
          <input ref="fileEl" type="file" multiple accept=".zip" hidden @change="onPickZip" />
        </div>

        <p v-if="!stationZips.length" class="empty">还没有上传队伍 ZIP。</p>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th class="cell-num">#</th>
              <th>原文件</th>
              <th style="width: 240px">队伍名称（可修改）</th>
              <th>文件数</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in stationZips" :key="it.id">
              <td class="cell-num">{{ stationZips.indexOf(it) + 1 }}</td>
              <td>{{ it.file.name }}</td>
              <td><input v-model="it.team" /></td>
              <td>
                <span v-if="it.error" class="pill bad">读取失败</span>
                <span v-else-if="it.count == null" class="pill mute">读取中…</span>
                <span v-else>{{ it.count }}</span>
              </td>
              <td><button class="btn btn-sm btn-danger-ghost" @click="removeZip(it)">删除</button></td>
            </tr>
          </tbody>
        </table>

        <!-- 各队待办事项（从核对报告解析） -->
        <div v-for="it in stationZips" :key="'td-' + it.id" class="recog-block">
          <div class="recog-title">{{ it.team || it.file.name }} 的待办事项（{{ it.todos.length }} 项）</div>
          <div v-for="(td, i) in it.todos" :key="i" class="recog-line">· {{ td }}</div>
          <div v-if="!it.todos.length" class="slot-note">无待办 ✓</div>
        </div>

        <div v-if="stationZips.some((z) => z.error)" class="notice red">
          部分 ZIP 无法读取（{{ stationZips.filter((z) => z.error).map((z) => z.file.name).join('、') }}），请移除后再打包。
        </div>

        <h2 style="margin-top: 18px">参赛费材料（由负责人统一收取）</h2>
        <p class="hint">参赛费为赛站级统一报销，队伍包中不包含；此处上传的文件将放进汇总包的「00-参赛费」文件夹。</p>
        <div class="slot-list">
          <div v-for="s in EF_SLOTS" :key="s.id" class="slot-row">
            <div class="slot-info">
              <div class="slot-name">
                {{ s.name }}
                <span :class="s.required ? 'req-chip' : 'mute-chip'">{{ s.required ? '必附' : '按需' }}</span>
              </div>
              <div v-if="s.note" class="slot-note">{{ s.note }}</div>
            </div>
            <div class="slot-files">
              <span
                v-for="f in efFilesOf(s.id)"
                :key="f.id"
                class="file-chip"
                :class="{ previewable: isImageName(f.file.name) }"
                :title="isImageName(f.file.name) ? `${f.file.name}（点击预览）` : f.file.name"
                @click="isImageName(f.file.name) && previewFile(f.file)"
              >
                {{ f.file.name }}<button type="button" title="移除" @click.stop="removeEf(f)">×</button>
              </span>
              <button type="button" class="btn btn-sm" @click="browseEf(s.id)">＋ 上传</button>
            </div>
          </div>
        </div>
        <input ref="efFileEl" type="file" multiple hidden @change="onPickEf" />

        <div class="btn-row" style="margin-top: 12px">
          <button class="btn btn-primary" :disabled="busy" @click="packStation">打包下载赛站汇总 ZIP</button>
        </div>
        <p class="hint">
          将生成「{{ sanitizeName(stationName || '赛站') }}-报销材料汇总.zip」：每队一个文件夹 +
          汇总说明.txt；ZIP 内的顶层目录会自动剥掉，避免嵌套。
        </p>
      </div>
    </template>
  </section>
</template>
