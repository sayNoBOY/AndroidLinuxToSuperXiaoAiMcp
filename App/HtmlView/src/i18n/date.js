/**
 * 日期/数字格式化 — 放入 App/HtmlView/src/i18n/date.js
 * 数据层仍是 yyyy-MM-dd HH:mm:ss 字符串（后端契约不动），只在展示层按 locale 转换。
 */
import { locale } from './index.js'

/** '2026-01-02 03:04:05' 或 Date → zh: 原格式；en: 'Jan 2, 2026 03:04' */
export function fmtDateTime(value) {
  const d = toDate(value)
  if (!d) return '—'
  if (locale.value === 'zh-CN') return pad(d, true)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** 只到分钟（列表行用） */
export function fmtDateTimeShort(value) {
  const d = toDate(value)
  if (!d) return '—'
  if (locale.value === 'zh-CN') {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 千分位（替换硬编码 .toLocaleString('en-US')，HomeView.vue:162） */
export function fmtNum(n) {
  return (n || 0).toLocaleString(locale.value)
}

/** 运行时长秒 → '3天 04:05:06' / '3d 04:05:06'（fmt.uptime 模板） */
export function fmtUptime(totalSeconds, t) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return t('fmt.uptime', { d, h: p(h), m: p(m), s: p(sec) })
}

function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  // 'yyyy-MM-dd HH:mm:ss' 按本地时间解析（与后端 naiveNow 一致），不能交给 Date.parse 当 UTC
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
  const d = new Date(value)
  return isNaN(d) ? null : d
}

function pad(d, withSeconds) {
  const p = (n) => String(n).padStart(2, '0')
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base
}
