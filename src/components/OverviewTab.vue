<script setup>
import { computed } from 'vue'
import { state, FLOW, showToast } from '../store'
import { copyText, fmtDateCN } from '../utils/misc'

const TAX_TEXT = '单位名称：东南大学\n税务识别号：12100000466006770Q'

const deadline = computed(() => {
  if (!state.meta.dateReturn) return '填写「返宁日期」后，自动计算建议提交时间。'
  const d = new Date(state.meta.dateReturn + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return `建议提交时间：${fmtDateCN(d)}晚上前（返宁后 1 天内整理好全部报销材料并发给负责人）。`
})

async function copyTax() {
  await copyText(TAX_TEXT)
  showToast('抬头与税号已复制')
}
</script>

<template>
  <section id="tab-overview" class="tab-pane">
    <div class="grid-2">
      <div class="card">
        <h2>本次行程信息</h2>
        <p class="hint">填写后，清单、报告与打包文件名会自动带上这些信息。数据只保存在本机浏览器中。</p>
        <div class="form-grid">
          <label class="field">
            <span>比赛名称</span>
            <input v-model="state.meta.contest" placeholder="如：ICPC 2026 南京站" />
          </label>
          <label class="field">
            <span>比赛日期</span>
            <input v-model="state.meta.dateContest" type="date" />
          </label>
          <label class="field">
            <span>返宁日期</span>
            <input v-model="state.meta.dateReturn" type="date" />
          </label>
          <label class="field">
            <span>报销负责人</span>
            <input v-model="state.meta.leader" placeholder="负责汇总报销的同学姓名" />
          </label>
          <label class="field">
            <span>所到省份、城市（用于差旅审批单）</span>
            <input v-model="state.approval.place" placeholder="如：江苏省 南京市" />
          </label>
          <label class="field">
            <span>所到单位（用于差旅审批单）</span>
            <input v-model="state.approval.unit" placeholder="如：赛站承办高校" />
          </label>
        </div>
        <p class="deadline">{{ deadline }}</p>
      </div>
      <div class="card">
        <h2>关键信息（摘自注意事项）</h2>
        <div class="kv-card">
          <div class="kv-title">发票抬头与税号（所有可修改抬头的发票，抬头必须为「东南大学」）</div>
          <div class="kv-line">单位名称：<b>东南大学</b></div>
          <div class="kv-line">税务识别号：<b>12100000466006770Q</b></div>
          <button class="btn btn-sm" @click="copyTax">复制抬头与税号</button>
        </div>
        <div class="notice amber">
          <b>报销等级：</b>飞机仅限经济舱；高铁仅限二等座。住宿每晚标准可向财务查询，超出标准的部分不能报销。
        </div>
        <div class="notice red">
          <b>注意报销时效：</b>各类报销均有时效性。材料提交不及时、不完整或错误，将不能报销。建议返宁后 1
          天内整理好全部材料。
        </div>
      </div>
    </div>

    <div class="card">
      <h2>报销办理流程</h2>
      <p class="hint">四步依次勾选，未完成的步骤会出现在「核对报告」的待办事项里。</p>
      <div v-for="(f, i) in FLOW" :key="i" class="flow-item" :class="{ done: state.flow[i] }">
        <div class="num">{{ i + 1 }}</div>
        <div class="flow-body">
          <div class="ck-label">{{ f.t }}</div>
          <div class="ck-note">{{ f.d }}</div>
        </div>
        <label class="flow-check">
          <input v-model="state.flow[i]" type="checkbox" />
          完成
        </label>
      </div>
    </div>
  </section>
</template>
