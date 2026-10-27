import { createApp } from 'vue'
import App from './App.vue'
import './styles/reset.css'
import './styles/variables.css'
import './styles/main.css'
import './editor/markdown/styles.css'
import './editor/core/searchPanel.css'

const app = createApp(App)

// A thrown error inside a template-visible computed or render function leaves the
// last painted frame on screen indefinitely, so a single bad payload can strand
// the window on "正在打开…" with no visible cause. Report it instead of failing
// silently, and never report the same failure twice (the toast itself re-renders).
const reported = new Set<string>()
const notices=new Set<ReturnType<typeof setTimeout>>()
let disposed=false
app.config.errorHandler = (error, _instance, info) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Markumo: 渲染或组件执行失败（${info}）`, error)
  if (reported.has(message)) return
  reported.add(message)
  const timer=setTimeout(() => {
    notices.delete(timer);if(disposed)return
    window.dispatchEvent(new CustomEvent('editor-notice', { detail: `界面渲染异常（${info}）：${message}。如界面无响应，请重新启动应用。` }))
  }, 0)
  notices.add(timer)
}

app.mount('#app')
window.addEventListener('markumo:dispose-window',()=>{
  if(disposed)return;disposed=true
  for(const timer of notices)clearTimeout(timer)
  notices.clear();reported.clear();app.unmount()
},{once:true})
