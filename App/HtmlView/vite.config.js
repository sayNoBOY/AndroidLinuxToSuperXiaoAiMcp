import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  // 监听 0.0.0.0，允许安卓浏览器等局域网设备通过局域网 IP 访问
  server: { host: true },
  preview: { host: true },
})
