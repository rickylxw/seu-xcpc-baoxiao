import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

const app = createApp(App)
// 组件渲染错误兜底：控制台打印完整错误栈，避免只留下半渲染的 DOM
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue errorHandler]', err, '\ninfo:', info)
}
app.mount('#app')
