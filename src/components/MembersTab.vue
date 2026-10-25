<script setup>
import { ref } from 'vue'
import { state, showToast } from '../store'
import { membersCSVString, membersText, copyText, downloadBlob } from '../utils/misc'

const bulkOpen = ref(false)
const bulkText = ref('')

function addRow() {
  state.members.push({ name: '', card: '' })
}
function delRow(i) {
  state.members.splice(i, 1)
}

/** 每行解析一位同学：自动把 6 位以上纯数字识别为一卡通号 */
function parseBulk() {
  const lines = bulkText.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let added = 0
  for (const line of lines) {
    const tokens = line.split(/[,，;；\t ]+/).map((s) => s.trim()).filter(Boolean)
    let name = ''
    let card = ''
    for (const t of tokens) {
      if (!card && /^\d{6,}$/.test(t)) card = t
      else if (!name) name = t
    }
    if (name || card) {
      state.members.push({ name, card })
      added++
    }
  }
  if (added) {
    bulkText.value = ''
    bulkOpen.value = false
    showToast(`已添加 ${added} 位同学`)
  } else {
    showToast('没有解析到有效内容')
  }
}

function downloadCSV() {
  if (!state.members.length) return showToast('请先录入同学')
  downloadBlob(new Blob([membersCSVString(state.members)], { type: 'text/csv;charset=utf-8' }), '参赛同学清单.csv')
  showToast('CSV 已下载')
}

async function copyMembers() {
  if (!state.members.length) return showToast('请先录入同学')
  await copyText(membersText(state.members))
  showToast('已复制到剪贴板')
}

function clearMembers() {
  if (!state.members.length) return
  if (confirm(`确定清空已录入的 ${state.members.length} 位同学？`)) state.members = []
}
</script>

<template>
  <section id="tab-members" class="tab-pane">
    <div class="card">
      <h2>参赛同学清单（电子文档）</h2>
      <p class="hint">
        准备本次参赛同学的一卡通号和姓名，以电子文档形式提供；预约报销单时需要填写，需事先准备好。材料清单中的此项会随录入自动标记。
      </p>
      <div class="btn-row">
        <button class="btn btn-primary" @click="addRow">＋ 添加一行</button>
        <button class="btn" @click="bulkOpen = !bulkOpen">批量粘贴</button>
        <button class="btn" @click="downloadCSV">下载 CSV</button>
        <button class="btn" @click="copyMembers">复制文本</button>
        <button class="btn btn-danger-ghost" @click="clearMembers">清空</button>
      </div>

      <div v-show="bulkOpen" class="bulk-box">
        <p class="hint">
          每行一位同学，支持「姓名 一卡通号」「一卡通号，姓名」等格式（自动把 6 位以上纯数字识别为一卡通号）。
        </p>
        <textarea
          v-model="bulkText"
          rows="5"
          placeholder="张三 213000001
李四 213000002
213000003,王五"
        ></textarea>
        <div><button class="btn btn-primary btn-sm" @click="parseBulk">解析并添加</button></div>
      </div>

      <p v-if="!state.members.length" class="empty">还没有录入同学。点击「添加一行」或「批量粘贴」开始。</p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="cell-num">#</th>
            <th style="width: 40%">姓名</th>
            <th>一卡通号</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(m, i) in state.members" :key="i">
            <td class="cell-num">{{ i + 1 }}</td>
            <td><input v-model="m.name" placeholder="姓名" /></td>
            <td><input v-model="m.card" placeholder="一卡通号" inputmode="numeric" /></td>
            <td><button class="btn btn-sm btn-danger-ghost" @click="delRow(i)">删除</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
