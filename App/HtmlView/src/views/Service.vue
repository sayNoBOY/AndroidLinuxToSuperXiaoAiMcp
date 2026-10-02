<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { push } from '../router.js'
import {
  getServerStatus, getServerMetrics,
  getServerLogs, getAllLogs, rebootServer,
  getLlmInfo, switchLlmModel, addLlmProvider, removeLlmProvider,
} from '../api/system.js'
import { changePassword } from '../api/auth.js'

// 依据 随身互联App四Tab原型(6).html Tab4「我的」实现，接口对接 SysApi.js：
//   status / metrics 10s 轮询（文档口径 5~10s），logs 首次 + 重启完成时刷新，
//   reboot 调用 restart.sh 真实重启（前后端一起重启，vite 重载会打断本页 → 用
//   sessionStorage 标记续等、期间静默吞错），全部日志走 /server/logs/all 分页弹层。
//   llm = MiMoCode 大模型调用信息（读 mimocode 配置与模型目录，打开弹窗/切换后刷新）。

const loading = ref(false)
const status = ref(null)    // GET /server/status
const metrics = ref(null)   // GET /server/metrics
const logs = ref([])        // GET /server/logs（最近 5 条）
const lastSync = ref('')    // 最后同步时间（yyyy-MM-dd HH:mm:ss）

// 运行时间：以最近一次 status.uptimeSeconds 为基线，本地每秒累加显示
const upBase = ref(0)
const upAt = ref(0)
const uptimeText = ref('—')

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

async function loadLogs() {
  const d = await getServerLogs({ limit: 5 })
  logs.value = d.list || []
}

/** 三路状态并行拉取：单路失败不拖垮其余；重启窗口内静默（服务本来就 down），返回是否全成功 */
async function loadRuntime() {
  const rs = await Promise.allSettled([loadStatus(), loadMetrics()])
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
    await Promise.allSettled([loadMetrics(), loadLogs()])
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

// ---------- MiMoCode 大模型调用信息（GET /server/llm：配置文件 + 当前模型 + 模型目录） ----------
const llm = ref(null)        // GET /server/llm 响应 data
const llmLoading = ref(false)
const llmError = ref('')     // 模型目录拉取失败时的降级提示（卡片仍展示配置）

const llmCurrent = computed(() => llm.value?.current || null)
const llmModels = computed(() => llm.value?.models || [])
const activeKey = computed(() => llm.value?.current?.active || '')
const activeModel = computed(() => llmModels.value.find((m) => m.key === activeKey.value) || null)
const llmProviders = computed(() => llm.value?.providers || [])
const llmGroups = computed(() => llm.value?.config?.groupNames || [])
const llmCreds = computed(() => llm.value?.credentials || [])

/** token 计数用十进制后缀，与 `mimo models` 输出口径一致（1M / 1.05M / 944K） */
function fmtTokens(n) {
  if (n === null || n === undefined) return '—'
  const trim = (x) => String(Math.round(x * 100) / 100)
  if (n >= 1e6) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${trim(n / 1e3)}K`
  return String(n)
}

const llmWindowText = computed(() => {
  const m = activeModel.value
  if (!m) return '—'
  return `${fmtTokens(m.context)} tokens · 输出 ${fmtTokens(m.output)}`
})
const llmCostText = computed(() => {
  const c = activeModel.value?.cost
  if (!c) return '—'
  return `输入 ${c.input} · 输出 ${c.output}`
})
const llmUrlText = computed(() => activeModel.value?.api?.url || '—')
/** 配置来源：config=顶层 model（哪个文件），state=运行态 recent，default=MiMoCode 默认 */
const llmSourceText = computed(() => {
  const c = llmCurrent.value
  if (!c) return '—'
  if (c.source === 'config') return `${c.sourceFile?.split('/').slice(-2).join('/')} · model`
  if (c.source === 'state') return `${c.stateFile?.split('/').slice(-2).join('/')} · recent`
  return 'MiMoCode 默认'
})
const llmCapText = computed(() => {
  const caps = activeModel.value?.capabilities
  if (!caps) return '—'
  const tags = []
  if (caps.reasoning) tags.push('推理')
  if (caps.toolcall) tags.push('工具调用')
  if (caps.attachment) tags.push('附件')
  const input = caps.input || {}
  if (input.image) tags.push('图像输入')
  if (input.audio) tags.push('音频输入')
  if (input.video) tags.push('视频输入')
  return tags.length ? tags.join(' · ') : '—'
})

async function loadLlm({ refresh = false, quiet = true } = {}) {
  llmLoading.value = true
  try {
    llm.value = await getLlmInfo({ refresh })
    llmError.value = llm.value?.listError || ''
  } catch (e) {
    llmError.value = e?.message || '大模型信息加载失败'
    if (!quiet) toast(llmError.value)
  } finally {
    llmLoading.value = false
  }
}

/** 常态轮询用：只更新数据不切换 loading（否则按钮每 10s 禁用一次），失败静默 */
function pollLlm() {
  getLlmInfo()
    .then((d) => {
      llm.value = d
      llmError.value = d?.listError || ''
    })
    .catch(() => {})
}

// ---------- 切换大模型弹窗 ----------
const swOpen = ref(false)
const swKeyword = ref('')
const swProvider = ref('')      // '' = 全部提供商
const swSelected = ref('')      // 模型 key（provider/model）或分组名
const swSwitching = ref(false)
const swRefreshing = ref(false)
const swError = ref('')

/** 关键字 + 提供商过滤后的可选模型 */
const swModels = computed(() => {
  const kw = swKeyword.value.trim().toLowerCase()
  return llmModels.value.filter((m) => {
    if (swProvider.value && m.providerID !== swProvider.value) return false
    if (!kw) return true
    return `${m.key} ${m.name} ${m.providerID}`.toLowerCase().includes(kw)
  })
})
const swSelectedModel = computed(() => llmModels.value.find((m) => m.key === swSelected.value) || null)
const swIsGroup = computed(() => Boolean(swSelected.value) && !swSelected.value.includes('/'))
const swCanConfirm = computed(
  () => Boolean(swSelected.value) && swSelected.value !== activeKey.value && !swSwitching.value,
)

function openSwitcher() {
  if (rebooting.value) return
  swOpen.value = true
  swKeyword.value = ''
  swProvider.value = ''
  swSelected.value = activeKey.value || ''
  swError.value = ''
  loadLlm({ refresh: true })
}

function pickModel(key) {
  swSelected.value = key
  swError.value = ''
}

async function refreshCatalog() {
  swRefreshing.value = true
  try {
    await loadLlm({ refresh: true, quiet: false })
    if (!llm.value?.models?.length) toast(llmError.value || '模型目录为空')
  } finally {
    swRefreshing.value = false
  }
}

async function confirmSwitch() {
  if (!swCanConfirm.value) return
  swSwitching.value = true
  swError.value = ''
  try {
    const r = await switchLlmModel(swSelected.value)
    swOpen.value = false
    toast(`已切换到 ${r.model} ✓`)
    await loadLlm({ refresh: true, quiet: false })
  } catch (e) {
    swError.value = e?.message || '切换失败'
  } finally {
    swSwitching.value = false
  }
}

function closeSwitcher() {
  if (swSwitching.value) return
  swOpen.value = false
}

// ---------- 新增大模型弹窗（主流厂商预设 / 自定义 OpenAI 兼容端点） ----------
const adOpen = ref(false)
const adSaving = ref(false)
const adError = ref('')
const adPresetId = ref('')   // 选中的预设 id；'' = 自定义填表
const adShowKey = ref(false)

function blankAddForm() {
  return {
    providerId: '', name: '', npm: '@ai-sdk/openai-compatible',
    baseURL: '', modelId: '', modelName: '', apiKey: '', setAsCurrent: true,
  }
}
const adForm = ref(blankAddForm())
const adConfirmDel = ref('')   // 两步删除：先点 × 进入「确认」态，再点一次才删（不用原生 confirm）
const adPresets = computed(() => llm.value?.presets || [])
const adAdapters = computed(() => llm.value?.adapters || [{ npm: '@ai-sdk/openai-compatible', label: 'OpenAI 兼容' }])
/** 已配置的自定义 provider（可删）与内置目录 provider（只读展示） */
const adCustom = computed(() => llm.value?.config?.customProviders || [])
const adCatalog = computed(() => llm.value?.providers || [])
/** 当前填写的 providerId 是否命中内置目录（会并入其既有模型并共用新 baseURL） */
const adIsCatalog = computed(() => adCatalog.value.includes(adForm.value.providerId.trim()))
/** 目录里该 provider 的既有模型 key（提示用，最多列 4 个） */
const adCatalogModels = computed(() =>
  llmModels.value.filter((m) => m.providerID === adForm.value.providerId.trim()).map((m) => m.key),
)
const adCanSubmit = computed(() =>
  !adSaving.value &&
  adForm.value.providerId && adForm.value.npm && adForm.value.baseURL && adForm.value.modelId,
)

function openAdder() {
  if (rebooting.value) return
  adOpen.value = true
  adError.value = ''
  adShowKey.value = false
  adPresetId.value = ''
  adConfirmDel.value = ''
  adForm.value = blankAddForm()
  if (!llm.value) loadLlm()
}

function closeAdder() {
  if (adSaving.value) return
  adOpen.value = false
}

function applyPreset(p) {
  adPresetId.value = p.id
  adConfirmDel.value = ''
  adForm.value = {
    providerId: p.providerId, name: p.label, npm: p.npm,
    baseURL: p.baseURL, modelId: p.modelId, modelName: p.modelName,
    apiKey: adForm.value.apiKey, setAsCurrent: adForm.value.setAsCurrent,
  }
  adError.value = ''
}

async function submitAdd() {
  if (!adCanSubmit.value) return
  adSaving.value = true
  adError.value = ''
  const f = adForm.value
  try {
    const r = await addLlmProvider({
      providerId: f.providerId.trim(),
      name: f.name.trim() || f.providerId.trim(),
      npm: f.npm,
      baseURL: f.baseURL.trim(),
      modelId: f.modelId.trim(),
      modelName: f.modelName.trim() || f.modelId.trim(),
      apiKey: f.apiKey.trim() || undefined,
      setAsCurrent: f.setAsCurrent === true,
    })
    adOpen.value = false
    if (r.verified) {
      const warn = r.endpointConflicts?.length
        ? `（${(r.preservedCatalogModels || []).join('、')} 已并入，端点改用新 baseURL）`
        : ''
      toast(`已新增 ${r.providerId}${r.model ? ` · 当前模型 ${r.model}` : ''} ✓${warn}`)
    } else toast(r.note)
    await loadLlm({ refresh: true, quiet: false })
  } catch (e) {
    adError.value = e?.message || '新增失败'
  } finally {
    adSaving.value = false
  }
}

/** 两步删除：首次点 × 进入「确认」态，再点一次才真正删（不依赖原生 confirm） */
function onDelClick(id) {
  if (adSaving.value) return
  if (adConfirmDel.value !== id) {
    adConfirmDel.value = id
    return
  }
  adConfirmDel.value = ''
  removeProvider(id)
}

async function removeProvider(id) {
  try {
    const r = await removeLlmProvider(id)
    toast(`已删除 ${r.providerId} ✓`)
    await loadLlm({ refresh: true, quiet: false })
  } catch (e) {
    toast(e?.message || '删除失败')
  }
}

// ---------- 修改登录密码弹窗（POST /auth/change-password：当前密码 + 新密码二次确认） ----------
const PWD_MIN_LEN = 6
const pwdOpen = ref(false)
const pwdSaving = ref(false)
const pwdError = ref('')
const pwdForm = ref({ current: '', next: '', confirm: '' })
const pwdShow = ref({ current: false, next: false, confirm: false })

/** 确认框已填但与新密码不一致：实时提示（提交按钮本身也要求一致才可点） */
const pwdMismatch = computed(
  () => pwdForm.value.confirm.length > 0 && pwdForm.value.next !== pwdForm.value.confirm,
)
const pwdCanSubmit = computed(
  () =>
    !pwdSaving.value &&
    pwdForm.value.current.length > 0 &&
    pwdForm.value.next.length >= PWD_MIN_LEN &&
    pwdForm.value.next === pwdForm.value.confirm,
)

function openPwd() {
  if (rebooting.value) return
  pwdOpen.value = true
  pwdError.value = ''
  pwdForm.value = { current: '', next: '', confirm: '' }
  pwdShow.value = { current: false, next: false, confirm: false }
}

function closePwd() {
  if (pwdSaving.value) return
  pwdOpen.value = false
}

async function submitPwd() {
  if (!pwdCanSubmit.value) return
  pwdSaving.value = true
  pwdError.value = ''
  try {
    await changePassword(pwdForm.value.current, pwdForm.value.next, pwdForm.value.confirm)
    pwdOpen.value = false
    pwdForm.value = { current: '', next: '', confirm: '' }
    toast('登录密码修改成功 ✓')
  } catch (e) {
    pwdError.value = e?.message || '修改失败'
  } finally {
    pwdSaving.value = false
  }
}

// ---------- 关于软件信息弹窗 ----------
// 作者/社交账号按用户要求固定展示；开源仓库取自本仓库 git remote（gitee）；
// 打包信息取自任务 73「termux打包问题」的构建产物（智衍 SelfEvolution APK）。
const aboutOpen = ref(false)

const ABOUT_AUTHOR = Object.freeze({
  author: '老实人留一手',
  douyin: '老实人留一手',
  bilibili: '老实人留一手',
})

const ABOUT_REPO = Object.freeze({
  name: 'android-linux-to-super-xiao-ai-mcp',
  url: 'https://gitee.com/liuchunwei123/android-linux-to-super-xiao-ai-mcp',
  ssh: 'git@gitee.com:liuchunwei123/android-linux-to-super-xiao-ai-mcp.git',
  license: 'MIT License',
  branch: 'dev',
})

// 任务 73（taskRes/73/智衍SelfEvolution构建报告.md，aapt2/apksigner 实测口径）
const ABOUT_PKG = Object.freeze([
  { k: '打包任务', v: '#73 termux打包问题' },
  { k: '应用名称', v: '智衍 SelfEvolution' },
  { k: '包名', v: 'com.termux' },
  { k: '版本', v: 'versionName 0.118.0-se1 · versionCode 20260930' },
  { k: 'APK', v: 'SelfEvolution-v0.118.0-se1-universal.apk（212,071,601 字节 ≈ 202 MB）' },
  { k: '签名', v: 'CN=SelfEvolution, OU=SE, O=SelfEvolution, C=CN' },
  { k: 'SDK', v: 'minSdk 21 · targetSdk 28 · compileSdk 36' },
  { k: '构建日期', v: '2026-09-30' },
])

function openAbout() {
  if (rebooting.value) return
  aboutOpen.value = true
}
function closeAbout() {
  aboutOpen.value = false
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
  // 常态轮询：status/metrics 每 10s（文档口径 5~10s；留痕由服务端 7 天策略控制）；
  // llm 同频刷新但不进 loading（服务端模型目录 60s 缓存，接口耗时可忽略）
  pollTimer = setInterval(() => {
    loadRuntime()
    pollLlm()
  }, 10000)
  tickTimer = setInterval(tickUptime, 1000)
  loadLlm() // 大模型调用信息：首屏读一次
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

      <!-- MiMoCode 大模型调用信息（读 mimocode 配置 / 运行态 / 模型目录） -->
      <div class="card">
        <div class="card-title llm-title">
          <span>MiMoCode 大模型</span>
          <span class="llm-badge" :class="llmCurrent ? 'ok' : 'gray'">
            {{ llmLoading && !llm ? '读取中…' : llmError ? '目录异常' : llmCurrent ? '已接入' : '未读取' }}
          </span>
        </div>

        <div class="llm-hero">
          <div class="llm-ic">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z" />
              <path d="M18.5 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" />
            </svg>
          </div>
          <div class="llm-hero-main">
            <div class="llm-name">{{ activeModel?.name || activeKey || 'MiMoCode 默认' }}</div>
            <div class="llm-key">{{ activeKey || '—' }}</div>
          </div>
          <span class="st" :class="activeModel?.status === 'active' ? 'green' : 'red'" v-if="activeModel">
            {{ activeModel.status === 'active' ? '✓ 可用' : '✕ ' + (activeModel.status || '未知') }}
          </span>
        </div>

        <div class="kv"><span class="k">提供商</span><span class="v">{{ activeModel?.providerID || llmProviders.join(' / ') || '—' }}</span></div>
        <div class="kv"><span class="k">上下文窗口</span><span class="v">{{ llmWindowText }}</span></div>
        <div class="kv"><span class="k">接口地址</span><span class="v">{{ llmUrlText }}</span></div>
        <div class="kv"><span class="k">能力</span><span class="v">{{ llmCapText }}</span></div>
        <div class="kv"><span class="k">计费 input/output</span><span class="v">{{ llmCostText }}</span></div>
        <div class="kv"><span class="k">凭据</span>
          <span class="v">{{ llmCreds.length ? llmCreds.map((c) => `${c.provider}(${c.hasKey ? '已配密钥' : '无密钥'})`).join(' · ') : '未配置' }}</span>
        </div>
        <div class="kv"><span class="k">配置来源</span><span class="v">{{ llmSourceText }}</span></div>

        <div class="llm-chips">
          <span class="llm-chips-lab">最近使用</span>
          <span
            v-for="r in (llmCurrent?.recent || []).slice(0, 4)" :key="r"
            class="llm-chip" :class="{ on: r === activeKey }"
          >{{ r.split('/')[1] || r }}</span>
          <span v-if="!(llmCurrent?.recent || []).length" class="llm-chips-empty">—</span>
        </div>
        <div v-if="llmError" class="llm-warn">{{ llmError }}</div>

        <!-- 模块操作：切换 / 新增大模型（按用户要求放在此信息模块内，重启服务器仍在页面底部） -->
        <div class="llm-actions">
          <button class="btn line" :disabled="rebooting || llmLoading" @click="openSwitcher">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" />
              <path d="M3 21v-6h6M21 3v6h-6" />
            </svg>
            切换大模型
          </button>
          <button class="btn primary" :disabled="rebooting || llmLoading" @click="openAdder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新增大模型
          </button>
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

      <!-- 操作按钮：修改密码 + 重启服务器（切换/新增大模型在上方信息模块，查看日志入口 = 「查看全部日志」） -->
      <div class="conn">
        <button class="btn line" :disabled="rebooting" @click="openPwd">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          修改密码
        </button>
        <button class="btn red" :disabled="rebooting" @click="reboot">
          {{ rebooting ? '重启中…' : '重启服务器' }}
        </button>
      </div>
      <!-- 关于软件信息：位于重启服务器按钮正下方，点开弹窗（作者/账号/开源仓库/任务73打包信息） -->
      <div class="conn">
        <button class="btn line" :disabled="rebooting" @click="openAbout">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          关于软件信息
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

    <!-- 切换大模型弹层（GET /server/llm 目录 + POST /server/llm/model 写回 mimocode 配置） -->
    <div class="overlay" :class="{ show: swOpen }" @click.self="closeSwitcher">
      <div class="sheet sheet--llm">
        <div class="sheet-head">
          <h3>切换大模型</h3>
          <button class="close-x" aria-label="关闭" title="关闭" :disabled="swSwitching" @click="closeSwitcher">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div class="sw-cur">
          <div class="sw-cur-main">
            <div class="sw-cur-l">当前模型</div>
            <div class="sw-cur-v">{{ activeKey || 'MiMoCode 默认' }}</div>
            <div class="sw-file">{{ llmSourceText }}</div>
          </div>
          <button class="btn sm line" :disabled="swRefreshing" @click="refreshCatalog">
            {{ swRefreshing ? '刷新中…' : '刷新目录' }}
          </button>
        </div>

        <div class="log-search">
          <input v-model="swKeyword" class="input" placeholder="搜索模型名称 / key / 提供商…" />
        </div>
        <div class="tabs3">
          <div class="tab3" :class="{ on: swProvider === '' }" @click="swProvider = ''">全部</div>
          <div
            v-for="p in llmProviders" :key="p"
            class="tab3" :class="{ on: swProvider === p }"
            @click="swProvider = p"
          >{{ p }}</div>
        </div>

        <div v-if="llmGroups.length" class="sw-grp">
          <span class="sw-grp-l">模型分组</span>
          <span
            v-for="g in llmGroups" :key="g"
            class="grp-chip" :class="{ on: swSelected === g }"
            @click="pickModel(g)"
          >{{ g }}</span>
        </div>

        <div class="log-scroll sw-list">
          <div v-if="llmLoading && !llmModels.length" class="center muted" style="padding: 20px 0">模型加载中…</div>
          <div v-else-if="!swModels.length" class="center muted" style="padding: 20px 0">无匹配的模型</div>
          <label
            v-for="m in swModels" :key="m.key"
            class="sw-item" :class="{ on: swSelected === m.key, cur: m.key === activeKey }"
          >
            <input
              type="radio" name="sw-llm-model" class="sw-radio"
              :checked="swSelected === m.key" :disabled="swSwitching"
              @change="pickModel(m.key)"
            />
            <span class="sw-item-main">
              <span class="sw-item-name">
                {{ m.name }}
                <em class="sw-item-key">{{ m.key }}</em>
              </span>
              <span class="sw-item-meta">
                窗口 {{ fmtTokens(m.context) }} · 输出 {{ fmtTokens(m.output) }} · 计费 {{ m.cost?.input }}/{{ m.cost?.output }}
              </span>
            </span>
            <span class="sw-tags">
              <span v-if="m.isFavorite" class="mini-tag fav" title="收藏">★</span>
              <span v-if="m.key === activeKey" class="mini-tag cur">当前</span>
              <span v-else-if="m.isRecent" class="mini-tag">最近</span>
            </span>
          </label>
        </div>

        <div class="sw-detail">
          <template v-if="swSelectedModel">
            <div class="sw-detail-row"><span>接口地址</span><em>{{ swSelectedModel.api?.url || '—' }}</em></div>
            <div class="sw-detail-row"><span>适配器</span><em>{{ swSelectedModel.api?.npm || '—' }}</em></div>
            <div class="sw-detail-row"><span>变体</span><em>{{ (swSelectedModel.variants || []).join(' / ') || '—' }}</em></div>
          </template>
          <div v-else-if="swIsGroup" class="sw-detail-row">
            <span>模型分组</span><em>{{ swSelected }}（按配置 model_groups 解析）</em>
          </div>
          <div v-else class="sw-detail-row"><span>提示</span><em>请选择要切换的模型</em></div>
        </div>

        <div v-if="swError" class="llm-warn">{{ swError }}</div>

        <div class="sw-foot">
          <button class="btn line" :disabled="swSwitching" @click="closeSwitcher">取消</button>
          <button class="btn primary" :disabled="!swCanConfirm" @click="confirmSwitch">
            {{ swSwitching ? '切换中…' : swCanConfirm ? `切换到 ${swSelectedModel?.name || swSelected}` : (swSelected ? '与当前相同' : '请选择模型') }}
          </button>
        </div>
        <div class="sw-note">切换写回 mimocode 配置的顶层 model；新会话生效，已运行的 MiMoCode 需重新选择或重启。</div>
      </div>
    </div>

    <!-- 新增大模型弹层（厂商预设 / 自定义端点 → POST /server/llm/provider） -->
    <div class="overlay" :class="{ show: adOpen }" @click.self="closeAdder">
      <div class="sheet sheet--add">
        <div class="sheet-head">
          <h3>新增大模型</h3>
          <button class="close-x" aria-label="关闭" title="关闭" :disabled="adSaving" @click="closeAdder">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <!-- 已接入：目录 provider 只读，自定义 provider 可删 -->
        <div v-if="adCatalog.length || adCustom.length" class="ad-exist">
          <span class="ad-lab">已接入</span>
          <span v-for="p in adCatalog" :key="'c' + p" class="ad-chip">{{ p }}</span>
          <span v-for="p in adCustom" :key="'u' + p.id" class="ad-chip own">
            {{ p.id }}<em>{{ p.modelCount }} 模型</em>
            <button
              class="ad-del" :class="{ arm: adConfirmDel === p.id }" :disabled="adSaving"
              :title="adConfirmDel === p.id ? `再次点击确认删除 ${p.id}` : `删除 ${p.id}`"
              @click.stop="onDelClick(p.id)"
            >{{ adConfirmDel === p.id ? '确认' : '×' }}</button>
          </span>
        </div>

        <div class="ad-sec">
          <span class="ad-lab">厂商预设（点击带出，均可改）</span>
          <div class="ad-presets">
            <button
              v-for="p in adPresets" :key="p.id"
              class="ad-preset" :class="{ on: adPresetId === p.id }"
              :disabled="adSaving" type="button" @click="applyPreset(p)"
            >
              <b>{{ p.label }}</b>
            </button>
          </div>
        </div>

        <div class="log-scroll ad-form">
          <label class="ad-field">
            <span>Provider ID</span>
            <input v-model="adForm.providerId" class="input" :disabled="adSaving" placeholder="小写字母/数字/中划线，如 deepseek" />
            <em v-if="adIsCatalog" class="ad-hint">
              「{{ adForm.providerId.trim() }}」是内置目录 provider：其既有模型
              {{ adCatalogModels.slice(0, 4).join('、') }}{{ adCatalogModels.length > 4 ? ' 等' : '' }}
              会一并并入配置保留，并与新模型共用下方 baseURL。
            </em>
          </label>
          <div class="ad-grid">
            <label class="ad-field">
              <span>显示名称</span>
              <input v-model="adForm.name" class="input" :disabled="adSaving" placeholder="DeepSeek" />
            </label>
            <label class="ad-field">
              <span>适配器</span>
              <select v-model="adForm.npm" class="input ad-select" :disabled="adSaving">
                <option v-for="a in adAdapters" :key="a.npm" :value="a.npm">{{ a.label }}</option>
              </select>
            </label>
          </div>
          <label class="ad-field">
            <span>接口地址 baseURL</span>
            <input v-model="adForm.baseURL" class="input" :disabled="adSaving" placeholder="https://api.deepseek.com/v1" />
          </label>
          <div class="ad-grid">
            <label class="ad-field">
              <span>模型 ID</span>
              <input v-model="adForm.modelId" class="input" :disabled="adSaving" placeholder="deepseek-chat" />
            </label>
            <label class="ad-field">
              <span>模型显示名</span>
              <input v-model="adForm.modelName" class="input" :disabled="adSaving" placeholder="DeepSeek Chat" />
            </label>
          </div>
          <label class="ad-field">
            <span>API Key</span>
            <div class="ad-key">
              <input
                v-model="adForm.apiKey" class="input"
                :type="adShowKey ? 'text' : 'password'"
                :disabled="adSaving" placeholder="sk-… 或 {env:MY_KEY}；本地端点可留空"
              />
              <button class="ad-eye" type="button" @click="adShowKey = !adShowKey">
                {{ adShowKey ? '隐藏' : '显示' }}
              </button>
            </div>
          </label>
          <label class="ad-check">
            <input v-model="adForm.setAsCurrent" type="checkbox" :disabled="adSaving" />
            <span>添加后设为当前模型（写入顶层 model 并置入 recent）</span>
          </label>
        </div>

        <div v-if="adError" class="llm-warn">{{ adError }}</div>

        <div class="sw-foot">
          <button class="btn line" :disabled="adSaving" @click="closeAdder">取消</button>
          <button class="btn primary" :disabled="!adCanSubmit" @click="submitAdd">
            {{ adSaving ? '添加中…' : '添加' }}
          </button>
        </div>
        <div class="sw-note">
          预设 baseURL 为厂商公开端点、模型 ID 为可编辑示例（以厂商文档为准）；密钥明文写入 mimocode 配置，
          也可用 <b>{env:VAR}</b> 引用环境变量。写回后新会话生效。
        </div>
      </div>
    </div>

    <!-- 修改登录密码弹层（POST /auth/change-password：校验当前密码 + 新密码二次确认） -->
    <div class="overlay" :class="{ show: pwdOpen }" @click.self="closePwd">
      <div class="sheet sheet--pwd">
        <div class="sheet-head">
          <h3>修改密码</h3>
          <button class="close-x" aria-label="关闭" title="关闭" :disabled="pwdSaving" @click="closePwd">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div class="pwd-form">
          <label class="ad-field">
            <span>当前密码</span>
            <div class="ad-key">
              <input
                v-model="pwdForm.current" class="input"
                :type="pwdShow.current ? 'text' : 'password'"
                :disabled="pwdSaving" autocomplete="current-password"
                placeholder="请输入当前登录密码"
              />
              <button class="ad-eye" type="button" @click="pwdShow.current = !pwdShow.current">
                {{ pwdShow.current ? '隐藏' : '显示' }}
              </button>
            </div>
          </label>

          <label class="ad-field">
            <span>新密码</span>
            <div class="ad-key">
              <input
                v-model="pwdForm.next" class="input"
                :type="pwdShow.next ? 'text' : 'password'"
                :disabled="pwdSaving" autocomplete="new-password"
                :placeholder="`至少 ${PWD_MIN_LEN} 位`"
              />
              <button class="ad-eye" type="button" @click="pwdShow.next = !pwdShow.next">
                {{ pwdShow.next ? '隐藏' : '显示' }}
              </button>
            </div>
          </label>

          <label class="ad-field">
            <span>确认新密码</span>
            <div class="ad-key">
              <input
                v-model="pwdForm.confirm" class="input"
                :type="pwdShow.confirm ? 'text' : 'password'"
                :disabled="pwdSaving" autocomplete="new-password"
                placeholder="请再次输入新密码"
                @keydown.enter="submitPwd"
              />
              <button class="ad-eye" type="button" @click="pwdShow.confirm = !pwdShow.confirm">
                {{ pwdShow.confirm ? '隐藏' : '显示' }}
              </button>
            </div>
            <em v-if="pwdMismatch" class="pwd-err">两次输入的新密码不一致</em>
          </label>

          <em class="pwd-hint">新密码至少 {{ PWD_MIN_LEN }} 位，且不能与当前密码相同；修改成功后请使用新密码登录。</em>
        </div>

        <div v-if="pwdError" class="llm-warn">{{ pwdError }}</div>

        <div class="sw-foot">
          <button class="btn line" :disabled="pwdSaving" @click="closePwd">取消</button>
          <button class="btn primary" :disabled="!pwdCanSubmit" @click="submitPwd">
            {{ pwdSaving ? '提交中…' : '确认修改' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 关于软件信息弹层（软件作者/抖音/B站 + 当前 git 仓库开源信息 + 任务 73 打包信息） -->
    <div class="overlay" :class="{ show: aboutOpen }" @click.self="closeAbout">
      <div class="sheet sheet--about">
        <div class="sheet-head">
          <h3>关于软件信息</h3>
          <button class="close-x" aria-label="关闭" title="关闭" @click="closeAbout">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div class="about-body">
          <div class="about-sec">软件信息</div>
          <div class="kv"><span class="k">软件作者</span><span class="v">{{ ABOUT_AUTHOR.author }}</span></div>
          <div class="kv"><span class="k">抖音账号</span><span class="v">{{ ABOUT_AUTHOR.douyin }}</span></div>
          <div class="kv"><span class="k">b站账号</span><span class="v">{{ ABOUT_AUTHOR.bilibili }}</span></div>

          <div class="about-sec">开源仓库</div>
          <div class="kv"><span class="k">仓库名称</span><span class="v">{{ ABOUT_REPO.name }}</span></div>
          <div class="kv">
            <span class="k">仓库地址</span>
            <a class="v about-link" :href="ABOUT_REPO.url" target="_blank" rel="noopener">{{ ABOUT_REPO.url }}</a>
          </div>
          <div class="kv"><span class="k">SSH 地址</span><span class="v">{{ ABOUT_REPO.ssh }}</span></div>
          <div class="kv"><span class="k">开源协议</span><span class="v">{{ ABOUT_REPO.license }}</span></div>
          <div class="kv"><span class="k">当前分支</span><span class="v">{{ ABOUT_REPO.branch }}</span></div>

          <div class="about-sec">打包信息<span class="about-sec-src">来源：任务 73</span></div>
          <div v-for="row in ABOUT_PKG" :key="row.k" class="kv">
            <span class="k">{{ row.k }}</span><span class="v">{{ row.v }}</span>
          </div>
        </div>

        <div class="sw-foot">
          <button class="btn line" @click="closeAbout">关闭</button>
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
  --blue: #3b82f6; --orange: #f97316; --purple: #a855f7;
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
  max-width: 78%; text-align: center; line-height: 1.5;
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

/* ===== MiMoCode 大模型调用信息卡 ===== */
.llm-title { display: flex; align-items: center; justify-content: space-between; gap: 8px }
.llm-badge { padding: 3px 9px; border-radius: 20px; font-size: 10.5px; font-weight: 700; flex-shrink: 0 }
.llm-badge.ok { color: var(--purple); background: rgba(168, 85, 247, 0.14) }
.llm-badge.gray { color: var(--t3); background: var(--card2) }

.llm-hero {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  background: var(--card2); border-radius: 12px; margin-bottom: 10px;
}
.llm-ic {
  width: 36px; height: 36px; border-radius: 10px; background: rgba(168, 85, 247, 0.14);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.llm-hero-main { flex: 1; min-width: 0 }
.llm-name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.llm-key { font-size: 11px; color: var(--t3); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }

.llm-chips {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line);
}
.llm-chips-lab { font-size: 11px; color: var(--t3); flex-shrink: 0 }
.llm-chip {
  padding: 4px 9px; border-radius: 8px; background: var(--card2); color: var(--t2);
  font-size: 11px; font-weight: 600; max-width: 42%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.llm-chip.on { background: rgba(168, 85, 247, 0.16); color: var(--purple) }
.llm-chips-empty { color: var(--t3); font-size: 11px }
.llm-warn {
  margin-top: 8px; padding: 7px 9px; border-radius: 8px; font-size: 11.5px;
  color: var(--yellow); background: rgba(234, 179, 8, 0.1); word-break: break-all;
}

/* ===== 切换大模型弹层 ===== */
.sw-cur {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  background: var(--card2); border-radius: 12px; padding: 10px 12px; margin-top: 12px; flex-shrink: 0;
}
.sw-cur-main { min-width: 0 }
.sw-cur-l { font-size: 10.5px; color: var(--t3) }
.sw-cur-v { font-size: 14px; font-weight: 700; color: var(--t1); margin-top: 2px; word-break: break-all }
.sw-file { font-size: 10.5px; color: var(--t3); margin-top: 3px; word-break: break-all }
.sheet--llm .log-search { margin-top: 10px; margin-bottom: 0 }
.sheet--llm .tabs3 { margin: 10px 0 8px }

.sw-grp { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; flex-shrink: 0 }
.sw-grp-l { font-size: 11px; color: var(--t3) }
.grp-chip {
  padding: 4px 10px; border-radius: 20px; font-size: 11.5px; font-weight: 600;
  background: var(--card); color: var(--t3); cursor: pointer; transition: 0.2s;
}
.grp-chip.on { background: rgba(168, 85, 247, 0.16); color: var(--purple) }

.sw-list { max-height: 34vh; padding-bottom: 4px }
.sw-item {
  display: flex; align-items: center; gap: 10px; padding: 10px; margin-bottom: 8px;
  border: 1px solid var(--line); border-radius: 10px; cursor: pointer; transition: 0.15s;
}
.sw-item:active { transform: scale(0.99) }
.sw-item.on { border-color: var(--purple); background: rgba(168, 85, 247, 0.1) }
.sw-item.cur { box-shadow: inset 3px 0 0 var(--green) }
.sw-radio { width: 16px; height: 16px; margin: 0; accent-color: var(--purple); flex-shrink: 0 }
.sw-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px }
.sw-item-name { font-size: 13px; font-weight: 700; color: var(--t1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.sw-item-key { font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--t3); margin-left: 6px }
.sw-item-meta { font-size: 11px; color: var(--t2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.sw-tags { display: flex; gap: 4px; flex-shrink: 0 }
.mini-tag {
  font-size: 9.5px; font-weight: 700; padding: 2px 6px; border-radius: 6px;
  background: var(--card2); color: var(--t3);
}
.mini-tag.cur { background: rgba(34, 197, 94, 0.14); color: var(--green) }
.mini-tag.fav { background: rgba(234, 179, 8, 0.14); color: var(--yellow) }

.sw-detail { background: var(--card2); border-radius: 10px; padding: 8px 10px; flex-shrink: 0 }
.sw-detail-row { display: flex; justify-content: space-between; gap: 10px; font-size: 11.5px; padding: 3px 0 }
.sw-detail-row span { color: var(--t3); flex-shrink: 0 }
.sw-detail-row em { font-style: normal; color: var(--t2); text-align: right; word-break: break-all }

.sw-foot { display: flex; gap: 8px; padding-top: 12px; flex-shrink: 0 }
.sw-foot .btn { flex: 1; justify-content: center }
.sw-note { font-size: 10.5px; color: var(--t3); line-height: 1.5; margin-top: 8px; flex-shrink: 0 }
.close-x:disabled { opacity: 0.5 }

/* ===== 信息模块内操作按钮（切换 / 新增大模型） ===== */
.llm-actions {
  display: flex; gap: 8px; margin-top: 12px;
  padding-top: 12px; border-top: 1px solid var(--line);
}
.llm-actions .btn { flex: 1; justify-content: center }

/* ===== 新增大模型弹层 ===== */
.ad-exist { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 12px; flex-shrink: 0 }
.ad-lab { font-size: 11px; color: var(--t3); flex-shrink: 0 }
.ad-chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border-radius: 8px;
  background: var(--card2); color: var(--t2); font-size: 11px; font-weight: 600;
}
.ad-chip em { font-style: normal; font-size: 9.5px; color: var(--t3) }
.ad-chip.own { color: var(--purple); background: rgba(168, 85, 247, 0.12) }
.ad-del {
  width: 16px; height: 16px; padding: 0; border: none; border-radius: 50%;
  background: rgba(239, 68, 68, 0.18); color: var(--red); font-size: 12px; line-height: 1;
  cursor: pointer; font-family: inherit;
}
.ad-del:active { transform: scale(0.9) }
.ad-del:disabled { opacity: 0.5 }
.ad-del.arm {
  width: auto; padding: 0 7px; border-radius: 10px; font-size: 10px; font-weight: 700;
  background: var(--red); color: #fff;
}

.ad-sec { margin-top: 12px; flex-shrink: 0 }
.ad-presets { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px }
.ad-preset {
  display: flex; align-items: center; padding: 6px 10px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--card); cursor: pointer;
  transition: 0.15s; font-family: inherit; text-align: left;
}
.ad-preset b { font-size: 12.5px; color: var(--t1); font-weight: 700 }
.ad-preset.on { border-color: var(--purple); background: rgba(168, 85, 247, 0.12) }
.ad-preset.on b { color: var(--purple) }
.ad-preset:active { transform: scale(0.97) }
.ad-preset:disabled { opacity: 0.6 }

.ad-form { padding-top: 10px; display: flex; flex-direction: column; gap: 9px }
.ad-field { display: flex; flex-direction: column; gap: 5px; min-width: 0 }
.ad-field > span { font-size: 11px; color: var(--t3) }
.ad-hint {
  font-style: normal; font-size: 10.5px; line-height: 1.55; color: var(--yellow);
  background: rgba(234, 179, 8, 0.09); padding: 6px 8px; border-radius: 8px;
}
.ad-grid { display: flex; gap: 8px }
.ad-grid .ad-field { flex: 1; min-width: 0 }
.ad-select { appearance: auto; padding: 9px 10px }
.ad-key { display: flex; gap: 6px; align-items: center }
.ad-key .input { flex: 1; min-width: 0 }
.ad-eye {
  flex-shrink: 0; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: var(--t2); font-size: 11px; cursor: pointer; font-family: inherit;
}
.ad-check {
  display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; color: var(--t2);
  line-height: 1.5; cursor: pointer;
}
.ad-check input { width: 15px; height: 15px; margin-top: 1px; accent-color: var(--purple); flex-shrink: 0 }
.ad-check span { flex: 1 }

/* ===== 修改密码弹层（当前密码 + 新密码二次确认） ===== */
.pwd-form { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; flex-shrink: 0 }
.pwd-err { font-style: normal; font-size: 10.5px; color: var(--red) }
.pwd-hint {
  font-style: normal; font-size: 10.5px; line-height: 1.55; color: var(--t3);
  background: var(--card2); padding: 7px 9px; border-radius: 8px;
}
.sheet--pwd .sw-foot { margin-top: 4px }

/* ===== 关于软件信息弹层 ===== */
.about-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-top: 6px }
.about-sec {
  font-size: 11px; font-weight: 700; color: var(--t3); letter-spacing: 0.4em;
  margin: 14px 0 4px; display: flex; align-items: baseline; justify-content: space-between;
}
.about-sec:first-child { margin-top: 6px }
.about-sec-src { font-weight: 500; letter-spacing: 0; color: var(--t3); opacity: 0.75 }
.about-link { color: var(--blue); text-decoration: none; font-weight: 500 }
.sheet--about .sw-foot { margin-top: 12px }

</style>
