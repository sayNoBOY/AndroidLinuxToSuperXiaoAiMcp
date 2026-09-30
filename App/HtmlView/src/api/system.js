// 系统状态 API — 对接 McpServer/SysApi.js（/api/v1/server，依据《接口文档_我的Tab.md》）
// 统一响应信封 { code, message, data, timestamp }，request() 已解出 data
import { request, tryRefresh, getToken } from './auth.js'

/** 带 Bearer 的请求；access_token 过期时自动刷新一次后重试（与 tasks.js 同策略） */
async function api(path, opts = {}) {
  try {
    return await request(path, { ...opts, token: getToken() })
  } catch (e) {
    if (e.type === 'AUTH_EXPIRED' && (await tryRefresh())) {
      return await request(path, { ...opts, token: getToken() })
    }
    throw e
  }
}

/** GET /server/status — 服务器概览状态（运行时采集，不落库） */
export function getServerStatus() {
  return api('/server/status')
}

/** GET /server/metrics — CPU/内存/磁盘使用率（运行时采样） */
export function getServerMetrics() {
  return api('/server/metrics')
}

/** GET /server/network — 网络上行/下行/延迟（运行时采样） */
export function getServerNetwork() {
  return api('/server/network')
}

/** GET /server/logs — 最近操作记录（limit 默认 5，result=success|fail 可选） */
export function getServerLogs({ limit, result } = {}) {
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', limit)
  if (result) qs.set('result', result)
  const suffix = qs.toString() ? `?${qs}` : ''
  return api(`/server/logs${suffix}`)
}

/** GET /server/logs/all — 全部操作记录分页（page/pageSize/result/keyword/时间范围） */
export function getAllLogs({ page, pageSize, result, keyword, startTime, endTime } = {}) {
  const qs = new URLSearchParams()
  if (page) qs.set('page', page)
  if (pageSize) qs.set('pageSize', pageSize)
  if (result) qs.set('result', result)
  if (keyword) qs.set('keyword', keyword)
  if (startTime) qs.set('startTime', startTime)
  if (endTime) qs.set('endTime', endTime)
  const suffix = qs.toString() ? `?${qs}` : ''
  return api(`/server/logs/all${suffix}`)
}

/** POST /server/reboot — 重启服务器（页面底部唯一按钮；应用内模拟，约 3 秒恢复） */
export function rebootServer() {
  return api('/server/reboot', { method: 'POST', body: { serverId: 1, confirm: true } })
}
