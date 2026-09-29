// 任务管理 API — 对接 McpServer/TaskApi.js（/api/v1/tasks，见《任务管理接口文档-v2.md》）
import { request, tryRefresh, getToken, API_BASE } from './auth.js'

const WS_HOST = import.meta.env.VITE_API_WS || `${window.location.hostname || 'localhost'}:3000`

/** 带 Bearer 的请求；access_token 过期时自动刷新一次后重试 */
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

// ---- 断联中继：已收到的最大事件 seq ----
// 每次 WS 连接带上 ?since=<lastSeq>，服务端补发断线期间的事件；
// 服务端保留窗口已滑过（回 task_resync）时由页面全量重拉并调 setEventSeq 对齐。
let lastSeq = 0

/** 页面全量加载（响应含 server_seq）后调用，对齐本地水位 */
export function setEventSeq(seq) {
  if (typeof seq === 'number' && seq > lastSeq) lastSeq = seq
}

/** GET /tasks — 列表（含 stats + 分页 + server_seq 快照水位） */
export function listTasks({ state, page, limit } = {}) {
  const qs = new URLSearchParams()
  if (state) qs.set('state', state)
  if (page) qs.set('page', page)
  if (limit) qs.set('limit', limit)
  const suffix = qs.toString() ? `?${qs}` : ''
  return api(`/tasks${suffix}`)
}

/** POST /tasks — 创建任务（创建 MiMoCode 会话；upload_batch 关联参考物） */
export function createTask({ name, icon, message, upload_batch }) {
  const body = { name, icon, message }
  if (upload_batch) body.upload_batch = upload_batch
  return api('/tasks', { method: 'POST', body })
}

/** GET /tasks/{id} — 详情 */
export function getTask(taskId) {
  return api(`/tasks/${taskId}`)
}

/** PUT /tasks/{id}/cancel — 取消任务 */
export function cancelTask(taskId) {
  return api(`/tasks/${taskId}/cancel`, { method: 'PUT' })
}

/** DELETE /tasks/{id} — 删除任务 */
export function deleteTask(taskId) {
  return api(`/tasks/${taskId}`, { method: 'DELETE' })
}

/** DELETE /tasks/completed — 清空已完成 */
export function clearCompleted() {
  return api('/tasks/completed', { method: 'DELETE' })
}

/** GET /tasks/{id}/messages — 消息历史（pending=1 为排队中） */
export function getMessages(taskId, { limit, before } = {}) {
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', limit)
  if (before) qs.set('before', before)
  const suffix = qs.toString() ? `?${qs}` : ''
  return api(`/tasks/${taskId}/messages${suffix}`)
}

/** POST /tasks/{id}/send — 多轮消息（202 受理；执行中自动排队，upload_batch 关联参考物） */
export function sendMessage(taskId, content, upload_batch) {
  const body = { content }
  if (upload_batch) body.upload_batch = upload_batch
  return api(`/tasks/${taskId}/send`, { method: 'POST', body })
}

/**
 * POST /uploads —— 参考物分步上传（multipart/form-data）。
 * 用 XHR 而非 fetch：需要 upload.onprogress 实时进度。
 * files 为 File 数组（≤5 个、单个 ≤50MB 由服务端兜底，前端选择时先拦）。
 * 返回 { batch_id, files }，交给 createTask/sendMessage 的 upload_batch 消费。
 */
export function uploadFiles(files, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    for (const f of files) fd.append('file', f)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/uploads`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* 非 JSON 响应 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.code < 400) {
        resolve(data.data)
      } else {
        const err = new Error(data?.message || `上传失败（HTTP ${xhr.status}）`)
        err.type = data?.error?.type
        err.code = data?.code ?? xhr.status
        reject(err)
      }
    }
    xhr.onerror = () => {
      const err = new Error('网络异常，上传失败')
      err.type = 'NETWORK_ERROR'
      reject(err)
    }
    xhr.send(fd)
  })
}

/** GET /tasks/{id}/artifacts — 产物列表（文件系统实时扫描同步） */
export function getArtifacts(taskId) {
  return api(`/tasks/${taskId}/artifacts`)
}

/**
 * 产物直链（供 <a href> / window.open 使用 —— 请求头带不了 Bearer，
 * 走后端 ?token= 兜底认证）。inline=1 时服务端不加 attachment 头，浏览器直接渲染。
 */
export function artifactUrl(taskId, artifactId, { inline = false } = {}) {
  const qs = new URLSearchParams({ token: getToken() || '' })
  if (inline) qs.set('inline', '1')
  return `${API_BASE}/tasks/${taskId}/artifacts/${artifactId}/download?${qs}`
}

/**
 * 连接 ws://…/ws/tasks 实时事件（task_created / task_message /
 * task_state_changed / task_artifacts_changed / task_progress / task_resync）。
 *
 * 断联中继：每次连接带 ?since=<lastSeq>，服务端补发断线期间的事件；
 * 断线无限重试（退避封顶 15s），token 失效先 tryRefresh 再连，刷新失败（已登出）才放弃。
 * 返回断开函数。
 */
export function connectTaskEvents(onEvent) {
  let ws = null
  let stopped = false
  let attempts = 0

  async function connect() {
    if (stopped) return
    let token = getToken()
    if (!token) {
      await tryRefresh()
      token = getToken()
      if (!token) return // 已登出：登录页会重新挂载本组件
    }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${WS_HOST}/ws/tasks?token=${encodeURIComponent(token)}&since=${lastSeq}`
    ws = new WebSocket(url)
    ws.onopen = () => {
      attempts = 0
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (typeof msg.seq === 'number' && msg.seq > lastSeq) lastSeq = msg.seq
        onEvent(msg)
      } catch {
        /* 忽略非法帧 */
      }
    }
    ws.onclose = () => {
      if (stopped) return
      attempts += 1
      setTimeout(connect, Math.min(1000 * 2 ** attempts, 15000))
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* 触发 onclose 走重连 */
      }
    }
  }
  connect()

  return () => {
    stopped = true
    try {
      ws?.close()
    } catch {
      /* 已关闭 */
    }
  }
}
