import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base: './' 使打包产物可以在任意静态目录（甚至本地 file://）直接打开
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    watch: {
      // Windows 上监听器碰到被其他进程占用/瞬移的临时文件会 EBUSY 致命崩溃，忽略之
      ignored: ['**/tmp-out/**', '**/tmp-real/**', '**/*.tmp'],
    },
  },
})
