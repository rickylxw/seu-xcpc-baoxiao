import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base: './' 使打包产物可以在任意静态目录（甚至本地 file://）直接打开
export default defineConfig({
  plugins: [vue()],
  base: './',
})
