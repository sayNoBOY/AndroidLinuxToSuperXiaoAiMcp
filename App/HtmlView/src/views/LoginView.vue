<script setup>
import { ref, onMounted } from 'vue'
import { login } from '../api/auth.js'
import { push } from '../router.js'

// 依据 随身互联开发文档/设计/登录页/登录页.html 移植，接真实 /api/v1/auth 接口
// 默认账号来自 LoginApi.js 初始化的管理员（密码可用 ADMIN_PASSWORD 覆盖）
const DEFAULT_USERNAME = 'admin'
const DEFAULT_PASSWORD = 'admin123'
const username = ref(DEFAULT_USERNAME)
const password = ref(DEFAULT_PASSWORD)
const remember = ref(true)
const showPwd = ref(false)
const loading = ref(false)
const toastMsg = ref('')
let toastTimer = null

function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, 2200)
}

function togglePwd() {
  showPwd.value = !showPwd.value
}

async function doLogin() {
  if (loading.value) return
  const u = username.value.trim()
  const p = password.value
  if (!u) return toast('请输入用户名')
  if (!p) return toast('请输入密码')

  loading.value = true
  try {
    await login(u, p, remember.value)
    push('/')
  } catch (e) {
    toast(e?.message || '登录失败，请稍后重试')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  setTimeout(() => document.getElementById('username')?.focus(), 500)
})
</script>

<template>
  <div class="page">
    <!-- 背景装饰 -->
    <div class="deco">
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
    </div>

    <!-- Logo -->
    <div class="brand">
      <div class="brand-icon">🔗</div>
      <h1>智衍</h1>
      <p>无限自进化，随你所想</p>
    </div>

    <!-- 表单 -->
    <div class="form-wrap">
      <form class="card" @submit.prevent="doLogin">
        <div class="card-title">账号登录</div>
        <div class="card-subtitle">请输入管理员账号和密码</div>

        <div class="field">
          <span class="icon">👤</span>
          <input
            id="username"
            v-model="username"
            type="text"
            placeholder="用户名"
            autocomplete="username"
          />
        </div>
        <div class="field">
          <span class="icon">🔐</span>
          <input
            id="password"
            v-model="password"
            :type="showPwd ? 'text' : 'password'"
            placeholder="密码"
            autocomplete="current-password"
          />
          <button class="toggle-pwd" type="button" @click="togglePwd">
            {{ showPwd ? '🙈' : '👁' }}
          </button>
        </div>

        <div class="options">
          <label class="check-wrap">
            <input v-model="remember" type="checkbox" />
            <span class="check-box"></span>
            记住登录
          </label>
          <a class="forgot" href="javascript:void(0)" @click="toast('请联系管理员重置密码')">忘记密码?</a>
        </div>

        <button class="btn-primary" :class="{ loading }" type="submit" :disabled="loading">
          <span class="btn-text">登 录</span>
          <div class="spinner"></div>
          <div class="shine"></div>
        </button>

        <div class="default-hint">
          默认账号：{{ DEFAULT_USERNAME }}　默认密码：{{ DEFAULT_PASSWORD }}
        </div>
      </form>
    </div>

    <!-- Toast -->
    <div class="toast" :class="{ show: toastMsg }">{{ toastMsg }}</div>

    <!-- 底部 -->
    <div class="footer">
      <p>随身互联 v1.0 · 局域网管理系统</p>
    </div>
  </div>
</template>

<style scoped>
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent }

.page {
  --bg: #0a0e1a; --card: #111827; --card2: #0f1522; --line: #1f2937;
  --t1: #e5e7eb; --t2: #9ca3af; --t3: #6b7280;
  --blue: #3b82f6; --blue-glow: rgba(59,130,246,.25);
  --cyan: #22d3ee; --purple: #a855f7; --orange: #f97316;
  --green: #10b981; --red: #ef4444;
  --radius: 14px;

  width: 100%; height: 100%; display: flex; flex-direction: column; position: relative;
  overflow: hidden; background: var(--bg); color: var(--t1);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

/* ========== 顶部装饰 ========== */
.deco { position: absolute; top: 0; left: 0; width: 100%; height: 360px; pointer-events: none; overflow: hidden }
.deco .orb { position: absolute; border-radius: 50%; filter: blur(80px); opacity: .35 }
.deco .orb-1 { width: 220px; height: 220px; background: var(--blue); top: -60px; left: -40px; animation: float1 8s ease-in-out infinite }
.deco .orb-2 { width: 160px; height: 160px; background: var(--purple); top: 40px; right: -30px; animation: float2 10s ease-in-out infinite }
.deco .orb-3 { width: 100px; height: 100px; background: var(--cyan); bottom: 20px; left: 40%; opacity: .2; animation: float1 12s ease-in-out infinite reverse }
@keyframes float1 { 0%,100% { transform: translateY(0) scale(1) } 50% { transform: translateY(-18px) scale(1.05) } }
@keyframes float2 { 0%,100% { transform: translateY(0) scale(1) } 50% { transform: translateY(14px) scale(.95) } }
.deco::after {
  content: ''; position: absolute; inset: 0;
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 48px 48px; opacity: .18;
  -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,.4), transparent 70%);
  mask-image: linear-gradient(to bottom, rgba(0,0,0,.4), transparent 70%);
}

/* ========== Logo + 标题 ========== */
.brand { position: relative; z-index: 2; text-align: center; padding-top: clamp(60px, 14vh, 100px) }
.brand-icon {
  width: 72px; height: 72px; margin: 0 auto 18px; border-radius: 22px;
  background: linear-gradient(135deg, var(--blue), var(--purple));
  display: flex; align-items: center; justify-content: center; font-size: 36px;
  box-shadow: 0 8px 32px rgba(59,130,246,.35); animation: pulse 4s ease-in-out infinite;
}
@keyframes pulse {
  0%,100% { box-shadow: 0 8px 32px rgba(59,130,246,.35) }
  50% { box-shadow: 0 8px 40px rgba(99,102,241,.5) }
}
.brand h1 { font-size: 28px; font-weight: 700; letter-spacing: .5px; color: var(--t1) }
.brand p { font-size: 13px; color: var(--t2); margin-top: 8px; letter-spacing: .3px; font-weight: 400 }

/* ========== 表单卡片 ========== */
.form-wrap {
  flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
  position: relative; z-index: 2; padding: 0 24px 20px; margin-top: auto;
}

.card {
  background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 32px 24px 28px; position: relative; overflow: hidden;
  animation: slideUp .5s cubic-bezier(.16,1,.3,1);
}
.card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(59,130,246,.4), transparent);
}
@keyframes slideUp { from { opacity: 0; transform: translateY(30px) } to { opacity: 1; transform: translateY(0) } }

.card-title { font-size: 20px; font-weight: 600; margin-bottom: 4px }
.card-subtitle { font-size: 13px; color: var(--t2); margin-bottom: 24px }

/* 输入框 */
.field { position: relative; margin-bottom: 16px }
.field input {
  width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 44px 14px 44px; font-size: 15px; color: var(--t1); outline: none; transition: .25s;
  font-family: inherit;
}
.field input::placeholder { color: var(--t3) }
.field input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-glow) }
.field .icon {
  position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
  font-size: 18px; color: var(--t3); pointer-events: none;
}
.field .toggle-pwd {
  position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 16px;
  color: var(--t3); cursor: pointer; background: none; border: none; padding: 4px; line-height: 1;
}
.field .toggle-pwd:hover { color: var(--t2) }
.field::after {
  content: ''; position: absolute; bottom: 0; left: 50%; width: 0; height: 2px;
  background: linear-gradient(90deg, var(--blue), var(--purple)); border-radius: 1px;
  transform: translateX(-50%); transition: .3s;
}
.field:focus-within::after { width: 60% }

/* 记住我 + 忘记密码 */
.options { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px }
.check-wrap {
  display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--t2);
  cursor: pointer; user-select: none;
}
.check-wrap input[type=checkbox] { display: none }
.check-box {
  width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--line);
  display: flex; align-items: center; justify-content: center; transition: .2s; flex-shrink: 0;
}
.check-wrap input:checked + .check-box { background: var(--blue); border-color: var(--blue) }
.check-wrap input:checked + .check-box::after { content: '✓'; font-size: 11px; color: #fff; font-weight: 700 }
.forgot { font-size: 13px; color: var(--blue); cursor: pointer; text-decoration: none }
.forgot:hover { text-decoration: underline }

/* 登录按钮 */
.btn-primary {
  width: 100%; padding: 15px; border: none; border-radius: 12px; font-size: 16px; font-weight: 600;
  color: #fff; cursor: pointer; position: relative; overflow: hidden;
  background: linear-gradient(135deg, var(--blue), #6366f1);
  box-shadow: 0 4px 20px rgba(59,130,246,.35); transition: .3s;
}
.btn-primary:hover { box-shadow: 0 6px 28px rgba(59,130,246,.5); transform: translateY(-1px) }
.btn-primary:active { transform: translateY(0); box-shadow: 0 2px 12px rgba(59,130,246,.3) }
.btn-primary .shine {
  position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.12), transparent);
  animation: shine 3s ease-in-out infinite;
}
@keyframes shine { 0%,100% { left: -100% } 50% { left: 100% } }
.btn-primary.loading { pointer-events: none; opacity: .85 }
.btn-primary.loading .btn-text { opacity: 0 }
.btn-primary .spinner {
  display: none; position: absolute; top: 50%; left: 50%; margin: -10px 0 0 -10px;
  width: 20px; height: 20px; border: 2.5px solid rgba(255,255,255,.3); border-top-color: #fff;
  border-radius: 50%; animation: spin .7s linear infinite;
}
.btn-primary.loading .spinner { display: block }
@keyframes spin { to { transform: rotate(360deg) } }

/* 默认账号提示 */
.default-hint {
  margin-top: 14px; text-align: center; font-size: 12px; color: var(--t3);
  background: var(--card2); border: 1px dashed var(--line);
  border-radius: 8px; padding: 8px 10px; letter-spacing: .3px;
}

/* ========== 底部 ========== */
.footer {
  position: relative; z-index: 2; text-align: center;
  padding-bottom: clamp(16px, env(safe-area-inset-bottom), 24px);
}
.footer p { font-size: 12px; color: var(--t3) }

/* Toast */
.toast {
  position: fixed; left: 50%; bottom: 100px; transform: translateX(-50%) translateY(20px);
  background: #1f2937; color: var(--t1); padding: 10px 18px; border-radius: 12px; font-size: 13px;
  z-index: 99; opacity: 0; pointer-events: none; transition: .3s; box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0) }
</style>
