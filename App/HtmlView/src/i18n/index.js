/**
 * i18n 运行时（零依赖，约 120 行）— 放入 App/HtmlView/src/i18n/index.js
 *
 * 设计要点：
 * - locale 是 ref：模板里调 t() 读到 ref 值 → 切换语言时所有用到的组件自动重渲染
 * - 回退链：当前 locale → zh-CN → key 原文（开发模式 warn）
 * - 插值 {name}；复数 key.one / key.other（Intl.PluralRules 选形，中文恒 other）
 * - 切换持久化到 localStorage(suishen.*)，并联动 <html lang>
 */
import { ref } from 'vue'
import zhCN from './locales/zh-CN.js'
import enUS from './locales/en-US.js'

const CATALOGS = { 'zh-CN': zhCN, 'en-US': enUS }
const FALLBACK = 'zh-CN'
const STORAGE_KEY = 'suishen.locale' // 沿用项目 suishen.* 前缀（见 api/auth.js）

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && CATALOGS[saved]) return saved // 手动选择过 → 尊重用户选择（探测仅在首次/无偏好时生效）
  } catch { /* localStorage 不可用（隐私模式）→ 走探测 */ }
  // 首次启动（无本地偏好）：检查当前系统语言 —— zh* → 简体中文；
  // 策略：非中文环境（含 en/ja/fr/de/… 与无法识别）统一切换为英语
  const nav = (navigator.language || '').toLowerCase()
  return nav.startsWith('zh') ? 'zh-CN' : 'en-US'
}

export const locale = ref(detectLocale())

export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
]

/** 该 key 在任一语言包中是否存在 */
export function tExists(key) {
  return key in zhCN || key in enUS
}

function lookup(key) {
  return CATALOGS[locale.value]?.[key] ?? CATALOGS[FALLBACK]?.[key]
}

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, name) =>
    params[name] !== undefined ? String(params[name]) : m)
}

/**
 * 取当前语言文案
 * @param {string} key   形如 'home.state.running'
 * @param {object} [params] 插值参数，含 count 时自动走复数 key（key.one / key.other）
 */
export function t(key, params) {
  let resolved = key
  if (params && params.count !== undefined) {
    const cat = new Intl.PluralRules(locale.value).select(params.count)
    if (lookup(`${key}.${cat}`) !== undefined) resolved = `${key}.${cat}`
    else if (lookup(`${key}.other`) !== undefined) resolved = `${key}.other`
  }
  const text = lookup(resolved)
  if (text === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`)
    return key
  }
  return interpolate(text, params)
}

/**
 * 后端/网络错误 → 当前语言文案
 * zh（源语言）：直接用错误对象自带 message —— 与改造前 toast(e?.message || …)
 *   逐字一致，后端 38 处中文 fail() 不动即零回归；
 * en：error.type 对应 key → 调用方 fallbackKey → e.message 兜底
 */
export function errText(e, fallbackKey) {
  if (locale.value === FALLBACK) {
    return e?.message || (fallbackKey ? t(fallbackKey) : t('error.UNKNOWN'))
  }
  const key = e?.type ? `error.${e.type}` : undefined
  if (key && lookup(key) !== undefined) return t(key, e.params)
  if (fallbackKey && lookup(fallbackKey) !== undefined) return t(fallbackKey)
  return e?.message || t('error.UNKNOWN')
}

/** 切换语言：持久化 + <html lang> + 文档标题；locale 是 ref，UI 自动重渲染 */
export function setLocale(next) {
  if (!CATALOGS[next] || next === locale.value) return
  locale.value = next
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* 忽略 */ }
  document.documentElement.lang = next
  document.title = t('meta.appTitle')
}

// 初始化：补正静态 index.html 的 lang/title（其 lang="en" 为现存缺陷）
document.documentElement.lang = locale.value
document.title = t('meta.appTitle')
