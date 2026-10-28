<script setup>
import TopBar from './components/TopBar.vue'
import TabNav from './components/TabNav.vue'
import OverviewTab from './components/OverviewTab.vue'
import MembersTab from './components/MembersTab.vue'
import ApprovalTab from './components/ApprovalTab.vue'
import FilesTab from './components/FilesTab.vue'
import ReportTab from './components/ReportTab.vue'
import { ui, toast, closePreview } from './store'
import { version as appVersion } from '../package.json'
import { onBeforeUnmount, onMounted, watchEffect } from 'vue'

// 打印目标同步到 body，供打印样式决定输出哪个页面
watchEffect(() => {
  document.body.dataset.print = ui.printTarget || ''
})

// 图片预览浮层：Esc 关闭
const onViewerKey = (e) => {
  if (e.key === 'Escape') closePreview()
}
onMounted(() => addEventListener('keydown', onViewerKey))
onBeforeUnmount(() => removeEventListener('keydown', onViewerKey))
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
    <p class="foot-note">
      依据《2026 年 CPC 参赛注意事项》（东南大学 · CPC 队员会议材料）整理生成；如与财务处、教练的最新要求不一致，以后者为准。所有数据仅保存在本机浏览器中，不会上传。
    </p>
    <p class="foot-meta">
      XCPC 报销材料整理工具 · v{{ appVersion }} · 开源参赛报销整理工具
      <br />
      © 2026 rickylxw ·
      <a href="https://github.com/rickylxw/seu-xcpc-baoxiao" target="_blank" rel="noreferrer">GitHub 仓库</a>
      ·
      <a href="https://github.com/rickylxw/seu-xcpc-baoxiao/blob/main/LICENSE" target="_blank" rel="noreferrer">GPLv3</a>
    </p>
  </footer>
  <div id="toast" :class="{ show: toast.show }">{{ toast.msg }}</div>

  <!-- 图片预览浮层：点击空白处 / Esc / 关闭按钮退出 -->
  <div v-if="ui.preview" class="img-viewer no-print" @click="closePreview">
    <div class="iv-bar">
      <span class="iv-name" :title="ui.preview.name">{{ ui.preview.name }}</span>
      <button type="button" class="iv-close" @click.stop="closePreview">✕ 关闭</button>
    </div>
    <img class="iv-img" :src="ui.preview.url" :alt="ui.preview.name" @click.stop />
    <div class="iv-tip">点击空白处或按 Esc 关闭</div>
  </div>
</template>
