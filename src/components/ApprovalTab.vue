<script setup>
import { computed } from 'vue'
import { state, ui, showToast } from '../store'
import { downloadBlob } from '../utils/misc'
import {
  approvalView,
  buildApprovalDocxBlob,
  PERSON_TYPES,
} from '../data/approval'

const a = state.approval
const v = computed(() => approvalView())

function printForm() {
  ui.printTarget = 'approval'
  setTimeout(() => window.print(), 50)
}

function downloadDoc() {
  const name = `差旅审批单-${state.meta.contest || '未命名'}.docx`.replace(/[\\/:*?"<>|]/g, '-')
  downloadBlob(buildApprovalDocxBlob(), name)
  showToast('已生成标准 .docx，可用 Word / WPS 打开微调后打印')
}

const mark = (on) => (on ? '☑' : '□')
</script>

<template>
  <section id="tab-approval" class="tab-pane">
    <div class="card no-print">
      <h2>审批单填写内容</h2>
      <p class="hint">
        按模板《东南大学公务出差财务核算审批单》生成；出差人名单取自「同学清单」，起讫日期取自行程信息。
        <b>差旅审批单只需负责人填写一次</b>，会随赛站汇总包统一提交，队伍 ZIP 中不包含。
      </p>
      <div class="form-grid">
        <label class="field">
          <span>填表日期（留空 = 今天）</span>
          <input v-model="a.fillDate" :placeholder="v.fillDate" />
        </label>
        <label class="field">
          <span>出差人类型</span>
          <select v-model="a.personType">
            <option v-for="t in PERSON_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <label class="field">
          <span>出差事由（留空 = 参加 + 比赛名称）</span>
          <input v-model="a.reason" :placeholder="state.meta.contest ? '参加' + state.meta.contest : '如：参加 ICPC 2026 南京站'" />
        </label>
        <label class="field">
          <span>所到省份、城市</span>
          <input v-model="a.place" placeholder="如：江苏省 南京市" />
        </label>
        <label class="field">
          <span>所到单位</span>
          <input v-model="a.unit" placeholder="如：南京××大学 / 赛站承办高校" />
        </label>
        <label class="field">
          <span>项目经费（按注意事项：填写报销文档前先与教练联系）</span>
          <input v-model="a.funding" placeholder="留空则显示模板提示语" />
        </label>
        <label class="field">
          <span>出差人职务/职称级别</span>
          <input v-model="a.rank" placeholder="学生" />
        </label>
        <label class="field">
          <span>特殊事项备注（可留空）</span>
          <input v-model="a.note" placeholder="如：无" />
        </label>
      </div>

      <div class="field" style="margin-top: 6px">
        <span>乘坐的交通工具及等级（按实际勾选）</span>
        <div class="check-line">
          <label><input v-model="a.trainRide" type="checkbox" /> 高铁二等座</label>
          <label><input v-model="a.flightRide" type="checkbox" /> 飞机经济舱</label>
          <label class="inline-input">其他：<input v-model="a.otherRide" placeholder="如：动车一等座（一般不符合等级）" /></label>
        </div>
      </div>

      <div class="form-grid" style="margin-top: 10px">
        <label class="field">
          <span>是否符合规定的乘坐等级</span>
          <select v-model="a.rideOk">
            <option :value="true">是</option>
            <option :value="false">否</option>
          </select>
        </label>
        <label class="field">
          <span>住宿费</span>
          <select v-model="a.hotelOption">
            <option value="standard">按标准限额据实报销</option>
            <option value="over">超标准自理</option>
          </select>
        </label>
        <label v-if="a.hotelOption === 'over'" class="field">
          <span>超标准自理金额（元）</span>
          <input v-model="a.hotelOver" type="number" step="0.01" min="0" placeholder="0.00" />
        </label>
        <label class="field">
          <span>伙食补助费</span>
          <select v-model="a.mealOption">
            <option value="none">不领取补贴</option>
            <option value="package">按包干标准直接领取</option>
          </select>
        </label>
        <label class="field">
          <span>市内交通费</span>
          <select v-model="a.cityOption">
            <option value="none">不领取补贴</option>
            <option value="package">按包干标准领取</option>
            <option value="actual">按规定据实报销</option>
          </select>
        </label>
      </div>

      <div class="check-line" style="margin-top: 12px">
        <label><input v-model="a.done" type="checkbox" /> <b>负责人已填写/核对完成审批单</b>（勾选后不再出现在核对报告待办）</label>
      </div>
    </div>

    <div class="card">
      <div class="row-between no-print">
        <h2>预览（A4）</h2>
        <div class="btn-row" style="margin: 0">
          <button class="btn btn-primary" @click="printForm">🖨 打印审批单</button>
          <button class="btn" @click="downloadDoc">下载 Word（.docx）</button>
        </div>
      </div>

      <div class="ap-wrap">
        <div class="ap-title">东南大学公务出差财务核算审批单</div>
        <div class="ap-date">{{ v.fillDate }}</div>
        <div class="ap-stamp">单位（公章）：</div>
        <table class="ap-table">
          <colgroup>
            <col style="width: 22.4%" /><col style="width: 27.7%" /><col style="width: 19.3%" /><col style="width: 30.6%" />
          </colgroup>
          <tbody>
            <tr>
              <td class="lb vc">出差人姓名</td>
              <td>
                <div v-for="(m, i) in state.members" :key="i" class="ap-member">{{ m.card }} {{ m.name }}</div>
                <div v-if="!state.members.length" class="ap-empty">尚未录入，请到「同学清单」页添加</div>
              </td>
              <td class="lb vc">出差人类型</td>
              <td>
                <div v-for="t in PERSON_TYPES" :key="t">{{ mark(a.personType === t) }}{{ t }}</div>
              </td>
            </tr>
            <tr>
              <td class="lb">出差起讫日期</td>
              <td>{{ v.range || '—' }}</td>
              <td class="lb vc" rowspan="2">出差事由</td>
              <td rowspan="2">{{ v.reason || '—' }}</td>
            </tr>
            <tr>
              <td class="lb">所到省份、城市</td>
              <td>{{ v.place || '—' }}</td>
            </tr>
            <tr>
              <td class="lb">所到单位</td>
              <td>{{ v.unit || '—' }}</td>
              <td class="lb">项目经费</td>
              <td>{{ v.funding }}</td>
            </tr>
            <tr>
              <td class="lb">出差人职务/职称级别</td>
              <td>{{ v.rank }}</td>
              <td class="lb vc" rowspan="2">是否符合规定的乘坐等级</td>
              <td class="vc" rowspan="2">{{ v.rideOkText }}</td>
            </tr>
            <tr>
              <td class="lb">乘坐的交通工具及等级</td>
              <td>
                <div v-for="(r, i) in v.rides" :key="i">{{ r }}</div>
                <div v-if="!v.rides.length" class="ap-empty">请至少勾选一种交通工具</div>
              </td>
            </tr>
            <tr>
              <td class="lb">住宿费</td>
              <td colspan="3">{{ v.hotelText }}</td>
            </tr>
            <tr>
              <td class="lb">伙食补助费</td>
              <td colspan="3">{{ v.mealText }}</td>
            </tr>
            <tr>
              <td class="lb">市内交通费</td>
              <td colspan="3">{{ v.cityText }}</td>
            </tr>
            <tr>
              <td class="lb">项目负责人审核意见</td>
              <td colspan="3" class="ap-tall vc">意见：　　　　　　　签名：</td>
            </tr>
            <tr>
              <td class="lb">特殊事项备注</td>
              <td colspan="3">{{ v.note || '　' }}</td>
            </tr>
            <tr>
              <td colspan="4" class="ap-subhead">公务出差租车（自驾车）的审批：</td>
            </tr>
            <tr>
              <td class="lb">单位负责人审批意见</td>
              <td colspan="3" class="ap-tall vc">意见：　　　　　　　签名：</td>
            </tr>
          </tbody>
        </table>
        <div class="ap-notes">
          <p>说明：1. 如出差人为多人且乘坐交通工具类型、等级、住宿费、伙食补助费、市内交通费报销选择有差异的请分别造表填报；请在相应选项后的□内打√或在备注中说明。</p>
          <p>　2. 公务接待的餐费报销按照公务接待的相关规定办理，异地公务接待的餐费、公务用车费报销和差旅费一并办理报销。</p>
          <p>　3. 公务出差租车的，按照《东南大学公务用车费核算管理办法（暂行）》办理，由单位负责人在《东南大学公务出差财务核算审批单》上单独审签，公务出差为租车前往的，不得领取交通补助费。</p>
          <p>　4. 经相关负责人批准的《东南大学公务出差财务核算审批单》是差旅费财务报销的依据之一。公务出差审批需一事一批、一事一结。</p>
        </div>
      </div>
    </div>
  </section>
</template>
