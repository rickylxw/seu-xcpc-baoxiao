<script setup>
import { computed, ref } from 'vue'
import { state, pkg, FLOW, ui, showToast, stationState } from '../store'
import { GROUPS, TYPE_META, memberNamesOfIdx, memberCoverage } from '../data/packaging'
import { deadlineText, reportTodos, reportText, reportMarkdown, msgTemplates } from '../data/report'
import { fmtDateCN, copyText, downloadBlob, sanitizeName } from '../utils/misc'
import { buildStationPrintPdf, stationHeaderCheck } from '../utils/stationPrint'

const now = computed(() => new Date().toLocaleString('zh-CN', { hour12: false }))
const todos = computed(() => reportTodos())
const msgs = msgTemplates()

const deadline = computed(() => {
  if (!state.meta.dateReturn) return deadlineText()
  const d = new Date(state.meta.dateReturn + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return `${fmtDateCN(d)}晚上前（返宁后 1 天内）`
})

const groupsView = computed(() =>
  GROUPS.map((g) => ({
    ...g,
    legs: pkg.legs
      .filter((l) => l.group === g.id)
      .map((leg) => ({
        ...leg,
        title: `${TYPE_META[leg.type] ? TYPE_META[leg.type].label : ''}${leg.label ? ' · ' + leg.label : ''}`,
        files: leg.files.map((f) => {
          const members =
            f.members == null ? '全员' : f.members.map((i) => state.members[i]?.name || '成员' + (i + 1)).join('、')
          const scope =
            f.scope && f.scope.includes('outbound') && f.scope.includes('return')
              ? '去程返程'
              : f.scope && f.scope.includes('outbound')
                ? '去程'
                : f.scope && f.scope.includes('return')
                  ? '返程'
                  : ''
          return {
            id: f.id,
            fileName: f.file.name,
            amount: f.amount,
            members,
            scope,
          }
        }),
      })),
  })),
)

const coverage = computed(() => memberCoverage())

function printReport() {
  ui.printTarget = 'report'
  setTimeout(() => window.print(), 50)
}
async function copyMd() {
  await copyText(reportMarkdown())
  showToast('Markdown 报告已复制')
}
function downloadTxt() {
  const name = `核对报告-${state.meta.contest || '未命名'}.txt`.replace(/[\\/:*?"<>|]/g, '-')
  downloadBlob(new Blob(['\ufeff' + reportText()], { type: 'text/plain;charset=utf-8' }), name)
  showToast('TXT 已下载')
}
async function copyMsg(i) {
  await copyText(msgs.value[i])
  showToast('已复制，可粘贴到微信群')
}

/* ---------- 负责人 · 打印与预约（财务处最后阶段）---------- */
// 办理流程勾选（点一下切换 ✓/○；旧数据 flow 数组长度不足时自动补齐）
function toggleFlow(i) {
  while (state.flow.length < FLOW.length) state.flow.push(false)
  state.flow[i] = !state.flow[i]
}

const headerResults = ref([])
const headerChecking = ref(false)
async function runHeaderCheck() {
  if (!stationState.zips.length) return showToast('请先在「材料打包 · 赛站汇总」导入各队 ZIP')
  headerChecking.value = true
  try {
    headerResults.value = await stationHeaderCheck(stationState.zips)
    const bad = headerResults.value.filter((r) => r.issues.length || !r.hasReport || !r.hasSection)
    showToast(bad.length ? `${bad.length} 支队伍需要处理，详见列表` : '全部队伍抬头检查通过 ✓')
  } finally {
    headerChecking.value = false
  }
}

const printBuilding = ref(false)
const printSummary = ref(null)
async function buildPrintDoc() {
  if (!stationState.zips.length) return showToast('请先在「材料打包 · 赛站汇总」导入各队 ZIP')
  printBuilding.value = true
  try {
    const name = state.meta.contest || state.teamName || '赛站'
    const r = await buildStationPrintPdf(name, stationState.zips, stationState.efFiles)
    printSummary.value = { pages: r.pages, teams: r.teams, warnings: r.warnings }
    downloadBlob(r.blob, `${sanitizeName(name)}-完整材料打印版.pdf`)
    showToast(`已合成 ${r.pages} 页，正在下载`)
  } catch (e) {
    showToast('合成失败：' + String(e?.message || e).slice(0, 60))
  } finally {
    printBuilding.value = false
  }
}
</script>

<template>
  <section id="tab-report" class="tab-pane">
    <div class="btn-row no-print">
      <button class="btn btn-primary" @click="printReport">🖨 打印报告</button>
      <button class="btn" @click="copyMd">复制 Markdown</button>
      <button class="btn" @click="downloadTxt">下载 TXT</button>
    </div>

    <div class="card report">
      <div class="rp-head">
        <h2>报销材料核对报告</h2>
        <div class="rp-sub">{{ state.meta.contest || '未填写比赛名称' }} ｜ 生成时间：{{ now }}</div>
      </div>

      <h3>一、基本信息</h3>
      <table class="tbl">
        <tbody>
          <tr><th style="width: 130px">比赛名称</th><td>{{ state.meta.contest || '—' }}</td></tr>
          <tr><th>比赛日期</th><td>{{ state.meta.dateContest || '—' }}</td></tr>
          <tr><th>返宁日期</th><td>{{ state.meta.dateReturn || '—' }}</td></tr>
          <tr><th>建议提交时间</th><td>{{ deadline }}</td></tr>
          <tr><th>报销负责人</th><td>{{ state.meta.leader || '—' }}</td></tr>
          <tr><th>队名</th><td>{{ state.teamName || '—' }}</td></tr>
          <tr>
            <th>参赛同学</th>
            <td>
              <span v-if="state.members.length">
                {{ state.members.map((m) => `${m.name} ${m.card}`).join('；') }}
              </span>
              <span v-else class="hint" style="margin: 0">（未录入，到「同学清单」页添加）</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>二、材料打包明细</h3>
      <div v-for="g in groupsView" :key="g.id" class="ck-section">
        <div class="ck-title">{{ g.name }}</div>
        <p v-if="!g.legs.length" class="hint" style="padding-left: 14px; margin: 0">（未添加行程段）</p>
        <div v-for="leg in g.legs" :key="leg.id" style="padding-left: 14px; font-size: 14px">
          {{ leg.title }}
          <div v-for="f in leg.files" :key="f.id" style="padding-left: 16px; color: var(--muted)">
            · {{ f.fileName }}{{ f.scope ? `（${f.scope}）` : '' }}{{ f.amount ? ` ¥${f.amount}` : '' }} → {{ f.members }}
          </div>
          <div v-if="!leg.files.length" class="slot-note" style="padding-left: 16px">未上传材料</div>
        </div>
      </div>

      <div v-if="state.members.length" class="ck-section">
        <div class="ck-title">队员归属检查</div>
        <table class="tbl" style="max-width: 520px">
          <thead>
            <tr><th>队员</th><th style="width: 22%">去程</th><th style="width: 22%">返程</th><th style="width: 22%">住宿发票</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in coverage" :key="c.idx">
              <td>{{ c.name }}</td>
              <td><span :class="c.outbound ? 'cov-ok' : 'cov-miss'">{{ c.outbound ? '✓' : '✗' }}</span></td>
              <td><span :class="c.back ? 'cov-ok' : 'cov-miss'">{{ c.back ? '✓' : '✗' }}</span></td>
              <td><span :class="c.invoice ? 'cov-ok' : 'cov-miss'">{{ c.invoice ? '✓' : '✗' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>三、办理流程（点击勾选）</h3>
      <div style="padding-left: 4px">
        <div
          v-for="(f, i) in FLOW"
          :key="i"
          style="font-size: 14px; cursor: pointer; padding: 2px 0"
          :title="f.d"
          @click="toggleFlow(i)"
        >
          <span :class="state.flow[i] ? 'cov-ok' : 'cov-miss'">{{ state.flow[i] ? '✓' : '○' }}</span>
          {{ f.t }}
        </div>
      </div>

      <h3>四、待办事项</h3>
      <template v-if="todos.length">
        <p>共 {{ todos.length }} 项，完成后即可联系教练办理：</p>
        <ol class="rp-todo">
          <li v-for="(t, i) in todos" :key="i">{{ t }}</li>
        </ol>
      </template>
      <p v-else class="rp-ok">全部材料已备齐，流程已完成，可以联系教练办理报销。✓</p>

      <h3>五、群内消息模板（点击复制）</h3>
      <div v-for="(m, i) in msgs" :key="i" class="rp-msg">
        <code>{{ m }}</code>
        <button class="btn btn-sm" @click="copyMsg(i)">复制</button>
      </div>

      <p class="hint" style="margin-top: 16px">
        提示：发票抬头必须为「东南大学」（税号 12100000466006770Q）；飞机仅限经济舱、高铁仅限二等座；各类报销均有时效性，材料不及时、不完整或错误将不能报销；参赛费材料由赛站汇总负责人统一收取。
      </p>
    </div>

    <div class="card">
      <h2>负责人 · 打印与预约（财务处最后阶段）</h2>
      <p class="hint" style="margin-top: 0">
        赛站汇总打包完成后的收尾流程：打印汇总扫描件 →
        <a href="https://caiwuchujf.seu.edu.cn/WFManager/home2.jsp" target="_blank" rel="noreferrer">财务系统网上填报</a>（统一身份认证登录 →
        报销单管理 → 日常报销业务，照各队 ZIP 内「报销系统填写对照单.txt」逐字段填写）→ 预约报销时间并上传预约报销单 → 抬头总检 → 合成完整材料打印文档。
      </p>

      <div class="ck-section">
        <div class="ck-title">预约报销时间</div>
        <div class="btn-row" style="align-items: center">
          <input
            v-model="state.meta.appointmentTime"
            type="text"
            placeholder="如：11-28（周五） 14:00 财务处办事大厅"
            style="flex: 1; min-width: 220px"
          />
          <button class="btn btn-sm" @click="copyText(state.meta.appointmentTime).then(() => showToast('已复制'))" :disabled="!state.meta.appointmentTime">
            复制
          </button>
        </div>
        <p class="hint" style="margin-bottom: 0">填好后复制发参赛队员群同步；此栏随本机自动保存。</p>
      </div>

      <div class="ck-section">
        <div class="ck-title">抬头总检（所有发票抬头必须为「东南大学」）</div>
        <div class="btn-row" style="align-items: center">
          <button class="btn btn-primary btn-sm" :disabled="headerChecking" @click="runHeaderCheck">
            {{ headerChecking ? '检查中…' : '扫各队核对报告' }}
          </button>
          <span v-if="headerResults.length" class="hint" style="margin: 0">
            {{ headerResults.filter((r) => r.issues.length || !r.hasReport).length ? '存在待处理项 ↓' : '全部通过 ✓' }}
          </span>
        </div>
        <table v-if="headerResults.length" class="tbl" style="max-width: 640px; margin-top: 8px">
          <thead>
            <tr><th>队伍</th><th style="width: 18%">已检查</th><th>结果</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in headerResults" :key="r.team">
              <td>{{ r.team }}</td>
              <td>{{ r.checked == null ? '—' : r.checked + ' 张' }}</td>
              <td>
                <span v-if="!r.hasReport" class="cov-miss">包内无核对报告（队长旧版打包？建议重打包）</span>
                <span v-else-if="!r.hasSection" class="cov-miss">报告未含抬头检查段（该队可能未做抬头识别，请人工核对或让队长用最新版重新导入打包）</span>
                <span v-else-if="r.issues.length" class="cov-miss">{{ r.issues.join('；') }}</span>
                <span v-else class="cov-ok">均为「东南大学」✓</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="ck-section">
        <div class="ck-title">完整材料打印文档</div>
        <div class="btn-row" style="align-items: center">
          <button class="btn btn-primary btn-sm" :disabled="printBuilding" @click="buildPrintDoc">
            {{ printBuilding ? '合成中…' : '合成完整材料打印版 PDF' }}
          </button>
          <span v-if="stationState.zips.length" class="hint" style="margin: 0">{{ stationState.zips.length }} 支队伍 + {{ stationState.efFiles.length }} 个参赛费文件</span>
        </div>
        <p class="hint" style="margin: 0">
          参赛费材料 + 每队（队名分隔页 + 包内「材料汇总」PDF，缺则用「发票汇总」，再缺则从原件现场合成）按顺序合并为一份大 PDF，打印后随预约报销单提交。
        </p>
        <div v-if="printSummary" style="font-size: 14px; padding: 8px 2px 0">
          <div>共 {{ printSummary.pages }} 页 · {{ printSummary.teams.map((t) => `${t.team} ${t.pages}页(${t.source})`).join('，') }}</div>
          <div v-for="(w, i) in printSummary.warnings" :key="i" style="color: var(--warn, #b45309)">⚠ {{ w }}</div>
        </div>
      </div>
    </div>
  </section>
</template>
