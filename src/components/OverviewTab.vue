<script setup>
import { computed } from 'vue'
import { state, ui, FLOW, showToast } from '../store'
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
    <div class="card quickstart no-print">
      <h2>快速上手 · 先看我</h2>
      <div class="qs-grid">
        <div class="qs-col">
          <div class="qs-role">我是队员</div>
          <ol class="qs-steps">
            <li><b>存好材料</b>：发票、支付截图、机票订单 / 行程单、酒店流水，拍照或截图保存。</li>
            <li><b>交给队长</b>：本队所有支付统一由队长承担，个人勿垫付后再报销。</li>
            <li><b>配合核对</b>：确认队长录入的归属、金额与自己的实际花费一致。</li>
          </ol>
        </div>
        <div class="qs-col">
          <div class="qs-role">我是队长</div>
          <ol class="qs-steps">
            <li><b>统一支付</b>：本队全部费用由你一人支付，购票勿勾选保险，索取发票与支付凭证。</li>
            <li><b>导入核对</b>：在「材料打包」页批量导入自动分类，核对金额、归属队员、去 / 返程和收付款一致。</li>
            <li><b>打包上交</b>：点「打包下载队伍 ZIP」，连同参赛费材料一起交报销负责人。</li>
          </ol>
          <button type="button" class="btn btn-primary btn-sm" @click="ui.tab = 'files'">去材料打包 →</button>
        </div>
        <div class="qs-col">
          <div class="qs-role">我是报销负责人</div>
          <ol class="qs-steps">
            <li><b>赛前</b>：在「同学清单」录全部参赛同学一卡通号。</li>
            <li><b>汇总</b>：收齐各队 ZIP，填「差旅审批单」，用「赛站汇总」打包全部队伍和参赛费材料。</li>
            <li><b>跟进</b>：按下方「报销办理流程」四步推进，未完成项会出现在「核对报告」。</li>
          </ol>
          <div class="qs-btns">
            <button type="button" class="btn btn-sm" @click="ui.tab = 'members'">同学清单 →</button>
            <button type="button" class="btn btn-sm" @click="ui.tab = 'approval'">差旅审批单 →</button>
          </div>
        </div>
      </div>
      <p class="hint" style="margin: 12px 0 0">
        常见漏项：酒店流水、机票订单、行程单、参赛费支付记录；购票勿勾选保险；住宿发票盖章单位需与支付收款方一致（不一致找酒店开证明）。
      </p>
    </div>
    <div class="grid-2">
      <div class="card">
        <h2>本次行程信息</h2>
        <p class="hint">队长 / 报销负责人填写（队员可跳过）。填写后，清单、报告与打包文件名会自动带上这些信息。数据只保存在本机浏览器中。</p>
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
            <span>出发城市（自动识别去程 / 返程用）</span>
            <input v-model="state.meta.homeCity" placeholder="如：南京" />
          </label>
          <label class="field">
            <span>所到省份、城市（用于差旅审批单）</span>
            <input v-model="state.approval.place" placeholder="如：吉林省 长春市" />
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
      <h2>报销办理流程<span class="qs-who">（队长 / 报销负责人跟进）</span></h2>
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
