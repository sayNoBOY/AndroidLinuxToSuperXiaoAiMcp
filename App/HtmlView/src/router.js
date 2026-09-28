// 轻量 hash 路由（离线环境无法安装 vue-router，接口保持相近便于日后替换）
import { shallowRef } from 'vue'
import LoginView from './views/LoginView.vue'
import HomeView from './components/HelloWorld.vue'
import { getToken } from './api/auth.js'

const routes = [
  { path: '/login', component: LoginView, meta: { full: true } },
  { path: '/', component: HomeView, meta: { requiresAuth: true } },
]

function resolve() {
  const path = window.location.hash.replace(/^#/, '') || '/'
  const route = routes.find((r) => r.path === path) || routes.find((r) => r.path === '/')
  // 需要登录的路由在未登录时重定向到登录页
  if (route.meta.requiresAuth && !getToken()) {
    return routes.find((r) => r.path === '/login')
  }
  return route
}

export const currentRoute = shallowRef(resolve())

export function push(path) {
  window.location.hash = path
}

window.addEventListener('hashchange', () => {
  currentRoute.value = resolve()
})

// 首次进入时把地址栏规范化到解析结果（如未登录访问 / → 跳到 /login）
const normalized = '#' + currentRoute.value.path
if (window.location.hash !== normalized) {
  window.location.hash = normalized.slice(1)
}
