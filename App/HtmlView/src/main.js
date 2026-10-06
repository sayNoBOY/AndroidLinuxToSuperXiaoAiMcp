import { createApp } from 'vue'
import './style.css'
import './i18n/index.js' // 先于视图：探测/持久化语言，校正 <html lang> 与 title
import App from './App.vue'

createApp(App).mount('#app')
