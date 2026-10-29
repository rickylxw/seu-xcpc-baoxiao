<script setup>
/* 完全向导模式：默认入口。未选角色时显示角色选择瓦片；选后按角色走分步步骤条。
   每个步骤只显示与之相关的卡片（show 为 h2 标题子串清单；空 = 不过滤），
   由 MutationObserver 在页签内容变化时自动重新应用。 */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { state, pkg, ui, wizard, filesUi, showToast } from '../store'
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
      {
        key: 'l0', tab: 'overview', title: '先收齐两样东西', hint: '开始前先向各队队长收齐打包材料',
        show: ['快速上手'],
        guide: [
          { t: '各队 ZIP', d: '队长们在「材料打包」页打包的队伍材料包（内含该队同学清单与核对报告）' },
          { t: '参赛费材料', d: '参赛费发票、支付记录、邀请函（由负责人统一收取）' },
        ],
      },
      {
        key: 'l1', tab: 'files', title: '导入各队 ZIP', hint: '在「赛站汇总（负责人）」模式下导入各队 ZIP；自动提取每队名单与待办清单', scrollTo: '参赛费', filesMode: 'station', show: ['参赛费材料'],
        guide: [
          { t: '导入', d: '拖入或选择各队 ZIP；自动解包、按队归档' },
          { t: '自动提取名单', d: '各队 ZIP 内的同学清单自动解析，可一键汇总进「同学清单」' },
          { t: '自动提取待办', d: '各队核对报告的待办事项自动列出，逐项跟进' },
        ],
      },
      {
        key: 'l2', tab: 'members', title: '核对同学名单', hint: '各队名单已自动汇总，核对补漏（缺卡号 / 重名在这里处理）',
        guide: [
          { t: '自动汇总', d: '来自各队 ZIP 的名单已合并进清单，按一卡通号去重' },
          { t: '补漏', d: '未收录的同学手动补录；确认无误后用于审批单出差人' },
        ],
      },
      {
        key: 'l3', tab: 'approval', title: '填写差旅审批单', hint: '名单定稿后填写：出差人名单取自同学清单，起讫日期取自行程信息',
        guide: [
          { t: '自动带出', d: '出差人名单取自同学清单，起讫日期取自行程信息' },
          { t: '生成 docx', d: '按学校模板生成标准 Word 文件，下载打印签字' },
          { t: '顺序说明', d: '名单以收齐各队 ZIP 后的最终版为准，故审批单放在导入与核对之后' },
        ],
      },
      {
        key: 'l4', tab: 'files', title: '打包赛站总包', hint: '全部就绪后打包赛站总包（每队文件夹 + 参赛费 + 汇总说明）', scrollTo: '参赛费', filesMode: 'station', show: ['参赛费材料'],
        guide: [
          { t: '打包', d: '点「打包下载赛站汇总 ZIP」生成总包' },
          { t: '提交', d: '按注意事项流程对接教练 / 财务' },
        ],
      },
      {
        key: 'l5', tab: 'report', title: '核对报告与报销流程', hint: '待办事项清零后，按「报销办理流程」四步推进',
        guide: [
          { t: '待办清零', d: '缺材料、归属、金额问题都汇总在报告待办里，处理完一项勾一项' },
          { t: '对外同步', d: '可打印报告，或复制群消息模板发参赛队员群' },
        ],
      },
    ]
  }
  return [
    {
      key: 'c1', tab: 'overview', title: '填写行程信息', hint: '比赛名称、日期、出发城市与到达城市（起讫地自动勾选会用到）', show: ['本次行程信息', '关键信息'],
      guide: [
        { t: '比赛名称与日期', d: '如「CCPC 2026 长春站」；比赛日期与返宁日期用于审批单与提交时限提示' },
        { t: '出发城市 → 所到城市', d: '如 南京 → 长春：识别材料起讫地后自动勾选去程 / 返程' },
        { t: '报销负责人', d: '本次统一汇总报销的同学姓名' },
      ],
    },
    {
      key: 'c2', tab: 'files', title: '批量导入材料', hint: '在「批量导入」卡一次选入全套材料或整个文件夹，自动分类到槽位；文件名含「去程 / 返程」会自动勾好', show: ['队伍信息', '批量导入', '识别方式', '往返交通', '赛站住宿'], scrollTo: '批量导入',
      guide: [
        { t: '一次导入', d: '点「选择材料文件夹」整包导入；按文件名关键词自动分类（机票发票 / 机票支付 / 酒店发票 / 酒店流水 / 火车票…）' },
        { t: '文件名带「去程 / 返程」', d: '导入时直接勾好范围；没带的关键词也能靠材料里的起讫地自动识别' },
        { t: '图片自动识别', d: '金额、归属队员、抬头、开票方 / 收款方自动预填；识别不到的手动补' },
      ],
    },
    {
      key: 'c3', tab: 'files', title: '逐段核对', hint: '补齐缺的必附材料，逐段核对每个文件的金额、归属队员、去 / 返程勾选', show: ['往返交通', '赛站住宿', '材料准备进度'], scrollTo: '材料准备进度',
      guide: [
        { t: '补缺必附', d: '行程段里缺的必附材料会在槽位处标注，缺什么传什么' },
        { t: '识别结果抽查', d: '批量导入最大的坑是识别错：逐条对照原件核对金额与归属；识别失败的文件槽位有标注，可重新上传或手动填写' },
        { t: '逐文件核对', d: '每个文件：金额对不对、归属队员全不全、去 / 返程勾对没有' },
        { t: '看进度表', d: '「材料准备进度」按人检查去程 / 返程 / 住宿发票，缺的人名直接列出' },
      ],
    },
    {
      key: 'c4', tab: 'files', title: '收付款核对', hint: '有发票 + 支付的行程段：核对开票方与收款方一致，不一致填说明（可请酒店开证明）', show: ['往返交通', '赛站住宿'], scrollTo: '收付款核对',
      guide: [
        { t: '自动预填', d: '识别出的发票开票方与支付收款方已填入核对区，人工确认修改' },
        { t: '一致 → 勾选', d: '同一单位就勾「核对一致」' },
        { t: '不一致 → 填说明', d: '如平台代订导致收款方不同：填情况说明，可请酒店开具证明；打包自动附说明书' },
      ],
    },
    {
      key: 'c5', tab: 'files', title: '打包 ZIP', hint: '确认无遗漏后点「打包下载队伍 ZIP」，发给报销负责人', show: ['材料准备进度', '合并与打包'], scrollTo: '合并与打包',
      guide: [
        { t: '先看进度', d: '「材料准备进度」归属全部打勾再打包' },
        { t: '打包', d: '点「打包下载队伍 ZIP」：确认链会逐项提醒缺漏与不一致，自动附说明文件' },
        { t: '上交', d: '把 ZIP 发给报销负责人，由其汇总打包并对接教练 / 财务' },
      ],
    },
  ]
})

const stepIndex = computed(() => Math.min(wizard.step || 0, steps.value.length - 1))
const current = computed(() => steps.value[stepIndex.value])

const doneChecks = computed(() => {
  // 三态：true 已完成 / false 未完成 / null 尚未开始（前置条件未满足）
  if (wizard.role === 'member') {
    return { m1: null, m2: null, m3: wizard.memberDone === true }
  }
  if (wizard.role === 'leader') {
    return {
      l0: null,
      l1: state.members.length > 0, // 导入各队 ZIP 后名单自动汇总
      l2: state.members.length > 0,
      l3: state.approval.done === true,
      l4: null, // 打包是手动动作
      l5: null,
    }
  }
  const hasMaterials = pkg.legs.some((l) => l.files.length)
  const hasInv = pkg.legs.some((l) => l.files.some((f) => ['f_invoice', 'h_invoice'].includes(f.slot)))
  const hasPay = pkg.legs.some((l) => l.files.some((f) => ['f_pay', 'h_pay'].includes(f.slot)))
  return {
    c1: !!(state.meta.contest && state.meta.dateReturn),
    c2: hasMaterials,
    c3: !hasMaterials ? null : missingRequired().length === 0 && coverageGaps().length === 0,
    c4: !hasInv || !hasPay ? null : payCheckIssues().length === 0,
    c5: null, // 打包是手动动作
  }
})

/* ---- 步骤卡片过滤（P1 修复版）：不改卡片内联样式 —— 给 main 挂/摘 wizard-filtering
   class，配合 CSS 隐藏非本步卡片；**仅在当前步骤所属页签生效**（ui.tab 门禁，
   防止过滤泄漏到其它页签导致空白页）；退出向导 / 切换角色时摘掉 class 即全部恢复 ---- */
function applyCardFilter() {
  const main = document.querySelector('main')
  if (!main) return
  const active =
    wizard.enabled && !!wizard.role && (current.value.show?.length > 0) && ui.tab === current.value.tab
  main.classList.toggle('wizard-filtering', active)
  if (!active) {
    for (const card of main.querySelectorAll('.card[data-wkeep]')) card.removeAttribute('data-wkeep')
    return
  }
  for (const card of main.querySelectorAll('.card')) {
    const title = card.querySelector('h2')?.textContent || ''
    const keep = (current.value.show || []).some((t) => title.includes(t))
    if (keep) card.setAttribute('data-wkeep', '')
    else card.removeAttribute('data-wkeep')
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
  if (current.value.filesMode) filesUi.mode = current.value.filesMode
  applyCardFilter()
  watchCards()
  const sel = current.value.scrollTo
  if (!sel) return
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('main .card')].find(
      (c) => c.getAttribute('data-wkeep') !== null && c.querySelector('h2')?.textContent.includes(sel),
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
  applyCardFilter()
}
function setStep(i) {
  wizard.step = i
  applyStep()
}
function next() {
  const key = current.value.key
  if (!wizard.done.includes(key)) wizard.done.push(key) // 已走过的步骤保留 ✓ 标记
  if (stepIndex.value < steps.value.length - 1) setStep(stepIndex.value + 1)
}
function prev() {
  if (stepIndex.value > 0) setStep(stepIndex.value - 1)
}
function exitWizard() {
  wizard.enabled = false
  applyCardFilter() // 摘掉过滤 class，恢复全部卡片显示
}

watch(
  () => [wizard.enabled, wizard.role, wizard.step],
  () => {
    if (wizard.enabled && wizard.role) applyStep()
  },
  { immediate: true },
)

// 页签切换 / 自由跳转时同步过滤状态（ui.tab 门禁：离开本步页签即恢复全部卡片）
watch(
  () => ui.tab,
  () => applyCardFilter(),
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
        需部署形态（node server.js）才提供 <code>/api/agent</code> 与 MCP 接口。
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
      不同角色请各自使用自己的电脑 / 浏览器操作（填写内容存在本机，会互相覆盖）。
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
        :class="{ current: i === stepIndex, done: i < stepIndex || wizard.done.includes(s.key) }"
        @click="setStep(i)"
      >
        <span class="wiz-num">{{ i < stepIndex || wizard.done.includes(s.key) ? '✓' : i + 1 }}</span>{{ s.title }}
      </li>
    </ol>
    <div class="wiz-body">
      <b>{{ current.title }}</b>
      <span class="hint" style="margin: 0">{{ current.hint }}</span>
      <span v-if="doneChecks[current.key] === true" class="wiz-ok">已完成</span>
      <span v-else-if="doneChecks[current.key] === false" class="wiz-todo">本步未完成（可先跳过，打包前请回来处理）</span>
      <span v-else-if="doneChecks[current.key] === null" class="wiz-todo">尚未开始</span>
      <label v-if="current.key === 'm3'" class="mem-chk wiz-confirm">
        <input type="checkbox" v-model="wizard.memberDone" />确认已把材料交给队长
      </label>
      <span style="flex: 1"></span>
      <button type="button" class="btn btn-sm" :disabled="stepIndex === 0" @click="prev">上一步</button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="stepIndex === steps.length - 1" @click="next">下一步</button>
    </div>
  </div>

  <!-- 本步操作指引卡（队长 / 负责人步骤配置了 guide 时显示，位于内容区顶部） -->
  <div v-if="wizard.enabled && wizard.role && current.guide" class="card wiz-guide no-print">
    <h2>「{{ current.title }}」这一步怎么做</h2>
    <ol class="wiz-guide-list">
      <li v-for="(g, gi) in current.guide" :key="gi">
        <b>{{ g.t }}</b>
        <span>{{ g.d }}</span>
      </li>
    </ol>
  </div>
</template>
