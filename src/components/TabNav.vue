<script setup>
import { ui } from '../store'

const tabs = [
  { id: 'overview', label: '总览与流程' },
  { id: 'members', label: '同学清单' },
  { id: 'approval', label: '差旅审批单' },
  { id: 'files', label: '材料打包' },
  { id: 'report', label: '核对报告' },
]
</script>

<template>
  <nav class="tabs no-print">
    <div class="container tabs-inner">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="tab"
        :class="{ active: ui.tab === t.id }"
        @click="ui.tab = t.id"
      >
        {{ t.label }}
      </button>
    </div>
  </nav>
</template>
