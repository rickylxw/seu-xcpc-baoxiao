<script setup>
/* 完全向导模式：默认入口。未选角色时显示角色选择瓦片；选后按角色走分步步骤条。
   每个步骤只显示与之相关的卡片（show 为 h2 标题子串清单；空 = 不过滤），
   由 MutationObserver 在页签内容变化时自动重新应用。 */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { state, pkg, ui, wizard, showToast } from '../store'
import { missingRequired, coverageGaps, payCheckIssues } from '../data/packaging'

const ROLES = {
  member: { name: '队员', desc: '保存好材料交给队长，不用管打包的事' },
  captain: { name: '队长', desc: '统一支付并收齐本队材料，导入核对后打包上交' },
  leader: { name: '报销负责人', desc: '收各队 ZIP，录名单、填审批单、赛站汇总并跑流程' },
}

const steps = computed(() => {
  if (wizard.role === 'member') {
    return [
      { key: 'm1', tab: 'overview', title: '要保存哪些材料', hint: '对照下方清单逐项检查你的材料，都保存好原件或截图', show: ['队员 · 需要保存的材料', '关键信息'] },
      { key: 'm2', tab: 'overview', title: '交给队长', hint: '按下方的交法把材料交给队长，由队长统一导入本工具核对', show: ['队员 · 如何交给队长'] },
      { key: 'm3', tab: 'overview', title: '完成', hint: '队长导入核对时如发现归属或金额有误，会找你确认；有遗漏现在补还来得及', show: ['队员 · 需要保存的材料', '队员 · 如何交给队长'] },
    ]
  }
  if (wizard.role === 'leader') {
    return [
      { key: 'l1', tab: 'members', title: '录入同学清单', hint: '收齐各队参赛同学一卡通号后录入，用于归属核对与清单导出' },
      { key: 'l2', tab: 'approval', title: '填写差旅审批单', hint: '报销负责人填写一次，随赛站汇总材料提交' },
      { key: 'l3', tab: 'files', title: '赛站汇总打包', hint: '切到「赛站汇总（负责人）」模式，导入各队 ZIP 与参赛费材料后打包', scrollTo: '参赛费' },
      { key: 'l4', tab: 'report', title: '核对报告与报销流程', hint: '待办事项清零后，按「报销办理流程」四步推进' },
    ]
  }
  return [
    { key: 'c1', tab: 'overview', title: '填写行程信息', hint: '比赛名称、日期、出发城市与到达城市（起讫地自动勾选会用到）', show: ['本次行程信息', '关键信息'] },
    { key: 'c2', tab: 'files', title: '批量导入材料', hint: '在「批量导入」卡一次选入全套材料或整个文件夹，自动分类到槽位；文件名含「去程 / 返程」会自动勾好', show: ['队伍信息', '批量导入', '识别方式', '往返交通', '赛站住宿'], scrollTo: '批量导入' },
    { key: 'c3', tab: 'files', title: '逐段核对', hint: '补齐缺的必附材料，逐段核对每个文件的金额、归属队员、去 / 返程勾选', show: ['往返交通', '赛站住宿', '材料准备进度'], scrollTo: '材料准备进度' },
    { key: 'c4', tab: 'files', title: '收付款核对', hint: '有发票 + 支付的行程段：核对开票方与收款方一致，不一致填说明（可请酒店开证明）', show: ['往返交通', '赛站住宿'], scrollTo: '收付款核对' },
    { key: 'c5', tab: 'files', title: '打包 ZIP', hint: '确认无遗漏后点「打包下载队伍 ZIP」，发给报销负责人', show: ['材料准备进度', '合并与打包'], scrollTo: '合并与打包' },
  ]
})

const stepIndex = computed(() => Math.min(wizard.step || 0, steps.value.length - 1))
const current = computed(() => steps.value[stepIndex.value])

const doneChecks = computed(() => {
  if (wizard.role !== 'captain') return {}
  return {
    c1: !!(state.meta.contest && state.meta.dateReturn),
    c2: pkg.legs.some((l) => l.files.length),
    c3: missingRequired().length === 0 && coverageGaps().length === 0,
    c4: payCheckIssues().length === 0,
    c5: false, // 打包是手动动作，无完成态
  }
})

/* ---- 步骤卡片过滤：只显示当前步骤相关的卡片 ---- */
function applyCardFilter() {
  if (!wizard.enabled || !wizard.role) return
  const main = document.querySelector('main')
  if (!main) return
  const show = current.value.show || []
  for (const card of main.querySelectorAll('.card')) {
    const title = card.querySelector('h2')?.textContent || ''
    const visible = !show.length || show.some((t) => title.includes(t))
    if (card.style.display !== (visible ? '' : 'none')) card.style.display = visible ? '' : 'none'
  }
}

let cardObserver = null
function watchCards() {
  const main = document.querySelector('main')
  if (!main || cardObserver) return
  cardObserver = new MutationObserver(() => {
    // 页签内容按数据重渲染后自动恢复过滤（requestAnimationFrame 防抖）
    requestAnimationFrame(applyCardFilter)
  })
  cardObserver.observe(main, { childList: true, subtree: true })
}
onBeforeUnmount(() => cardObserver && cardObserver.disconnect())

function applyStep() {
  ui.tab = current.value.tab
  applyCardFilter()
  watchCards()
  const sel = current.value.scrollTo
  if (!sel) return
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('main .card')].find(
      (c) => c.style.display !== 'none' && c.querySelector('h2')?.textContent.includes(sel),
    )
    card?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}

function chooseRole(role) {
  wizard.role = role
  wizard.step = 0
  applyStep()
}
function rechoose() {
  wizard.role = ''
}
function setStep(i) {
  wizard.step = i
  applyStep()
}
function next() {
  if (stepIndex.value < steps.value.length - 1) setStep(stepIndex.value + 1)
}
function prev() {
  if (stepIndex.value > 0) setStep(stepIndex.value - 1)
}
function exitWizard() {
  wizard.enabled = false
}

watch(
  () => [wizard.enabled, wizard.role, wizard.step],
  () => {
    if (wizard.enabled && wizard.role) applyStep()
  },
  { immediate: true },
)

/* ---- 首页「让 AI 替我做」面板 ---- */
const showAI = ref(false)
const aiOrigin = location.origin
const aiSentence = `请打开 ${aiOrigin}/api/agent 阅读指南，然后帮我创建一个报销会话（队名 ×××，同学名单：×××），我逐个把材料文件路径发给你，你负责上传、识别核对，全部通过后打包 ZIP 给我。`
const aiMcpJson = JSON.stringify(
  { mcpServers: { 'xcpc-baoxiao': { command: 'node', args: ['<仓库路径>/mcp/mcp-server.mjs', `${aiOrigin}`] } } },
  null,
  2,
)
async function copyText(t, label) {
  try {
    await navigator.clipboard.writeText(t)
    showToast(label + ' 已复制')
  } catch {
    showToast('复制失败，请手动选择文本')
  }
}
</script>

<template>
  <!-- 未选角色：角色选择瓦片 + AI 入口 -->
  <div v-if="!wizard.role" class="card wiz-choose no-print">
    <h2>开始整理报销材料</h2>
    <p class="hint">选择你的角色，进入对应的分步向导，照着步骤走就能完成。选错了随时能在向导顶部切换。</p>
    <div class="wiz-tiles">
      <button type="button" class="wiz-tile" @click="chooseRole('member')">
        <b>我是队员</b>
        <span>{{ ROLES.member.desc }}</span>
      </button>
      <button type="button" class="wiz-tile" @click="chooseRole('captain')">
        <b>我是队长</b>
        <span>{{ ROLES.captain.desc }}</span>
      </button>
      <button type="button" class="wiz-tile" @click="chooseRole('leader')">
        <b>我是报销负责人</b>
        <span>{{ ROLES.leader.desc }}</span>
      </button>
    </div>

    <div class="wiz-tiles" style="margin-top: 14px">
      <button type="button" class="wiz-tile wiz-tile-ai" @click="showAI = !showAI">
        <b>让 AI 替我做</b>
        <span>把工具地址发给你自己的 AI（ZCode / Claude / Cursor 等），由它读指南、上传材料、逐项核对、打包 ZIP——全程不用手动操作网页</span>
      </button>
    </div>
    <div v-if="showAI" class="wiz-ai-panel">
      <p class="hint" style="margin: 0 0 6px">
        适合会用 AI 的同学：需要你的 AI 能联网执行 HTTP，或已配置下方 MCP。材料仅在部署服务器内存暂存 4 小时。
      </p>
      <div class="ai-line">
        <span>① 把这句话发给你的 AI：</span>
        <button type="button" class="btn btn-sm" @click="copyText(aiSentence, '话术')">复制</button>
      </div>
      <textarea class="ai-code" rows="3" readonly :value="aiSentence"></textarea>
      <div class="ai-line">
        <span>② 或在 MCP 客户端配置（ZCode / Claude Desktop）：</span>
        <button type="button" class="btn btn-sm" @click="copyText(aiMcpJson, 'MCP 配置')">复制</button>
      </div>
      <textarea class="ai-code" rows="5" readonly :value="aiMcpJson"></textarea>
      <p class="hint" style="margin: 6px 0 0">
        配好后对 AI 说：「用 xcpc-baoxiao 整理 D:/材料/ 里的报销材料，队名 ×××，名单：…」，它会按
        agent_guide 的流程一步步完成。
      </p>
    </div>

    <p class="hint" style="margin: 12px 0 0">
      更熟悉本工具的同学可以
      <a href="javascript:;" @click="exitWizard">退出向导使用自由模式</a>。
    </p>
  </div>

  <!-- 已选角色：分步步骤条 -->
  <div v-else class="wizard-bar no-print">
    <div class="wiz-head">
      <span class="wiz-title">向导模式 · {{ ROLES[wizard.role]?.name || '队长' }}</span>
      <button type="button" class="btn btn-sm" @click="rechoose">切换角色</button>
      <button type="button" class="btn btn-sm" @click="exitWizard">退出向导（自由模式）</button>
    </div>
    <ol class="wiz-steps">
      <li
        v-for="(s, i) in steps"
        :key="s.key"
        :class="{ current: i === stepIndex, done: i < stepIndex }"
        @click="setStep(i)"
      >
        <span class="wiz-num">{{ i < stepIndex ? '✓' : i + 1 }}</span>{{ s.title }}
      </li>
    </ol>
    <div class="wiz-body">
      <b>{{ current.title }}</b>
      <span class="hint" style="margin: 0">{{ current.hint }}</span>
      <span v-if="doneChecks[current.key] === true" class="wiz-ok">已完成</span>
      <span v-else-if="doneChecks[current.key] === false" class="wiz-todo">本步未完成（可先跳过，打包前请回来处理）</span>
      <span style="flex: 1"></span>
      <button type="button" class="btn btn-sm" :disabled="stepIndex === 0" @click="prev">上一步</button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="stepIndex === steps.length - 1" @click="next">下一步</button>
    </div>
  </div>
</template>
