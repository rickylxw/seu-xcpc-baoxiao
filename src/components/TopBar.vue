<script setup>
import { ref } from 'vue'
import { state, resetAll, exportData, importDataFile } from '../store'

const fileEl = ref(null)

function onReset() {
  if (confirm('确定清空全部填写内容？此操作不可恢复。')) resetAll()
}

async function onImport(e) {
  const f = e.target.files[0]
  if (f) await importDataFile(f)
  e.target.value = ''
}
</script>

<template>
  <header class="topbar no-print">
    <div class="topbar-inner container">
      <div class="brand">
        <div class="brand-text">
          <h1>XCPC 报销材料整理工具</h1>
          <p>依据《2026 年 CPC 参赛注意事项》整理 · 东南大学</p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="btn btn-sm" title="把当前填写内容导出为 JSON 文件，可发给别人继续填写" @click="exportData">
          导出数据
        </button>
        <button class="btn btn-sm" @click="fileEl.click()">导入数据</button>
        <button class="btn btn-sm btn-danger-ghost" @click="onReset">清空重来</button>
        <input ref="fileEl" type="file" accept=".json,application/json" hidden @change="onImport" />
      </div>
    </div>
  </header>
</template>
