<script setup>
/* 完全向导模式：默认入口。未选角色时显示角色选择瓦片；选后按角色走分步步骤条 */
import { computed, watch } from 'vue'
import { state, pkg, ui } from '../store'
import { missingRequired, coverageGaps, payCheckIssues } from '../data/packaging'

const ROLES = {
  member: { name: '队员', desc: '保存好材料交给队长，不用管打包的事' },
  captain: { name: '队长', desc: '统一支付并收齐本队材料，导入核对后打包上交' },
  leader: { name: '报销负责人', desc: '收各队 ZIP，录名单、填审批单、赛站汇总并跑流程' },
}

const steps = computed(() => {
  if (state.wizard.role === 'member') {
    return [
      { key: 'm1', tab: 'overview', title: '了解要交什么', hint: '看本页「关键信息」与常见漏项：保存好发票、支付截图、机票订单 / 行程单、酒店流水等材料原件' },
      { key: 'm2', tab: 'overview', title: '交给队长', hint: '本队所有支付统一由队长承担，个人勿垫付；把材料交给队长，由队长统一导入本工具' },
      { key: 'm3', tab: 'overview', title: '完成', hint: '后续导入与核对由队长完成；如发现归属或金额有误，及时提醒队长修改' },
    ]
  }
  if (state.wizard.role === 'leader') {
    return [
      { key: 'l1', tab: 'members', title: '录入同学清单', hint: '收齐各队参赛同学一卡通号后录入，用于归属核对与清单导出' },
      { key: 'l2', tab: 'approval', title: '填写差旅审批单', hint: '报销负责人填写一次，随赛站汇总材料提交' },
      { key: 'l3', tab: 'files', title: '赛站汇总打包', hint: '在「材料打包」页切到「赛站汇总（负责人）」模式，导入各队 ZIP 与参赛费材料后打包', scrollTo: '赛站汇总' },
      { key: 'l4', tab: 'report', title: '核对报告与报销流程', hint: '待办事项清零后，按「报销办理流程」四步推进' },
    ]
  }
  return [
    { key: 'c1', tab: 'overview', title: '填写行程信息', hint: '比赛名称、日期、出发城市与到达城市（起讫地自动勾选会用到）', scrollTo: '本次行程信息' },
    { key: 'c2', tab: 'files', title: '批量导入材料', hint: '在下方「批量导入」卡一次选入全套材料或整个文件夹，自动分类到槽位；文件名含「去程 / 返程」会自动勾好', scrollTo: '批量导入' },
    { key: 'c3', tab: 'files', title: '逐段核对', hint: '补齐缺的必附材料，逐段核对每个文件的金额、归属队员、去 / 返程勾选', scrollTo: '材料准备进度' },
    { key: 'c4', tab: 'files', title: '收付款核对', hint: '有发票 + 支付的行程段：核对开票方与收款方一致，不一致填说明', scrollTo: '收付款核对' },
    { key: 'c5', tab: 'files', title: '打包 ZIP', hint: '确认「材料准备进度」无遗漏后，点「打包下载队伍 ZIP」发给报销负责人', scrollTo: '合并与打包' },
  ]
})

const stepIndex = computed(() => Math.min(state.wizard.step || 0, steps.value.length - 1))
const current = computed(() => steps.value[stepIndex.value])

const doneChecks = computed(() => {
  if (state.wizard.role !== 'captain') return {}
  return {
    c1: !!(state.meta.contest && state.meta.dateReturn),
    c2: pkg.legs.some((l) => l.files.length),
    c3: missingRequired().length === 0 && coverageGaps().length === 0,
    c4: payCheckIssues().length === 0,
    c5: false, // 打包是手动动作，无完成态
  }
})

function applyStep() {
  ui.tab = current.value.tab
  const sel = current.value.scrollTo
  if (!sel) return
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent.includes(sel))
    card?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}

function chooseRole(role) {
  state.wizard.role = role
  state.wizard.step = 0
  applyStep()
}
function rechoose() {
  state.wizard.role = ''
}
function setStep(i) {
  state.wizard.step = i
  applyStep()
}
function next() {
  if (stepIndex.value < steps.value.length - 1) setStep(stepIndex.value + 1)
}
function prev() {
  if (stepIndex.value > 0) setStep(stepIndex.value - 1)
}
function exitWizard() {
  state.wizard.enabled = false
}

watch(
  () => [state.wizard.enabled, state.wizard.role],
  ([on, role]) => {
    if (on && role) applyStep()
  },
  { immediate: true },
)
</script>

<template>
  <!-- 未选角色：角色选择瓦片 -->
  <div v-if="!state.wizard.role" class="card wiz-choose no-print">
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
    <p class="hint" style="margin: 12px 0 0">
      更熟悉本工具的同学可以
      <a href="javascript:;" @click="exitWizard">退出向导使用自由模式</a>。
    </p>
  </div>

  <!-- 已选角色：分步步骤条 -->
  <div v-else class="wizard-bar no-print">
    <div class="wiz-head">
      <span class="wiz-title">向导模式 · {{ ROLES[state.wizard.role]?.name || '队长' }}</span>
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
