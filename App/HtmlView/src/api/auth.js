// 登录认证 API — 对接 McpServer/LoginApi.js（/api/v1/auth，见《登录接口文档-v2.md》）
import { t } from '../i18n/index.js'

export const API_BASE =
  import.meta.env.VITE_API_BASE ||
  `http://${window.location.hostname || 'localhost'}:3000/api/v1`

const KEY_ACCESS = 'suishen.access_token'
const KEY_REFRESH = 'suishen.refresh_token'

// 记住登录 → localStorage（跨会话），否则 sessionStorage（关标签即失效）
function store(rememberMe = false) {
  return rememberMe ? window.localStorage : window.sessionStorage
}

function otherStore(rememberMe) {
  return rememberMe ? window.sessionStorage : window.localStorage
}

function readToken(key) {
  return window.localStorage.getItem(key) || window.sessionStorage.getItem(key)
}

export function getToken() {
  return readToken(KEY_ACCESS)
}

export function getRefreshToken() {
  return readToken(KEY_REFRESH)
}

export function clearTokens() {
  window.localStorage.removeItem(KEY_ACCESS)
  window.localStorage.removeItem(KEY_REFRESH)
  window.sessionStorage.removeItem(KEY_ACCESS)
  window.sessionStorage.removeItem(KEY_REFRESH)
}

export function setTokens({ access_token, refresh_token }, rememberMe) {
  clearTokens()
  const s = store(rememberMe)
  s.setItem(KEY_ACCESS, access_token)
  s.setItem(KEY_REFRESH, refresh_token)
}

function saveAccessToken(access_token) {
  const rememberMe = window.localStorage.getItem(KEY_REFRESH) !== null
  store(rememberMe).setItem(KEY_ACCESS, access_token)
}

export async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (body) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    const err = new Error(t('error.NETWORK_ERROR'))
    err.type = 'NETWORK_ERROR'
    err.code = 0
    throw err
  }

  const data = await res.json().catch(() => null)
  if (!res.ok || (data && data.code >= 400)) {
    const err = new Error(data?.message || t('error.HTTP', { code: res.status }))
    err.code = data?.code ?? res.status
    err.type = data?.error?.type
    throw err
  }
  return data?.data
}

/** POST /auth/login — 成功后保存 Token，返回用户信息 */
export async function login(username, password, rememberMe) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: { username, password },
  })
  setTokens(data, rememberMe)
  return data.user
}

/** 用 refresh_token 换新 access_token，成功返回 true */
export async function tryRefresh() {
  const refresh_token = getRefreshToken()
  if (!refresh_token) return false
  try {
    const data = await request('/auth/refresh', {
      method: 'POST',
      body: { refresh_token },
    })
    saveAccessToken(data.access_token)
    return true
  } catch {
    clearTokens()
    return false
  }
}

/** GET /auth/me — access_token 过期时自动刷新一次后重试 */
export async function fetchMe() {
  const token = getToken()
  if (!token) {
    const err = new Error(t('error.NOT_LOGGED_IN'))
    err.type = 'NOT_LOGGED_IN'
    throw err
  }
  try {
    return await request('/auth/me', { token })
  } catch (e) {
    if (e.type === 'AUTH_EXPIRED' && (await tryRefresh())) {
      return await request('/auth/me', { token: getToken() })
    }
    throw e
  }
}

/** POST /auth/logout — 无论成功与否都清除本地 Token */
export async function logout() {
  const token = getToken()
  if (token) {
    try {
      await request('/auth/logout', {
        method: 'POST',
        body: { refresh_token: getRefreshToken() },
        token,
      })
    } catch { /* 服务端可能已失效，忽略 */ }
  }
  clearTokens()
}

/** POST /auth/change-password — 修改登录密码（需 Bearer，新密码需二次确认；过期自动刷新一次） */
export async function changePassword(currentPassword, newPassword, confirmPassword) {
  const body = { currentPassword, newPassword, confirmPassword }
  const call = (token) => request('/auth/change-password', { method: 'POST', body, token })
  const token = getToken()
  if (!token) {
    const err = new Error(t('error.NOT_LOGGED_IN'))
    err.type = 'NOT_LOGGED_IN'
    throw err
  }
  try {
    return await call(token)
  } catch (e) {
    if (e.type === 'AUTH_EXPIRED' && (await tryRefresh())) return await call(getToken())
    throw e
  }
}
