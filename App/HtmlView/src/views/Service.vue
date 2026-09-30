<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { push } from '../router.js'
import {
  getServerStatus, getServerMetrics, getServerNetwork,
  getServerLogs, getAllLogs, rebootServer,
} from '../api/system.js'

// 依据 随身互联App四Tab原型(6).html Tab4「我的」实现，接口对接 SysApi.js：
//   status / metrics / network 10s 轮询（文档口径 5~10s），logs 首次 + 重启完成时刷新，
//   reboot 调用 restart.sh 真实重启（前后端一起重启，vite 重载会打断本页 → 用
//   sessionStorage 标记续等、期间静默吞错），全部日志走 /server/logs/all 分页弹层。

const loading = ref(false)
const status = ref(null)    // GET /server/status
const metrics = ref(null)   // GET /server/metrics
const network = ref(null)   // GET /server/network
const logs = ref([])        // GET /server/logs（最近 5 条）
const lastSync = ref('')    // 最后同步时间（yyyy-MM-dd HH:mm:ss）

// 运行时间：以最近一次 status.uptimeSeconds 为基线，本地每秒累加显示
const upBase = ref(0)
const upAt = ref(0)
const uptimeText = ref('—')

// 网络进度条满刻度：按本轮采样的最大速率动态定标（下限 1MB/s），避免固定值失真
const netScale = ref(1048576)

const rebooting = ref(false) // restarting 期间防重复触发

// ---- 全部日志弹层 ----
const logsOpen = ref(false)
const logLoading = ref(false)
const logList = ref([])
const logTotal = ref(0)
const logHasMore = ref(false)
const logPage = ref(1)
const logResult = ref('') // '' 全部 / success / fail
const logKeyword = ref('')
const LOG_PAGE_SIZE = 20

const toastMsg = ref('')
let toastTimer = null
function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 1800)
}

// ---------- 展示辅助 ----------
const STATE_CLS = { running: 'green', restarting: 'yellow', stopped: 'red' }
const stateCls = computed(() => STATE_CLS[status.value?.state] || 'gray')

const cpuText = computed(() => {
  const c = metrics.value?.cpu
  return c ? `${c.percent}% · ${c.model}` : '—'
})
const memText = computed(() => {
  const m = metrics.value?.memory
  return m ? `${m.percent}% · ${m.usedGb}/${m.totalGb} GB` : '—'
})
const diskText = computed(() => {
  const d = metrics.value?.disk
  return d ? `${d.percent}% · ${d.usedGb}/${d.totalGb} GB` : '—'
})

// 进度条配色随水位变化（演示值 32/68/45 对应 绿/黄/绿，与原型一致）
function barColor(p) {
  if (p >= 85) return 'var(--red)'
  if (p >= 60) return 'var(--yellow)'
  return 'var(--green)'
}

const upBarPct = computed(() => barPct(network.value?.uploadBps))
const downBarPct = computed(() => barPct(network.value?.downloadBps))
function barPct(bps = 0) {
  return Math.max(bps > 0 ? 3 : 0, Math.min(100, Math.round((bps / netScale.value) * 100)))
}
const latencyCls = computed(() => (network.value?.latencyMs > 0 ? 'ok' : 'na'))

function fmtUptime(sec) {
  const p = (n) => String(n).padStart(2, '0')
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${d}天 ${p(h)}:${p(m)}:${p(s)}`
}

function nowText() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function tickUptime() {
  if (!status.value) return
  const sec = upBase.value + Math.floor((Date.now() - upAt.value) / 1000)
  uptimeText.value = fmtUptime(Math.max(0, sec))
}

// ---------- 数据加载 ----------
async function loadStatus() {
  const s = await getServerStatus()
  status.value = s
  upBase.value = s.uptimeSeconds
  upAt.value = Date.now()
  tickUptime()
}

async function loadMetrics() {
  metrics.value = await getServerMetrics()
}

async function loadNetwork() {
  const n = await getServerNetwork()
  network.value = n
  netScale.value = Math.max(1048576, n.uploadBps || 0, n.downloadBps || 0)
}

async function loadLogs() {
  const d = await getServerLogs({ limit: 5 })
  logs.value = d.list || []
}

/** 三路状态并行拉取：单路失败不拖垮其余；重启窗口内静默（服务本来就 down），返回是否全成功 */
async function loadRuntime() {
  const rs = await Promise.allSettled([loadStatus(), loadMetrics(), loadNetwork()])
  const first = rs.find((r) => r.status === 'rejected')
  if (first) {
    if (!rebooting.value) toast(first.reason?.message || '状态刷新失败')
    return false
  }
  return true
}

async function refreshAll() {
  loading.value = true
  try {
    const rs = await Promise.allSettled([loadRuntime(), loadLogs()])
    const okRuntime = rs[0].status === 'fulfilled' && rs[0].value === true
    const okLogs = rs[1].status === 'fulfilled'
    if (okRuntime || okLogs) lastSync.value = nowText()
  } finally {
    loading.value = false
  }
}

// ---------- 操作：重启（restart.sh 真实重启，含断连等待） ----------
const REBOOT_KEY = 'suishen.rebooting_at'
const REBOOT_WAIT_MS = 120000 // 脚本冷启动 + vite 重载的最坏等待上限
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function markRebooting() {
  sessionStorage.setItem(REBOOT_KEY, String(Date.now()))
}
function clearRebooting() {
  sessionStorage.removeItem(REBOOT_KEY)
}
/** 页面被 vite 重启刷新过：标记仍新鲜则回来继续等 */
function rebootWaitActive() {
  const t = Number(sessionStorage.getItem(REBOOT_KEY))
  if (!t) return false
  if (Date.now() - t > REBOOT_WAIT_MS) {
    clearRebooting()
    return false
  }
  return true
}

/**
 * 等服务回来：restart.sh 连 vite 一起重启，本页很可能被整页刷新（组件状态丢失），
 * 所以 ① 等待状态存 sessionStorage 供重载后续接；② 期间的轮询错误全部静默。
 * 假成功修复：重启窗口内旧进程也是 HTTP 200（state=restarting），
 * 只有新进程真正 running 才算回来 —— 否则会瞬间弹"已完成"且过早清掉续等标记。
 */
async function waitServerBack() {
  rebooting.value = true
  const deadline = Date.now() + REBOOT_WAIT_MS
  while (alive && Date.now() < deadline) {
    try {
      await loadStatus()
    } catch {
      await sleep(1000)
      continue
    }
    if (status.value?.state !== 'running') {
      await sleep(1000) // 旧进程还没死透/新进程没就绪：继续等
      continue
    }
    rebooting.value = false
    clearRebooting()
    toast('服务器已重启完成 ✓')
    await Promise.allSettled([loadMetrics(), loadNetwork(), loadLogs()])
    lastSync.value = nowText()
    return
  }
  if (!alive) return // 离开页面：保留 sessionStorage 标记，回来 onMounted 续等
  rebooting.value = false
  clearRebooting()
  toast('重启超时，请刷新页面查看状态')
}

async function reboot() {
  if (rebooting.value || status.value?.state === 'restarting') return
  try {
    const d = await rebootServer()
    if (status.value) {
      status.value = { ...status.value, state: d.state, stateText: d.stateText }
    }
  } catch (e) {
    // 响应已发出但连接随进程被杀而断（网络层错误）→ 仍按已触发处理；
    // 业务错误（409 重复触发等）才直接报错退出
    if (e.type !== 'NETWORK_ERROR') return toast(e?.message || '重启失败')
  }
  markRebooting()
  rebooting.value = true
  toast('服务器正在重启…')
  await waitServerBack()
}

// ---------- 全部日志弹层 ----------
async function loadAllLogs() {
  logLoading.value = true
  try {
    const d = await getAllLogs({
      page: logPage.value,
      pageSize: LOG_PAGE_SIZE,
      result: logResult.value || undefined,
      keyword: logKeyword.value.trim() || undefined,
    })
    logList.value = d.list || []
    logTotal.value = d.total
    logHasMore.value = d.hasMore
  } catch (e) {
    toast(e?.message || '日志加载失败')
  } finally {
    logLoading.value = false
  }
}

function openLogs() {
  logsOpen.value = true
  logPage.value = 1
  loadAllLogs()
}
function setLogResult(r) {
  if (logResult.value === r) return
  logResult.value = r
  logPage.value = 1
  loadAllLogs()
}
function searchLogs() {
  logPage.value = 1
  loadAllLogs()
}
function prevLogPage() {
  if (logPage.value > 1) {
    logPage.value -= 1
    loadAllLogs()
  }
}
function nextLogPage() {
  if (logHasMore.value) {
    logPage.value += 1
    loadAllLogs()
  }
}
/** 日志行时间：occurredAt 为 yyyy-MM-dd HH:mm:ss，列表取 年月日+时分（弹层带日期） */
function logDay(t) {
  return String(t || '').slice(5, 16).replace('T', ' ')
}

// ---------- 生命周期 ----------
let pollTimer = null
let tickTimer = null
let alive = true // 组件是否仍挂载（waitServerBack 的等待循环退出条件）

onMounted(async () => {
  if (rebootWaitActive()) {
    rebooting.value = true
    await waitServerBack() // 续上被 vite 整页刷新打断的重启等待
  } else {
    await refreshAll()
  }
  // 常态轮询：status/metrics/network 每 10s（文档口径 5~10s；留痕由服务端 7 天策略控制）
  pollTimer = setInterval(loadRuntime, 10000)
  tickTimer = setInterval(tickUptime, 1000)
})

onUnmounted(() => {
  alive = false
  clearInterval(pollTimer)
  clearInterval(tickTimer)
  clearTimeout(toastTimer)
})
</script>

<template>
  <div class="page">
    <!-- 内容区 -->
    <div class="content">
      <div class="sect-title"><span class="bar" style="background: var(--blue)"></span>服务器状态</div>

      <!-- 服务器概览卡 -->
      <div class="card">
        <div class="srv-head">
          <div class="srv-ic">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.6">
              <rect x="2" y="3" width="20" height="7" rx="2" />
              <rect x="2" y="14" width="20" height="7" rx="2" />
              <path d="M6 6.5h.01M6 17.5h.01" />
            </svg>
          </div>
          <div class="srv-main">
            <div class="srv-name">{{ status?.name || '随身互联服务器' }}</div>
            <div class="srv-state-row">
              <span class="dot" :class="'bg-' + stateCls" :style="rebooting ? '' : 'animation: breath 1.6s infinite'"></span>
              <span class="srv-state" :class="stateCls">{{ status?.stateText || '连接中…' }}</span>
            </div>
          </div>
          <div class="srv-up">
            <div class="up-v">{{ uptimeText }}</div>
            <div class="up-l">运行时间</div>
          </div>
        </div>
        <div class="kv"><span class="k">IP 地址</span><span class="v">{{ status?.ip || '—' }}</span></div>
        <div class="kv"><span class="k">操作系统</span><span class="v">{{ status?.os || '—' }}</span></div>
        <div class="kv">
          <span class="k">CPU 核心</span>
          <span class="v">{{ status ? `${status.cpuCores} 核 ${status.cpuModel}` : '—' }}</span>
        </div>
      </div>

      <!-- CPU / 内存 / 磁盘 -->
      <div class="bigrow">
        <div class="card m-card">
          <div class="m-label">CPU 使用率</div>
          <div class="pbar anim">
            <div :style="{ width: (metrics?.cpu.percent ?? 0) + '%', background: barColor(metrics?.cpu.percent ?? 0) }"></div>
          </div>
          <div class="m-txt">{{ cpuText }}</div>
        </div>
        <div class="card m-card">
          <div class="m-label">内存</div>
          <div class="pbar anim">
            <div :style="{ width: (metrics?.memory.percent ?? 0) + '%', background: barColor(metrics?.memory.percent ?? 0) }"></div>
          </div>
          <div class="m-txt">{{ memText }}</div>
        </div>
        <div class="card m-card">
          <div class="m-label">磁盘</div>
          <div class="pbar anim">
            <div :style="{ width: (metrics?.disk.percent ?? 0) + '%', background: barColor(metrics?.disk.percent ?? 0) }"></div>
          </div>
          <div class="m-txt">{{ diskText }}</div>
        </div>
      </div>

      <!-- 网络信息 -->
      <div class="card">
        <div class="card-title">网络信息</div>
        <div class="net-row">
          <div class="net-head"><span>上行</span><span class="net-v">{{ network?.upload || '—' }}</span></div>
          <div class="resbar"><div :style="{ width: upBarPct + '%', background: 'var(--cyan)' }"></div></div>
        </div>
        <div class="net-row">
          <div class="net-head"><span>下行</span><span class="net-v">{{ network?.download || '—' }}</span></div>
          <div class="resbar"><div :style="{ width: downBarPct + '%', background: 'var(--cyan)' }"></div></div>
        </div>
        <div class="net-head flat">
          <span>延迟</span>
          <span :class="['lat', latencyCls]">{{ network ? network.latencyText : '—' }}</span>
        </div>
      </div>

      <!-- 最近活动日志 -->
      <div class="card">
        <div class="card-title">最近活动日志</div>
        <div class="log-box">
          <div v-if="!logs.length" class="center muted" style="padding: 12px 0">
            {{ loading ? '加载中…' : '暂无操作记录' }}
          </div>
          <div v-for="l in logs" :key="l.id" class="log">
            <span class="t">{{ l.time }}</span>
            <span :style="{ color: l.level === 'success' ? 'var(--green)' : 'var(--red)' }">{{ l.level === 'success' ? '🟢' : '🔴' }}</span>
            <span class="txt">{{ l.content }}</span>
          </div>
        </div>
        <button class="more-btn" @click="openLogs">查看全部日志</button>
      </div>

      <!-- 操作按钮：按用户要求只保留重启服务器（查看日志入口 = 上方「查看全部日志」） -->
      <div class="conn">
        <button class="btn red" style="flex: 1" :disabled="rebooting" @click="reboot">
          {{ rebooting ? '重启中…' : '重启服务器' }}
        </button>
      </div>
      <div class="center muted" style="padding-top: 12px">
        最后同步：{{ lastSync || '—' }}
      </div>
    </div>

    <!-- 底部导航 -->
    <div class="tabbar">
      <div class="tab" @click="push('/')">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
        <span>首页</span>
      </div>
      <div class="tab" @click="toast('消息页面开发中，敬请期待')">
        <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        <span>消息</span>
      </div>
      <div class="tab" @click="toast('设备页面开发中，敬请期待')">
        <svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" /><rect x="8" y="8" width="8" height="8" rx="2" /></svg>
        <span>设备</span>
      </div>
      <div class="tab on">
        <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
        <span>我的</span>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast" :class="{ show: toastMsg }">{{ toastMsg }}</div>

    <!-- 全部操作日志弹层（/server/logs/all：结果筛选 + 关键字 + 分页） -->
    <div class="overlay" :class="{ show: logsOpen }" @click.self="logsOpen = false">
      <div class="sheet sheet--logs">
        <div class="sheet-head">
          <h3>全部操作日志</h3>
          <button class="close-x" aria-label="关闭" title="关闭" @click="logsOpen = false">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div class="tabs3">
          <div class="tab3" :class="{ on: logResult === '' }" @click="setLogResult('')">全部</div>
          <div class="tab3" :class="{ on: logResult === 'success' }" @click="setLogResult('success')">成功</div>
          <div class="tab3" :class="{ on: logResult === 'fail' }" @click="setLogResult('fail')">失败</div>
        </div>
        <div class="log-search">
          <input
            v-model="logKeyword"
            class="input"
            placeholder="搜索动作 / 内容…"
            @keydown.enter="searchLogs"
          />
          <button class="btn sm primary" @click="searchLogs">查询</button>
        </div>

        <div class="log-scroll">
          <div v-if="logLoading" class="center muted" style="padding: 20px 0">加载中…</div>
          <div v-else-if="!logList.length" class="center muted" style="padding: 20px 0">暂无匹配的操作记录</div>
          <div v-for="l in logList" :key="l.id" class="log-item">
            <span class="log-when">{{ logDay(l.occurredAt) }}</span>
            <span class="st" :class="l.level === 'success' ? 'green' : 'red'">
              {{ l.level === 'success' ? '✓ 成功' : '✕ 失败' }}
            </span>
            <span class="log-body">
              <em>{{ l.action }}</em>
              {{ l.content }}
            </span>
          </div>
        </div>

        <div class="pager">
          <button class="btn sm line" :disabled="logPage <= 1 || logLoading" @click="prevLogPage">上一页</button>
          <span class="muted">第 {{ logPage }} 页 · 共 {{ logTotal }} 条</span>
          <button class="btn sm line" :disabled="!logHasMore || logLoading" @click="nextLogPage">下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 样式逐值复刻自 随身互联App四Tab原型(6).html 的 Tab4「我的」相关规则 */
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent }

.page {
  --bg: #0a0e1a; --card: #111827; --card2: #0f1522; --line: #1f2937;
  --t1: #e5e7eb; --t2: #9ca3af; --t3: #6b7280;
  --blue: #3b82f6; --orange: #f97316; --cyan: #22d3ee; --purple: #a855f7;
  --green: #22c55e; --red: #ef4444; --yellow: #eab308;
  --radius: 16px;

  width: 100%; height: 100%; margin: 0 auto;
  display: flex; flex-direction: column; position: relative; overflow: hidden;
  background: var(--bg); color: var(--t1);
  text-align: left;
  line-height: normal;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

/* ===== 内容区 ===== */
.content { flex: 1; overflow-y: auto; padding: 8px 14px 20px; -webkit-overflow-scrolling: touch }
.sect-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; color: var(--t1); margin: 6px 2px 12px }
.sect-title .bar { width: 4px; height: 16px; border-radius: 3px }
.card { background: var(--card); border-radius: var(--radius); padding: 14px; margin-bottom: 12px }
.card-title { font-size: 13px; font-weight: 700; margin-bottom: 12px }

/* ===== 按钮 ===== */
.btn {
  padding: 10px 16px; border: none; border-radius: 10px; font-size: 13px; font-weight: 600;
  cursor: pointer; color: var(--t1); background: var(--card2); display: inline-flex;
  align-items: center; gap: 6px; transition: 0.2s; font-family: inherit;
}
.btn:active { transform: scale(0.97) }
.btn.primary { background: var(--blue); color: #fff }
.btn.line { background: transparent; border: 1px solid var(--line) }
.btn.red { color: var(--red); background: rgba(239, 68, 68, 0.1) }
.btn.green { color: var(--green); background: rgba(34, 197, 94, 0.1) }
.btn.sm { padding: 6px 10px; font-size: 12px; border-radius: 8px }
.btn:disabled { opacity: 0.7; cursor: default; transform: none }

/* ===== 状态点 ===== */
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; flex-shrink: 0 }
.dot.bg-green { background: var(--green) }
.dot.bg-yellow { background: var(--yellow) }
.dot.bg-red { background: var(--red) }
.dot.bg-gray { background: var(--t3) }
@keyframes breath {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5) }
  50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(34, 197, 94, 0) }
}

/* ===== 服务器概览卡 ===== */
.srv-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px }
.srv-ic {
  width: 44px; height: 44px; border-radius: 12px; background: rgba(59, 130, 246, 0.15);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.srv-main { flex: 1; min-width: 0 }
.srv-name { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.srv-state-row { display: flex; align-items: center; gap: 7px; margin-top: 4px }
.srv-state { font-size: 12px; font-weight: 600 }
.srv-state.green { color: var(--green) }
.srv-state.yellow { color: var(--yellow) }
.srv-state.red { color: var(--red) }
.srv-state.gray { color: var(--t3) }
.srv-up { text-align: right; flex-shrink: 0 }
.up-v { font-size: 13px; font-weight: 700; color: var(--blue); white-space: nowrap }
.up-l { font-size: 10.5px; color: var(--t3) }

/* ===== 键值行 ===== */
.kv { display: flex; justify-content: space-between; font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid var(--line) }
.kv:last-child { border-bottom: none }
.kv .k { color: var(--t3); flex-shrink: 0; margin-right: 12px }
.kv .v { color: var(--t1); font-weight: 500; word-break: break-all; text-align: right }

/* ===== 指标三卡 ===== */
.bigrow { display: flex; gap: 10px }
.bigrow > .card { flex: 1; min-width: 0 }
.m-label { font-size: 12px; color: var(--t3); margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.m-txt { font-size: 11px; color: var(--t2); margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }

/* ===== 进度条 ===== */
.pbar { height: 8px; background: #1e293b; border-radius: 6px; overflow: hidden }
.pbar > div { height: 100%; border-radius: 6px; transition: width 0.5s ease }
.pbar.anim > div { animation: fill 1s ease forwards }
@keyframes fill { from { width: 0 } }
.resbar { width: 100%; height: 5px; background: #1e293b; border-radius: 4px; overflow: hidden; margin-top: 5px }
.resbar > div { height: 100%; border-radius: 4px; transition: width 0.5s }

/* ===== 网络信息 ===== */
.net-row { margin-bottom: 12px }
.net-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--t3); margin-bottom: 5px }
.net-head.flat { margin-bottom: 0 }
.net-v { color: var(--cyan) }
.lat { font-weight: 600 }
.lat.ok { color: var(--green) }
.lat.na { color: var(--t3) }

/* ===== 日志 ===== */
.log-box { max-height: 180px; overflow-y: auto; -webkit-overflow-scrolling: touch }
.log { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; align-items: baseline }
.log:last-child { border-bottom: none }
.log .t { color: var(--t3); flex-shrink: 0; width: 52px }
.log .txt { flex: 1; color: var(--t2); min-width: 0; word-break: break-word }
.more-btn {
  width: 100%; padding: 8px; background: var(--card2); border: none; border-radius: 9px;
  color: var(--t2); font-size: 12px; cursor: pointer; margin-top: 6px; font-weight: 600; font-family: inherit;
}
.more-btn:active { transform: scale(0.98) }

/* ===== 操作按钮行 ===== */
.conn { display: flex; gap: 8px; margin-top: 14px }
.conn .btn { flex: 1; justify-content: center }

/* ===== misc ===== */
.center { text-align: center }
.muted { color: var(--t3); font-size: 12px }

/* ===== 底部导航 ===== */
.tabbar {
  height: 64px; padding-bottom: env(safe-area-inset-bottom); flex-shrink: 0;
  display: flex; background: #0d1322; border-top: 1px solid var(--line); backdrop-filter: blur(10px);
}
.tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; cursor: pointer; color: var(--t3); position: relative; transition: 0.2s; user-select: none;
}
.tab svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round }
.tab span { font-size: 10.5px; font-weight: 500 }
.tab.on { color: var(--blue) }

/* ===== Toast ===== */
.toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(20px);
  background: #1f2937; color: var(--t1); padding: 10px 18px; border-radius: 12px; font-size: 13px;
  z-index: 99; opacity: 0; pointer-events: none; transition: 0.25s;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0) }

/* ===== 弹层（全部日志） ===== */
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: none;
  align-items: flex-end; justify-content: center; z-index: 50;
}
.overlay.show { display: flex; animation: fade 0.25s }
@keyframes fade { from { opacity: 0 } }
.sheet {
  width: 100%; max-width: 480px; background: #12192b; border-radius: 20px 20px 0 0; padding: 20px;
  transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.3, 0.9, 0.3, 1);
  max-height: 88%; overflow: hidden; display: flex; flex-direction: column;
}
.overlay.show .sheet { transform: translateY(0) }
.sheet h3 { font-size: 16px; font-weight: 700; margin-bottom: 14px; color: var(--t1) }
.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0 }
.sheet-head h3 { margin-bottom: 0 }
.close-x {
  width: 30px; height: 30px; padding: 0; border: none; border-radius: 50%;
  background: var(--card2); color: var(--t2); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: 0.15s;
}
.close-x:active { transform: scale(0.92) }
.close-x svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2.2; stroke-linecap: round }

/* 筛选标签 */
.tabs3 { display: flex; gap: 8px; margin: 14px 0 10px }
.tab3 {
  padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
  background: var(--card); color: var(--t3); cursor: pointer; transition: 0.2s;
}
.tab3.on { background: rgba(59, 130, 246, 0.16); color: var(--blue) }

.input {
  padding: 10px 12px; background: var(--card2); border: 1px solid var(--line); border-radius: 10px;
  color: var(--t1); font-size: 13px; width: 100%; outline: none; font-family: inherit; display: block;
}
.input:focus { border-color: var(--blue) }
.input::placeholder { color: var(--t3) }
.log-search { display: flex; gap: 8px; align-items: center; margin-bottom: 6px }
.log-search .btn { flex-shrink: 0 }

/* 日志列表 */
.log-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch }
.log-item {
  display: flex; align-items: flex-start; gap: 8px; padding: 9px 0;
  border-bottom: 1px solid var(--line); font-size: 12.5px;
}
.log-item:last-child { border-bottom: none }
.log-when { color: var(--t3); flex-shrink: 0; width: 92px }
.log-item .st { flex-shrink: 0 }
.log-body { flex: 1; min-width: 0; color: var(--t2); word-break: break-word }
.log-body em { font-style: normal; color: var(--t1); font-weight: 600; margin-right: 6px }

.st {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.st.green { color: var(--green); background: rgba(34, 197, 94, 0.13) }
.st.red { color: var(--red); background: rgba(239, 68, 68, 0.13) }

/* 分页 */
.pager { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 12px; flex-shrink: 0 }
</style>
