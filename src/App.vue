<script setup>
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import OverviewTab from './components/OverviewTab.vue'
import MembersTab from './components/MembersTab.vue'
import ApprovalTab from './components/ApprovalTab.vue'
import FilesTab from './components/FilesTab.vue'
import ReportTab from './components/ReportTab.vue'
import { ui, toast } from './store'
import { watchEffect } from 'vue'

// 打印目标同步到 body，供打印样式决定输出哪个页面
watchEffect(() => {
  document.body.dataset.print = ui.printTarget || ''
})
</script>

<template>
  <TopBar />
  <TabNav />
  <main class="container">
    <OverviewTab v-show="ui.tab === 'overview'" />
    <MembersTab v-show="ui.tab === 'members'" />
    <ApprovalTab v-show="ui.tab === 'approval'" />
    <FilesTab v-show="ui.tab === 'files'" />
    <ReportTab v-show="ui.tab === 'report'" />
  </main>
  <footer class="no-print">
    依据《2026 年 CPC 参赛注意事项》（东南大学 · CPC 队员会议材料）整理生成；如与财务处、教练的最新要求不一致，以后者为准。所有数据仅保存在本机浏览器中，不会上传。
  </footer>
  <div id="toast" :class="{ show: toast.show }">{{ toast.msg }}</div>
</template>
