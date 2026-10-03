<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import {
  listTasks, createTask, getTask, cancelTask, deleteTask,
  getMessages, sendMessage, getArtifacts, artifactUrl, uploadFiles,
  getTaskUsage, connectTaskEvents, setEventSeq, getTaskCheckpoint,
} from '../api/tasks.js'
import { MD_RE, renderMarkdown } from '../lib/markdown.js'
import { push } from '../router.js'
import { getLlmInfo } from '../api/system.js'

// 依据 随身互联开发文档/设计/随身互联App四Tab原型(6).html 首页（Tab1 任务中心）实现
// 数据接 /api/v1/tasks，WS 实时刷新 + since 重放（断联中继）；除首页外的 Tab 仅保留视觉

const stats = ref({ running: 0, queued: 0, completed: 0, failed: 0 })
const tasks = ref([])
const loading = ref(false)

// 统计卡选中筛选：null = 全部，选中后列表只看该状态（再点一次取消）
const statFilter = ref(null)
const filterLabels = { running: '执行中', queued: '排队中', completed: '已完成', failed: '失败' }
function toggleFilter(state) {
  statFilter.value = statFilter.value === state ? null : state
}

// 新建任务弹层
const newOpen = ref(false)
const newName = ref('')
const newMessage = ref('')
const creating = ref(false)

// 参考物（分步上传：选择 → chips → 提交时先 XHR 上传拿 batch_id）
const MAX_FILES = 5
const MAX_FILE_BYTES = 50 * 1024 * 1024
const newFiles = ref([]) // [{file, name, size}]
const sendFiles = ref([])
const newFileEl = ref(null)
const sendFileEl = ref(null)
const upPct = ref(null) // 非 null = 上传中百分比

// 详情弹层（多轮对话 + 产物）
const detailOpen = ref(false)
const detailTask = ref(null)
const detailMsgs = ref([])
const detailArtifacts = ref([])
const detailLoading = ref(false)
const sendText = ref('')
const sending = ref(false)
const msgsBox = ref(null)

// 当前指令 = 我发出的最新一条消息（多轮会话里 detailTask.message 只是首轮原文）
const currentInstruction = computed(() => {
  const lastUser = [...detailMsgs.value].reverse().find((m) => m.role === 'user')
  return lastUser?.content || detailTask.value?.message || '—'
})

// 执行中的任务：每秒拉一次会话 checkpoint 文件尾部（2 行展示）
const detailCheckpoint = ref('')
let ckptTimer = null

async function fetchCheckpoint() {
  const t = detailTask.value
  if (!detailOpen.value || !t || t.state !== 'running') return
  const id = t.task_id
  try {
    const d = await getTaskCheckpoint(id)
    // 请求期间任务可能被切换/结束：丢弃过期结果
    if (detailOpen.value && detailTask.value?.task_id === id && detailTask.value.state === 'running') {
      detailCheckpoint.value = d?.content || ''
    }
  } catch {
    /* 网络瞬断/弹层已关：忽略，下一秒继续 */
  }
}

watch(detailOpen, (open) => {
  clearInterval(ckptTimer)
  ckptTimer = null
  detailCheckpoint.value = ''
  if (open) {
    fetchCheckpoint()
    ckptTimer = setInterval(fetchCheckpoint, 1000)
  }
})

// 产物预览（应用内全屏层，带返回按钮 —— 不再开新标签页）
const previewArt = ref(null)

// Markdown 预览：拉原文在前端渲染（服务端按 text/plain 直出是浏览器的未处理文本）
const mdHtml = ref('')
const mdRaw = ref('')
const mdLoading = ref(false)
const mdError = ref('')
const mdMode = ref('render') // render = 渲染视图，source = 源码视图
const isMdExt = (name) => MD_RE.test(name)

// 消息全文弹窗（消息记录里长回复只显示 2 行，点击行查看全部）
const fullMsg = ref(null)

// 调用统计信息框（点任务卡左侧「模型缩写」图标弹出：每轮对话 token/费用/耗时）
const usageOpen = ref(false)
const usageTask = ref(null)
const usageData = ref(null)
const usageLoading = ref(false)
const usageErr = ref('')

async function openUsage(t) {
  usageTask.value = t
  usageData.value = null
  usageErr.value = ''
  usageOpen.value = true
  usageLoading.value = true
  try {
    usageData.value = await getTaskUsage(t.task_id)
  } catch (e) {
    usageErr.value = e?.message || '调用统计加载失败'
  } finally {
    usageLoading.value = false
  }
}

function closeUsage() {
  usageOpen.value = false
  usageTask.value = null
  usageData.value = null
  usageErr.value = ''
}

// WS 事件触发的统计刷新（执行中每轮结束 token 会变，防抖合并）
let usageTimer = null
function scheduleUsageRefresh() {
  clearTimeout(usageTimer)
  usageTimer = setTimeout(refreshUsage, 500)
}
async function refreshUsage() {
  if (!usageOpen.value || !usageTask.value) return
  const id = usageTask.value.task_id
  try {
    const d = await getTaskUsage(id)
    if (usageOpen.value && usageTask.value?.task_id === id) usageData.value = d
  } catch {
    /* 网络瞬断/框已关：忽略，下次事件再试 */
  }
}

// 任务卡图标的模型缩写与悬浮提示
function abbrOf(t) {
  return t?.model_abbr || t?.model?.abbr || 'LLM'
}
function modelTitle(t) {
  const m = t?.model
  const full = m ? `${m.provider_id ? m.provider_id + '/' : ''}${m.model_id}` : '尚未调用大模型'
  return `当前会话调用大模型：${full}（点击查看调用统计）`
}

function fmtTok(n) {
  return (n || 0).toLocaleString('en-US')
}
function fmtCost(c) {
  return c > 0 ? `$${c.toFixed(4)}` : '—'
}
// 当前会话上下文大小（最近一次调用送入模型的上下文 token）：按 1 KB = 1024 token 换算成
// KB 显示（与 fmtSize 同口径）；还没调用过显示 —
function fmtCtx(n) {
  return n > 0 ? `${(n / 1024).toFixed(1)} KB` : '—'
}
function fmtDur(s) {
  const v = Math.max(0, Math.round(s || 0))
  return `${p2(Math.floor(v / 60))}:${p2(v % 60)}`
}

// Toast
const toastMsg = ref('')
let toastTimer = null

function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, 1800)
}

function p2(n) {
  return String(n).padStart(2, '0')
}

// ---------- 大模型就绪提醒（进入任务列表时查一次 GET /server/llm） ----------
// 触发条件（第 2 轮口径）：① 当前模型为空（current.active 空）→ 弹；
// ② 当前模型不可用 → 弹：目录里查不到该模型，或其 status !== 'active'
//    —— 与「我的」大模型卡片的 ✓可用 徽标同一判定（models[].status 来自 `mimo models --verbose`）。
const OPEN_ADD_LLM_KEY = 'suishen.openAddLlm' // 与 Service.vue 约定：跳到「我的」并直接打开新增大模型弹窗
const llmNoticeOpen = ref(false)
const llmNoticeReason = ref('') // 弹窗正文：区分「当前模型为空」与「不可用」两种触发原因

async function checkLlmReady() {
  try {
    const d = await getLlmInfo()
    const active = d?.current?.active || ''
    if (!active) {
      llmNoticeReason.value = '尚未配置大模型（当前模型为空），配置后才可以使用任务功能。'
      llmNoticeOpen.value = true
      return
    }
    const m = (d?.models || []).find((x) => x.key === active)
    if (!m) {
      llmNoticeReason.value = `当前大模型 ${active} 不可用：未在模型目录中注册，请重新配置大模型后再使用任务功能。`
      llmNoticeOpen.value = true
      return
    }
    if (m.status !== 'active') {
      llmNoticeReason.value = `当前大模型 ${active} 不可用（目录状态：${m.status || '未知'}），请重新配置大模型后再使用任务功能。`
      llmNoticeOpen.value = true
    }
  } catch {
    /* 读取失败不打扰任务列表，进入页面后仍可正常建任务 */
  }
}

function goAddLlm() {
  llmNoticeOpen.value = false
  sessionStorage.setItem(OPEN_ADD_LLM_KEY, '1')
  push('/service')
}

// ---------- 数据 ----------
async function load() {
  loading.value = true
  try {
    const data = await listTasks()
    stats.value = data.stats
    tasks.value = data.tasks
    setEventSeq(data.server_seq) // 快照水位：WS 重连从这里补发，不多不少
  } catch (e) {
    toast(e?.message || '任务列表加载失败')
  } finally {
    loading.value = false
  }
}

// 排队按先来先服务排序，用于 #序号
const queueTasks = computed(() =>
  tasks.value.filter((t) => t.state === 'queued').sort((a, b) => a.task_id - b.task_id)
)
const queuePos = computed(() => {
  const m = {}
  queueTasks.value.forEach((t, i) => (m[t.task_id] = i + 1))
  return m
})

// 列表顺序 = API 的更新时间倒序（send 受理 / 新轮次派发 / 完成 / 取消都会刷新
// updated_at，继续会话后任务自动冒泡到顶部），不再按状态分组
const visibleTasks = computed(() =>
  statFilter.value ? tasks.value.filter((t) => t.state === statFilter.value) : tasks.value
)

function startText(t) {
  // API 时间为 +08:00 的 ISO，直接取墙上时钟，避免浏览器时区偏移
  return t.started_at ? t.started_at.slice(11, 16) : '—'
}

function durText(t) {
  if (t.state === 'queued') return '排队中'
  const s = t.duration_sec ?? 0
  return `${p2(Math.floor(s / 60))}:${p2(s % 60)}`
}

function createdText(t) {
  return t.created_at ? t.created_at.slice(5, 16).replace('T', ' ') : '—'
}

/** 卡片副行：创建时间（必有）+ 开始时间（跑过才有）+ 耗时/排队状态 */
function subText(t) {
  const parts = [`${createdText(t)} 创建`]
  if (t.started_at) parts.push(`开始 ${startText(t)}`)
  parts.push(`耗时 ${durText(t)}`)
  return parts.join(' · ')
}

// ---------- 操作 ----------
function pauseStub() {
  toast('任务暂不支持暂停，可先取消')
}

async function onCancel(t) {
  try {
    await cancelTask(t.task_id)
    toast('任务已取消')
    await load()
  } catch (e) {
    toast(e?.message || '取消失败')
  }
}

async function onDelete(t) {
  try {
    await deleteTask(t.task_id)
    toast('任务已删除')
    await load()
  } catch (e) {
    toast(e?.message || '删除失败')
  }
}

async function onRetry(t) {
  try {
    const d = await getTask(t.task_id) // 列表不含 message，重试需取详情
    await createTask({ name: d.name, icon: d.icon || '📌', message: d.message || d.name })
    toast('已重试任务')
    await load()
  } catch (e) {
    toast(e?.message || '重试失败')
  }
}

function openNew() {
  newName.value = ''
  newMessage.value = ''
  newOpen.value = true
}

async function submitNew() {
  if (creating.value) return
  const name = newName.value.trim()
  const message = newMessage.value.trim()
  if (!name) return toast('请输入任务名称')
  if (!message) return toast('请输入任务指令')
  creating.value = true
  try {
    const batch = await uploadBatchFor(newFiles) // 有参考物先上传（按钮显示进度）
    await createTask({ name, icon: '📌', message, upload_batch: batch })
    newFiles.value = []
    newOpen.value = false
    toast('任务已创建，MiMoCode 开始执行')
    await load()
  } catch (e) {
    toast(e?.message || '创建失败')
  } finally {
    creating.value = false
    upPct.value = null
  }
}

async function openDetail(t) {
  detailTask.value = null
  detailMsgs.value = []
  detailArtifacts.value = []
  sendText.value = ''
  sendFiles.value = []
  detailOpen.value = true
  detailLoading.value = true
  try {
    const [d, m, a] = await Promise.all([
      getTask(t.task_id),
      getMessages(t.task_id),
      getArtifacts(t.task_id),
    ])
    detailTask.value = d
    detailMsgs.value = m.messages
    detailArtifacts.value = a.artifacts
    scrollMsgs()
  } catch (e) {
    toast(e?.message || '详情加载失败')
    detailOpen.value = false
  } finally {
    detailLoading.value = false
  }
}

// WS 事件触发的详情刷新（消息/状态/产物变化，防抖合并）
let detailTimer = null
function scheduleDetailRefresh() {
  clearTimeout(detailTimer)
  detailTimer = setTimeout(refreshDetail, 300)
}
async function refreshDetail() {
  if (!detailOpen.value || !detailTask.value) return
  const id = detailTask.value.task_id
  try {
    const [d, m, a] = await Promise.all([getTask(id), getMessages(id), getArtifacts(id)])
    if (!detailOpen.value || detailTask.value?.task_id !== id) return
    detailTask.value = d
    detailMsgs.value = m.messages
    detailArtifacts.value = a.artifacts
    scrollMsgs()
  } catch {
    /* 网络瞬断/弹层已关：忽略，下次事件再试 */
  }
}

function scrollMsgs() {
  nextTick(() => {
    // 滚动容器是弹窗的 .sheet-scroll（消息区本身不滚，跟随整页滚到底）
    const el = msgsBox.value?.closest('.sheet-scroll') || msgsBox.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 发送多轮消息（202 受理；执行中自动排队；有参考物先分步上传）
async function onSend() {
  if (sending.value || !detailTask.value) return
  const content = sendText.value.trim()
  if (!content) return toast('请输入指令内容（参考物需配合指令发送）')
  sending.value = true
  try {
    const batch = await uploadBatchFor(sendFiles)
    const r = await sendMessage(detailTask.value.task_id, content, batch)
    sendText.value = ''
    sendFiles.value = []
    // 乐观插入；随后的 WS task_message（含 pending 翻转）会校正
    detailMsgs.value.push({
      msg_id: r.msg_id,
      role: 'user',
      content: r.content,
      pending: r.pending,
      attachments: r.attachments || null,
      created_at: r.created_at,
    })
    if (r.state) detailTask.value.state = r.state
    toast(r.pending ? '已排队，当前轮结束后自动执行' : '已发送')
    scrollMsgs()
  } catch (e) {
    toast(e?.message || '发送失败')
  } finally {
    sending.value = false
    upPct.value = null
  }
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// 产物更新时间：API 为 +08:00 ISO，取墙上时钟 MM-DD HH:mm
function fmtArtTime(iso) {
  return iso ? iso.slice(5, 16).replace('T', ' ') : '—'
}

const PREVIEW_RE = /\.(png|jpe?g|gif|webp|svg|html|pdf|txt|md|json|csv)$/i
const isPreviewable = (name) => PREVIEW_RE.test(name)
const isImageExt = (name) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name)

function openPreview(a) {
  previewArt.value = a
}
function closePreview() {
  previewArt.value = null
}

/** 打开 .md 产物时拉原文并渲染；用 artifact_id 挡住快速切换文件的竞态 */
async function loadMd(a) {
  const id = a.artifact_id
  mdLoading.value = true
  mdError.value = ''
  try {
    const res = await fetch(artifactUrl(detailTask.value.task_id, id, { inline: true }))
    if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`)
    const text = await res.text()
    if (previewArt.value?.artifact_id !== id) return // 已切到别的文件/已关闭
    mdRaw.value = text
    mdHtml.value = renderMarkdown(text, {
      taskId: detailTask.value.task_id,
      relPath: a.rel_path,
      artifacts: detailArtifacts.value,
      artifactUrl,
    })
  } catch (e) {
    if (previewArt.value?.artifact_id !== id) return
    mdError.value = e?.message || 'Markdown 加载失败'
    mdRaw.value = ''
    mdHtml.value = ''
  } finally {
    if (previewArt.value?.artifact_id === id) mdLoading.value = false
  }
}

function retryMd() {
  if (previewArt.value) loadMd(previewArt.value)
}

/** 渲染 / 源码 切换（源码视图复用同一份已拉取的原文） */
function toggleMdMode() {
  mdMode.value = mdMode.value === 'render' ? 'source' : 'render'
}

/** 代码块「复制」按钮：事件从 .md-view 委托进来 */
async function onMdClick(e) {
  const btn = e.target?.closest?.('.md-code-copy')
  if (!btn) return
  const code = btn.closest('.md-code')?.querySelector('code')?.textContent || ''
  try {
    await navigator.clipboard.writeText(code)
  } catch {
    // 非安全上下文（http 预览）没有 clipboard API，退回 execCommand
    const ta = document.createElement('textarea')
    ta.value = code
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  btn.textContent = '已复制'
  setTimeout(() => (btn.textContent = '复制'), 1500)
}

// 切换预览文件时重新加载 Markdown，并复位视图模式
watch(previewArt, (a) => {
  mdMode.value = 'render'
  mdHtml.value = ''
  mdRaw.value = ''
  mdError.value = ''
  mdLoading.value = false
  if (a && isMdExt(a.filename) && detailTask.value) loadMd(a)
})

function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (previewArt.value) return closePreview()
  if (usageOpen.value) return closeUsage()
  if (fullMsg.value) fullMsg.value = null // 消息全文弹窗（详情弹窗本身不随 Esc 关）
}

// ---------- 参考物选择 ----------
// 注意：模板表达式里的 ref 会被自动解包成普通数组，经参数传进来的 list 拿不到 .value
// —— 因此这里用闭包持有 ref 的专用包装函数，绝不把 ref 从模板当参数传。
function pickFilesInto(e, listRef) {
  const chosen = [...(e.target.files || [])]
  e.target.value = '' // 清掉以便再次选同一文件仍触发 change
  for (const f of chosen) {
    if (listRef.value.length >= MAX_FILES) {
      toast(`单次最多 ${MAX_FILES} 个参考物`)
      break
    }
    if (f.size > MAX_FILE_BYTES) {
      toast(`「${f.name}」超过 50MB，已跳过`)
      continue
    }
    if (listRef.value.some((x) => x.name === f.name && x.size === f.size)) continue
    listRef.value.push({ file: f, name: f.name, size: f.size })
  }
}
const pickNewFiles = (e) => pickFilesInto(e, newFiles)
const pickSendFiles = (e) => pickFilesInto(e, sendFiles)
const removeNewFile = (i) => newFiles.value.splice(i, 1)
const removeSendFile = (i) => sendFiles.value.splice(i, 1)
/** 有选中文件则先上传拿 batch_id（进度写 upPct），否则返回 null */
async function uploadBatchFor(list) {
  if (!list.value.length) return null
  upPct.value = 0
  try {
    const r = await uploadFiles(list.value.map((x) => x.file), (p) => (upPct.value = p))
    return r.batch_id
  } finally {
    upPct.value = null
  }
}

/** 消息附件 chips 点击 → 查产物表复用应用内预览层 */
async function openAtt(a) {
  if (!detailTask.value) return
  try {
    const { artifacts } = await getArtifacts(detailTask.value.task_id)
    const hit = artifacts.find((x) => x.filename === a.filename)
    if (!hit) return toast('文件已不存在')
    openPreview(hit)
  } catch (e) {
    toast(e?.message || '打开失败')
  }
}

// ---------- WS 实时刷新 + 断联中继 ----------
let stopWs = null
let reloadTimer = null
function scheduleReload() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 400)
}
function patchProgress({ task_id, progress, duration_sec }) {
  const t = tasks.value.find((x) => x.task_id === task_id)
  if (!t) return scheduleReload()
  if (typeof progress === 'number') t.progress = progress
  if (typeof duration_sec === 'number') t.duration_sec = duration_sec
}

function handleEvent(evt) {
  if (!evt?.event) return
  if (evt.event === 'task_progress') return patchProgress(evt.data)
  if (evt.event === 'task_resync') {
    // 断线太久、服务端事件窗口已滑过：全量重拉兜底（load 会重新对齐 seq）
    load()
    scheduleDetailRefresh()
    return
  }
  scheduleReload()
  if (
    usageOpen.value &&
    typeof evt.data?.task_id === 'number' &&
    evt.data.task_id === usageTask.value?.task_id
  ) {
    scheduleUsageRefresh()
  }
  if (
    detailOpen.value &&
    evt.data?.task_id === detailTask.value?.task_id &&
    (evt.event === 'task_message' ||
      evt.event === 'task_state_changed' ||
      evt.event === 'task_artifacts_changed')
  ) {
    scheduleDetailRefresh()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  checkLlmReady() // 当前模型为空 / 不可用 → 弹窗提醒（不阻塞列表加载）
  await load() // 先拿快照 server_seq，再带 since 连 WS —— 重放恰好覆盖加载后的事件
  stopWs = connectTaskEvents(handleEvent)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  clearTimeout(reloadTimer)
  clearTimeout(detailTimer)
  clearTimeout(usageTimer)
  clearInterval(ckptTimer)
  stopWs?.()
})
</script>

<template>
  <div class="page">
    <!-- 内容区 -->
    <div class="content">
      <div class="sect-title"><span class="bar" style="background: var(--purple)"></span>任务中心</div>

      <!-- 统计：点击选中筛选对应状态，再点取消 -->
      <div class="stats">
        <div class="stat" :class="{ on: statFilter === 'running' }" @click="toggleFilter('running')">
          <div class="n" style="color: var(--blue)">{{ stats.running }}</div>
          <div class="l">执行中</div>
        </div>
        <div class="stat" :class="{ on: statFilter === 'queued' }" @click="toggleFilter('queued')">
          <div class="n" style="color: var(--t2)">{{ stats.queued }}</div>
          <div class="l">排队中</div>
        </div>
        <div class="stat" :class="{ on: statFilter === 'completed' }" @click="toggleFilter('completed')">
          <div class="n" style="color: var(--green)">{{ stats.completed }}</div>
          <div class="l">今日完成</div>
        </div>
        <div class="stat" :class="{ on: statFilter === 'failed' }" @click="toggleFilter('failed')">
          <div class="n" style="color: var(--red)">{{ stats.failed }}</div>
          <div class="l">失败</div>
        </div>
      </div>

      <!-- 任务列表（点卡片任意区域弹出详情；操作区/模型图标各自拦截冒泡） -->
      <div id="taskList">
        <div
          v-for="t in visibleTasks"
          :id="'task' + t.task_id"
          :key="t.task_id"
          class="card"
          @click="openDetail(t)"
        >
          <div class="task-head">
            <!-- 左侧图标 = 当前会话调用大模型的缩写，点击弹出调用统计信息框 -->
            <button
              type="button"
              class="task-ic task-ic--model"
              :title="modelTitle(t)"
              @click.stop="openUsage(t)"
            >{{ abbrOf(t) }}</button>
            <div class="task-main">
              <div class="task-name">{{ t.name }}</div>
              <div class="task-sub">{{ subText(t) }}</div>
            </div>
            <div class="task-st">
              <span v-if="t.state === 'running'" class="st blue"
                ><span class="dot pulse" style="background: var(--blue)"></span>执行中</span
              >
              <span v-else-if="t.state === 'queued'" class="st gray"
                ><span class="dot"></span>排队中 #{{ queuePos[t.task_id] }}</span
              >
              <span v-else-if="t.state === 'completed'" class="st green">✓ 已完成</span>
              <span v-else-if="t.state === 'failed'" class="st red">✕ 失败</span>
              <span v-else class="st red">✕ 已取消</span>
            </div>
          </div>

          <!-- .stop：按钮各自处理点击，不再冒泡到卡片（避免打开详情叠加触发） -->
          <div class="task-ops" @click.stop>
            <!-- 左下角：当前轮对话（列表接口的 current_round，新消息经 WS 重拉自动刷新） -->
            <div v-if="t.current_round" class="task-round" :title="t.current_round.content">
              <span class="round-tag" :class="{ pend: t.current_round.pending }">
                {{ t.current_round.role === 'user' ? '我' : '助手'
                }}{{ t.current_round.pending ? ' · 排队' : '' }}</span
              >
              <span class="round-text">{{ t.current_round.content }}</span>
            </div>
            <template v-if="t.state === 'running'">
              <button class="btn sm line" @click="openDetail(t)">查看详情</button>
              <button class="btn sm line" @click="pauseStub">暂停</button>
              <button class="btn sm red" @click="onCancel(t)">取消</button>
            </template>
            <template v-else-if="t.state === 'queued'">
              <button class="btn sm line" @click="openDetail(t)">查看详情</button>
              <button class="btn sm red" @click="onCancel(t)">取消</button>
            </template>
            <template v-else-if="t.state === 'failed'">
              <button class="btn sm line" @click="openDetail(t)">查看详情</button>
              <button class="btn sm green" @click="onRetry(t)">重试</button>
              <button class="btn sm red" @click="onDelete(t)">删除</button>
            </template>
            <template v-else-if="t.state === 'completed'">
              <button class="btn sm line" @click="openDetail(t)">查看详情</button>
              <button class="btn sm red" @click="onDelete(t)">删除</button>
            </template>
            <template v-else>
              <button class="btn sm line" @click="openDetail(t)">查看详情</button>
              <button class="btn sm red" @click="onDelete(t)">删除</button>
            </template>
          </div>
        </div>

        <div v-if="!visibleTasks.length" class="center muted" style="padding: 30px 0">
          {{
            loading
              ? '加载中…'
              : statFilter
                ? `暂无${filterLabels[statFilter]}任务`
                : '暂无任务，点击下方新建任务'
          }}
        </div>
      </div>
    </div>

    <!-- 新建任务：右下角圆形浮窗 -->
    <button class="fab" aria-label="新建任务" title="新建任务" @click="openNew">
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
    </button>

    <!-- 底部导航（仅首页可用，其余保留视觉） -->
    <div class="tabbar">
      <div class="tab on">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        <span>首页</span>
      </div>
      <div class="tab" @click="push('/blank')">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
        <span>空白</span>
      </div>
      <div class="tab" @click="push('/service')">
        <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>我的</span>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast" :class="{ show: toastMsg }">{{ toastMsg }}</div>

    <!-- 大模型就绪提醒：进入任务列表时，当前模型为空或不可用则弹出，主按钮直达「新增大模型」弹窗 -->
    <div class="overlay" :class="{ show: llmNoticeOpen }" @click.self="llmNoticeOpen = false">
      <div class="sheet sheet--llm-notice">
        <h3>需要配置大模型</h3>
        <p class="llm-notice-txt">{{ llmNoticeReason }}</p>
        <div style="display: flex; gap: 10px; margin-top: 16px">
          <button class="btn line" style="flex: 1; justify-content: center" @click="llmNoticeOpen = false">稍后再说</button>
          <button class="btn primary" style="flex: 1; justify-content: center" @click="goAddLlm">去配置大模型</button>
        </div>
      </div>
    </div>

    <!-- 新建任务弹窗 -->
    <div class="overlay" :class="{ show: newOpen }" @click.self="newOpen = false">
      <div class="sheet">
        <h3>新建任务</h3>
        <input v-model="newName" class="input" placeholder="输入任务名称…" style="margin-bottom: 14px" />
        <textarea
          v-model="newMessage"
          class="input ta"
          placeholder="输入发送给 MiMoCode 的指令…"
          rows="3"
          style="margin-bottom: 14px"
        ></textarea>

        <!-- 参考物（分步上传） -->
        <div class="attach-row">
          <button class="btn sm line" type="button" @click="newFileEl?.click()">📎 添加参考物</button>
          <span class="muted">最多 {{ MAX_FILES }} 个 · 单个 ≤50MB</span>
        </div>
        <div v-if="newFiles.length" class="file-chips">
          <span v-for="(f, i) in newFiles" :key="f.name + i" class="chip">
            {{ f.name }}<em>{{ fmtSize(f.size) }}</em>
            <button class="chip-x" type="button" @click="removeNewFile(i)">×</button>
          </span>
        </div>
        <input
          ref="newFileEl"
          type="file"
          multiple
          hidden
          @change="pickNewFiles"
        />

        <div style="display: flex; gap: 10px; margin-top: 14px">
          <button class="btn line" style="flex: 1; justify-content: center" @click="newOpen = false">取消</button>
          <button class="btn primary" style="flex: 1; justify-content: center" :disabled="creating" @click="submitNew">
            {{ creating ? (upPct != null ? `上传中 ${upPct}%` : '创建中…') : '确认' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 任务详情弹窗：标题行 + 可滚动内容 + 底部固定「继续对话」 -->
    <div class="overlay" :class="{ show: detailOpen }" @click.self="detailOpen = false">
      <div class="sheet sheet--detail">
        <div class="sheet-head">
          <h3>任务详情</h3>
          <button class="close-x" aria-label="关闭" title="关闭" @click="detailOpen = false">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div v-if="detailLoading" class="center muted" style="padding: 20px 0">加载中…</div>
        <template v-else-if="detailTask">
          <div class="sheet-scroll">
            <div class="detail-head">
              <button
                type="button"
                class="task-ic task-ic--model"
                :title="modelTitle(detailTask)"
                @click.stop="openUsage(detailTask)"
              >{{ abbrOf(detailTask) }}</button>
              <div style="flex: 1; min-width: 0">
                <div class="task-name">{{ detailTask.name }}</div>
                <div class="task-sub">{{ startText(detailTask) }} · 耗时 {{ durText(detailTask) }}</div>
              </div>
              <span
                class="st"
                :class="{ blue: detailTask.state === 'running', gray: detailTask.state === 'queued', green: detailTask.state === 'completed', red: detailTask.state === 'failed' || detailTask.state === 'cancelled' }"
              >
                {{ { running: '执行中', queued: '排队中', completed: '✓ 已完成', failed: '✕ 失败', cancelled: '✕ 已取消' }[detailTask.state] }}
              </span>
            </div>
            <div class="kv"><span class="k">任务 ID</span><span class="v">{{ detailTask.task_id }}</span></div>
            <div class="kv"><span class="k">会话 ID</span><span class="v mono">{{ detailTask.session_id || '—' }}</span></div>
            <div v-if="detailTask.error_message" class="kv">
              <span class="k">错误信息</span><span class="v" style="color: var(--red)">{{ detailTask.error_message }}</span>
            </div>
            <div class="kv"><span class="k">当前指令</span><span class="v" style="max-width: 65%; text-align: right">{{ currentInstruction }}</span></div>
            <!-- 执行中：会话 checkpoint 文件尾部（限高两行，每秒拉最新内容） -->
            <div v-if="detailTask.state === 'running'" class="kv kv--ckpt">
              <span class="k">checkpoint</span>
              <span class="v ckpt-box" :title="detailCheckpoint || '暂无 checkpoint 内容'">
                {{ detailCheckpoint || '暂无 checkpoint 内容（写入后每秒自动刷新）' }}
              </span>
            </div>

            <div class="detail-sub">消息记录</div>
            <div v-if="!detailMsgs.length" class="center muted" style="padding: 10px 0">暂无消息</div>
            <div v-else ref="msgsBox" class="msgs">
              <div
                v-for="m in detailMsgs"
                :key="m.msg_id"
                class="msg-row"
                :class="m.role"
                :title="'点击查看完整内容'"
                @click="fullMsg = m"
              >
                <span class="msg-role">{{ m.role === 'user' ? '我' : 'MiMoCode' }}</span>
                <span class="msg-content">{{ m.content }}</span>
                <span v-if="m.pending" class="st gray pending-tag">排队中</span>
                <div v-if="m.attachments?.length" class="msg-atts">
                  <button
                    v-for="a in m.attachments"
                    :key="a.filename"
                    class="att-chip"
                    type="button"
                    :title="'点击查看：' + a.filename"
                    @click.stop="openAtt(a)"
                  >
                    📎 {{ a.filename }}<span>{{ fmtSize(a.size) }}</span>
                  </button>
                </div>
              </div>
              <div v-if="detailTask.state === 'running'" class="muted" style="padding: 8px 0 0 76px">
                MiMoCode 执行中，回复会在完成后出现…
              </div>
            </div>

            <!-- 产物：列表 + 在线预览 / 下载 -->
            <div class="detail-sub">
              产物 <span v-if="detailArtifacts.length" class="muted">({{ detailArtifacts.length }})</span>
            </div>
            <div v-if="!detailArtifacts.length" class="center muted" style="padding: 6px 0">
              暂无产物文件
            </div>
            <div v-for="a in detailArtifacts" :key="a.artifact_id" class="art-row">
              <span class="art-name" :title="a.rel_path">{{ a.filename }}</span>
              <span class="art-size" :title="a.mtime">{{ fmtArtTime(a.mtime) }} · {{ fmtSize(a.size) }}</span>
              <button
                v-if="isPreviewable(a.filename)"
                class="btn sm line"
                @click="openPreview(a)"
              >预览</button>
              <a
                class="btn sm green"
                :href="artifactUrl(detailTask.task_id, a.artifact_id)"
                :download="a.filename"
              >下载</a>
            </div>
          </div>

          <!-- 底部固定：继续对话（执行中发送会自动排队） -->
          <div class="sheet-foot">
            <div class="send-row">
              <input
                v-model="sendText"
                class="input"
                placeholder="发送新消息（执行中将排队等待）"
                :disabled="sending"
                @keydown.enter.prevent="onSend"
              />
              <button
                class="btn primary"
                :disabled="sending || !sendText.trim()"
                @click="onSend"
              >
                {{ sending ? (upPct != null ? `${upPct}%` : '…') : '发送' }}
              </button>
            </div>
            <div class="attach-row">
              <button class="btn sm line" type="button" :disabled="sending" @click="sendFileEl?.click()">
                📎 添加参考物
              </button>
              <span class="muted">最多 {{ MAX_FILES }} 个 · 单个 ≤50MB</span>
            </div>
            <div v-if="sendFiles.length" class="file-chips">
              <span v-for="(f, i) in sendFiles" :key="f.name + i" class="chip">
                {{ f.name }}<em>{{ fmtSize(f.size) }}</em>
                <button class="chip-x" type="button" @click="removeSendFile(i)">×</button>
              </span>
            </div>
            <input
              ref="sendFileEl"
              type="file"
              multiple
              hidden
              :disabled="sending"
              @change="pickSendFiles"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- 调用统计信息框：点任务卡/详情的模型缩写图标弹出（z 60 — 叠在详情 50 之上） -->
    <div class="overlay usage-overlay" :class="{ show: usageOpen }" @click.self="closeUsage">
      <div class="sheet sheet--usage">
        <div class="sheet-head">
          <h3>调用统计</h3>
          <button class="close-x" aria-label="关闭" title="关闭" @click="closeUsage">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div v-if="usageLoading" class="center muted" style="padding: 20px 0">加载中…</div>
        <div v-else-if="usageErr" class="usage-err">{{ usageErr }}</div>
        <template v-else-if="usageData">
          <!-- 当前会话调用的大模型 -->
          <div class="usage-model">
            <span class="usage-abbr">{{ usageData.model?.abbr || 'LLM' }}</span>
            <div class="usage-model-main">
              <div class="usage-model-id">
                {{
                  usageData.model
                    ? `${usageData.model.provider_id ? usageData.model.provider_id + '/' : ''}${usageData.model.model_id}`
                    : '尚未调用大模型'
                }}
              </div>
              <div class="muted">当前会话调用大模型 · {{ usageData.session_id || '会话未创建' }}</div>
            </div>
          </div>

          <!-- 汇总 -->
          <div class="usage-grid">
            <div class="ug"><b>{{ usageData.totals.rounds }}</b><span>轮对话</span></div>
            <div class="ug"><b>{{ usageData.totals.calls }}</b><span>模型调用</span></div>
            <div class="ug"><b>{{ fmtTok(usageData.totals.tokens.total) }}</b><span>总 Token</span></div>
            <div class="ug" title="当前会话上下文大小（1 KB = 1024 token）"><b>{{ fmtCtx(usageData.totals.context_tokens) }}</b><span>上下文大小</span></div>
          </div>
          <div class="usage-break muted">
            输入 {{ fmtTok(usageData.totals.tokens.input) }} · 输出
            {{ fmtTok(usageData.totals.tokens.output) }} · 推理
            {{ fmtTok(usageData.totals.tokens.reasoning) }} · 缓存读
            {{ fmtTok(usageData.totals.tokens.cache_read) }} · 缓存写
            {{ fmtTok(usageData.totals.tokens.cache_write) }} · 总耗时
            {{ fmtDur(usageData.totals.duration_sec) }}
          </div>

          <!-- 每轮对话统计 -->
          <div class="detail-sub">每轮对话统计</div>
          <div v-if="!usageData.rounds.length" class="center muted" style="padding: 10px 0">
            暂无对话记录{{ usageData.session_id ? '' : '（会话尚未创建）' }}
          </div>
          <div v-for="r in usageData.rounds" :key="r.round" class="round-card">
            <div class="rc-head">
              <span class="rc-no">第 {{ r.round }} 轮</span>
              <span
                class="st"
                :class="{ green: r.status === 'done', blue: r.status === 'running', gray: r.status === 'pending' }"
              >{{
                r.status === 'running' ? '执行中' : r.status === 'pending' ? '等待回复' : '已完成'
              }}</span>
              <span class="muted rc-time">{{ r.started_at ? r.started_at.slice(5, 16).replace('T', ' ') : '' }}</span>
            </div>
            <div v-if="r.preview" class="rc-preview">{{ r.preview }}</div>
            <div class="rc-stats">
              <span>调用 {{ r.calls }}</span>
              <span>Token {{ fmtTok(r.tokens.total) }}</span>
              <span>入 {{ fmtTok(r.tokens.input) }}</span>
              <span>出 {{ fmtTok(r.tokens.output) }}</span>
              <span>推理 {{ fmtTok(r.tokens.reasoning) }}</span>
              <span>缓存 {{ fmtTok(r.tokens.cache_read + r.tokens.cache_write) }}</span>
              <span>费用 {{ fmtCost(r.cost) }}</span>
              <span>耗时 {{ fmtDur(r.duration_sec) }}</span>
            </div>
            <div v-if="r.models.length" class="rc-model muted">模型 {{ r.models.join('、') }}</div>
          </div>
        </template>
      </div>
    </div>

    <!-- 产物预览：应用内全屏层（返回按钮回详情，不开新标签页） -->
    <div class="preview-overlay" :class="{ show: !!previewArt }">
      <template v-if="previewArt && detailTask">
        <div class="preview-bar">
          <button class="btn sm line" @click="closePreview">← 返回</button>
          <span class="preview-name" :title="previewArt.rel_path">{{ previewArt.filename }}</span>
          <!-- Markdown：渲染 / 源码 双视图切换 -->
          <span v-if="isMdExt(previewArt.filename) && !mdError && !mdLoading" class="md-toggle">
            <button
              class="btn sm"
              :class="mdMode === 'render' ? 'primary' : 'line'"
              @click="mdMode = 'render'"
            >渲染</button>
            <button
              class="btn sm"
              :class="mdMode === 'source' ? 'primary' : 'line'"
              @click="mdMode = 'source'"
            >源码</button>
          </span>
          <a class="btn sm green" :href="artifactUrl(detailTask.task_id, previewArt.artifact_id)" :download="previewArt.filename">下载</a>
        </div>
        <div class="preview-body" :class="{ 'md-body': isMdExt(previewArt.filename) }" @click.self="closePreview">
          <!-- Markdown：前端渲染成文档（标题/表格/列表/代码高亮/图片内链…） -->
          <div v-if="isMdExt(previewArt.filename)" class="md-wrap" @click="onMdClick">
            <div v-if="mdLoading" class="center muted" style="padding: 40px 0">Markdown 渲染中…</div>
            <div v-else-if="mdError" class="md-error">
              <p>{{ mdError }}</p>
              <button class="btn sm line" @click.stop="retryMd">重试</button>
            </div>
            <pre v-else-if="mdMode === 'source'" class="md-source">{{ mdRaw }}</pre>
            <article v-else class="md-view" v-html="mdHtml"></article>
          </div>
          <img
            v-else-if="isImageExt(previewArt.filename)"
            :src="artifactUrl(detailTask.task_id, previewArt.artifact_id, { inline: true })"
            :alt="previewArt.filename"
          />
          <iframe
            v-else
            :src="artifactUrl(detailTask.task_id, previewArt.artifact_id, { inline: true })"
            :title="previewArt.filename"
          ></iframe>
        </div>
      </template>
    </div>

    <!-- 消息全文弹窗：点击消息行弹出（z 60 — 高于详情 50，低于产物预览 70） -->
    <div class="overlay msg-overlay" :class="{ show: !!fullMsg }" @click.self="fullMsg = null">
      <div v-if="fullMsg" class="sheet msg-sheet">
        <div class="sheet-head">
          <h3>{{ fullMsg.role === 'user' ? '我' : 'MiMoCode' }}</h3>
          <button class="close-x" aria-label="关闭" @click="fullMsg = null">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="msg-full-meta muted">
          发送时间 {{ fullMsg.created_at?.slice(0, 19).replace('T', ' ') }}
        </div>
        <div class="msg-full-body">{{ fullMsg.content }}</div>
        <div v-if="fullMsg.attachments?.length" class="msg-atts" style="padding-left: 0">
          <button
            v-for="a in fullMsg.attachments"
            :key="a.filename"
            class="att-chip"
            type="button"
            @click.stop="openAtt(a)"
          >
            📎 {{ a.filename }}<span>{{ fmtSize(a.size) }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 样式逐值复刻自 随身互联App四Tab原型(6).html 的首页相关规则 */
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
  text-align: left; /* 覆盖 Vite 脚手架 #app { text-align: center } 的全局继承 */
  line-height: normal; /* 覆盖脚手架全局 line-height:145%，与原型排版一致 */
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

/* ===== 内容区 ===== */
.content { flex: 1; overflow-y: auto; padding: 8px 14px 20px; -webkit-overflow-scrolling: touch }
.sect-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; color: var(--t1); margin: 6px 2px 12px }
.sect-title .bar { width: 4px; height: 16px; border-radius: 3px }
.card {
  background: var(--card); border-radius: var(--radius); padding: 14px; margin-bottom: 12px;
  cursor: pointer; transition: transform 0.12s;
}
.card:active { transform: scale(0.985) }

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
.btn:disabled { opacity: 0.7; cursor: default }

/* ===== 新建任务浮窗 ===== */
.fab {
  position: fixed; right: 20px; bottom: 84px; z-index: 30;
  width: 56px; height: 56px; border: none; border-radius: 50%;
  background: var(--blue); color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 20px rgba(59, 130, 246, 0.45);
  transition: 0.2s;
}
.fab:active { transform: scale(0.94) }
.fab svg { width: 26px; height: 26px; stroke: currentColor; fill: none; stroke-width: 2.4; stroke-linecap: round }

/* ===== 状态标签 ===== */
.st {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.st.blue { color: var(--blue); background: rgba(59, 130, 246, 0.13) }
.st.gray { color: var(--t3); background: rgba(156, 163, 175, 0.12) }
.st.green { color: var(--green); background: rgba(34, 197, 94, 0.13) }
.st.red { color: var(--red); background: rgba(239, 68, 68, 0.13) }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block }
.pulse { animation: pulse 1.2s infinite }
@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }

/* ===== 统计 ===== */
.stats { display: flex; gap: 10px; margin-bottom: 14px }
.stat {
  flex: 1; background: var(--card); border-radius: var(--radius); padding: 14px;
  text-align: center; cursor: pointer; transition: 0.2s;
}
.stat .n { font-size: 24px; font-weight: 700 }
.stat .l { font-size: 11px; color: var(--t3); margin-top: 2px }
.stat:active { transform: scale(0.96) }
.stat.on { box-shadow: inset 0 0 0 2px var(--blue); background: rgba(59, 130, 246, 0.08) }
.stat.on .l { color: var(--blue) }

/* ===== 任务卡（原型为内联样式，此处类名化、值一致） ===== */
.task-head { display: flex; align-items: center; gap: 12px }
.task-ic {
  width: 40px; height: 40px; border-radius: 11px; background: var(--card2);
  display: flex; align-items: center; justify-content: center; font-size: 19px; flex-shrink: 0;
}
/* 任务卡图标 = 会话大模型缩写（点击弹调用统计信息框） */
.task-ic--model {
  padding: 0; border: none; cursor: pointer; font-family: inherit;
  font-size: 11px; font-weight: 800; letter-spacing: 0.3px;
  color: var(--blue); background: rgba(59, 130, 246, 0.12);
  transition: 0.15s;
}
.task-ic--model:active { transform: scale(0.92) }
.task-main { flex: 1; min-width: 0 }
.task-name { font-size: 14px; font-weight: 600; color: var(--t1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.task-sub { font-size: 11px; color: var(--t3); margin-top: 2px }
.task-st { text-align: right }
.task-ops { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; align-items: center }
/* 卡片左下角：当前轮对话预览（占满按钮左侧剩余宽度，超长省略） */
.task-round {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--t3); text-align: left;
}
.round-tag {
  flex-shrink: 0; font-size: 10.5px; line-height: 1.5; padding: 1px 6px;
  border-radius: 6px; background: var(--card2); color: var(--t2); white-space: nowrap;
}
.round-tag.pend { color: var(--yellow) }
.round-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.task-ops .btn { flex-shrink: 0 }

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

/* ===== 弹窗 ===== */
.overlay {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: none;
  align-items: flex-end; justify-content: center; z-index: 50;
}
.overlay.show { display: flex; animation: fade 0.25s }
@keyframes fade { from { opacity: 0 } }
.sheet {
  width: 100%; max-width: 480px; background: #12192b; border-radius: 20px 20px 0 0; padding: 20px;
  transform: translateY(100%); transition: transform 0.3s cubic-bezier(0.3, 0.9, 0.3, 1);
  max-height: 88%; overflow-y: auto;
}
.overlay.show .sheet { transform: translateY(0) }
.sheet h3 { font-size: 16px; font-weight: 700; margin-bottom: 14px; color: var(--t1) }

/* 大模型就绪提醒弹窗：正文（为空/不可用两种原因）+ 双按钮（去配置大模型 → 跳「我的」并打开新增弹窗） */
.llm-notice-txt { font-size: 13px; line-height: 1.7; color: var(--t2); margin: 0 }

/* 任务详情弹窗：标题行 + 滚动内容 + 底部固定「继续对话」 */
.sheet--detail {
  display: flex; flex-direction: column;
  max-height: 88%; padding-bottom: 0; overflow: hidden;
}
.sheet-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-shrink: 0; margin-bottom: 14px;
}
.sheet-head h3 { margin-bottom: 0 }
/* 标题行右侧的关闭：圆形叉图标 */
.close-x {
  width: 30px; height: 30px; padding: 0; border: none; border-radius: 50%;
  background: var(--card2); color: var(--t2); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: 0.15s;
}
.close-x:active { transform: scale(0.92) }
.close-x svg {
  width: 14px; height: 14px; stroke: currentColor; fill: none;
  stroke-width: 2.2; stroke-linecap: round;
}
.sheet-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch }
.sheet-foot {
  flex-shrink: 0; background: #12192b;
  border-top: 1px solid var(--line);
  margin: 0 -20px; padding: 12px 20px calc(20px + env(safe-area-inset-bottom));
  border-radius: 0 0 20px 20px;
}

/* ===== misc ===== */
.center { text-align: center }
.muted { color: var(--t3); font-size: 12px }

.toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%) translateY(20px);
  background: #1f2937; color: var(--t1); padding: 10px 18px; border-radius: 12px; font-size: 13px;
  z-index: 99; opacity: 0; pointer-events: none; transition: 0.25s;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0) }

.input {
  padding: 10px 12px; background: var(--card2); border: 1px solid var(--line); border-radius: 10px;
  color: var(--t1); font-size: 13px; width: 100%; outline: none; font-family: inherit; display: block;
}
.input:focus { border-color: var(--blue) }
.input::placeholder { color: var(--t3) }
.ta { resize: none; line-height: 1.5 }

.kv { display: flex; justify-content: space-between; font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid var(--line) }
.kv:last-child { border-bottom: none }
.kv .k { color: var(--t3); flex-shrink: 0; margin-right: 12px }
.kv .v { color: var(--t1); font-weight: 500; word-break: break-all }
/* 执行中的 checkpoint：文件尾部两行，限高 + 超长截断（每秒轮询刷新） */
.kv--ckpt { align-items: flex-start }
.ckpt-box {
  flex: 1; min-width: 0; max-width: 75%; text-align: right;
  font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.5;
  color: var(--t2); font-weight: 400; white-space: pre-wrap;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; max-height: calc(2 * 1.5 * 11px); /* clamp 不生效时兜底也只占两行 */
}

/* 详情弹层（沿用原型 detail-panel / kv 设计语言） */
.detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px }
.detail-sub { font-size: 13px; font-weight: 700; color: var(--t1); margin: 12px 0 4px }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px; font-weight: 400 !important }
.msg-row {
  display: flex; gap: 8px; flex-wrap: wrap; padding: 7px 0; border-bottom: 1px solid var(--line);
  font-size: 12.5px; line-height: 1.5; cursor: pointer; transition: background 0.15s;
}
.msg-row:active { background: rgba(255, 255, 255, 0.03) }
.msg-row:last-child { border-bottom: none }
.msg-role { flex-shrink: 0; width: 68px; color: var(--t3); font-weight: 600; font-size: 11px; padding-top: 1px }
.msg-row.user .msg-role { color: var(--blue) }
.msg-content { flex: 1; color: var(--t2); word-break: break-word; white-space: pre-wrap }
/* MiMoCode 回复过长只显示 2 行，点击行弹窗看全文 */
.msg-row.assistant .msg-content {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; max-height: calc(2 * 1.5 * 12.5px); /* 兜底：clamp 不生效时也只占 2 行 */
}
.pending-tag { align-self: flex-start; flex-shrink: 0 }

/* 消息附件 chips（点击复用应用内预览层） */
.msg-atts { flex-basis: 100%; padding-left: 76px; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px }
.att-chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
  padding: 4px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--card2); color: var(--blue); font-size: 11.5px; font-weight: 600;
  cursor: pointer; font-family: inherit; transition: 0.15s;
}
.att-chip:active { transform: scale(0.97) }
.att-chip span { color: var(--t3); font-weight: 400 }

/* 参考物选择（新建弹窗 + 继续对话共用） */
.attach-row { display: flex; align-items: center; gap: 10px; margin-top: 10px }
.file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px }
.chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 5px 8px 5px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--card2); font-size: 11.5px; color: var(--t1);
}
.chip em { font-style: normal; color: var(--t3); font-size: 10.5px; flex-shrink: 0 }
.chip-x {
  border: none; background: rgba(239, 68, 68, 0.15); color: var(--red);
  width: 16px; height: 16px; border-radius: 50%; font-size: 11px; line-height: 1;
  cursor: pointer; flex-shrink: 0; padding: 0; font-family: inherit;
}

/* 继续对话：输入 + 发送 */
.send-row { display: flex; gap: 8px; align-items: stretch }
.send-row .input { flex: 1 }
.send-row .btn { flex-shrink: 0; padding: 10px 18px }

/* 产物行 */
.art-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 0;
  border-bottom: 1px solid var(--line); font-size: 12.5px;
}
.art-row:last-child { border-bottom: none }
.art-name { flex: 1; min-width: 0; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.art-size { color: var(--t3); font-size: 11px; flex-shrink: 0 }
a.btn { text-decoration: none; justify-content: center }

/* 消息全文弹窗（叠在详情之上，低于产物预览 70） */
.msg-overlay { z-index: 60 }
.msg-sheet { padding-bottom: 20px }
.msg-full-meta { font-size: 11px; margin: -6px 0 10px }
.msg-full-body {
  font-size: 13px; line-height: 1.65; color: var(--t1); white-space: pre-wrap;
  word-break: break-word; max-height: 50vh; overflow-y: auto;
  -webkit-overflow-scrolling: touch; background: var(--card2);
  border: 1px solid var(--line); border-radius: 10px; padding: 12px;
}

/* ===== 调用统计信息框（模型图标点开） ===== */
.usage-overlay { z-index: 60 }
.usage-err { color: var(--red); font-size: 13px; text-align: center; padding: 16px 0 }
.usage-model {
  display: flex; align-items: center; gap: 12px; padding: 12px;
  background: var(--card2); border: 1px solid var(--line);
  border-radius: 12px; margin-bottom: 12px;
}
.usage-abbr {
  width: 44px; height: 44px; border-radius: 11px; flex-shrink: 0;
  background: rgba(59, 130, 246, 0.14); color: var(--blue);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 800; letter-spacing: 0.5px;
}
.usage-model-main { flex: 1; min-width: 0 }
.usage-model-id { font-size: 13px; font-weight: 600; color: var(--t1); word-break: break-all }
.usage-model-main .muted { margin-top: 2px }
.usage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 8px }
.ug {
  background: var(--card2); border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 4px; text-align: center;
}
.ug b { display: block; font-size: 14px; color: var(--blue); font-weight: 700; word-break: break-all }
.ug span { font-size: 10.5px; color: var(--t3) }
.usage-break { text-align: center; font-size: 11px; line-height: 1.6 }
.round-card {
  background: var(--card2); border: 1px solid var(--line);
  border-radius: 10px; padding: 10px; margin-top: 8px;
}
.rc-head { display: flex; align-items: center; gap: 8px }
.rc-no { font-size: 12.5px; font-weight: 700; color: var(--t1) }
.rc-time { margin-left: auto; font-size: 10.5px }
.rc-preview {
  font-size: 11.5px; color: var(--t3); margin-top: 6px;
  line-height: 1.5; word-break: break-all;
}
.rc-stats { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; font-size: 11px; color: var(--t2) }
.rc-stats span { white-space: nowrap }
.rc-model { font-size: 10.5px; margin-top: 6px; word-break: break-all }

/* 产物预览全屏层（z 高于详情 overlay=50，低于 toast=99） */
.preview-overlay {
  position: fixed; inset: 0; z-index: 70; background: #05070d;
  display: none; flex-direction: column;
}
.preview-overlay.show { display: flex; animation: fade 0.2s }
.preview-bar {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  background: #0d1322; border-bottom: 1px solid var(--line); flex-shrink: 0;
  padding-top: calc(10px + env(safe-area-inset-top));
}
.preview-name {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--t1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.preview-body {
  flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  overflow: auto; padding: 12px; -webkit-overflow-scrolling: touch;
}
.preview-body img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px }
.preview-body iframe { width: 100%; height: 100%; border: none; border-radius: 8px; background: #fff }

/* ---- Markdown 预览 ----
   预览层原本是给图片/iframe 用的 flex 居中容器：内容一旦比视口宽，
   居中溢出会让左右两侧同时被裁掉。md 模式改回常规块流，页面不横向溢出，
   宽内容（表格/代码）在自己容器里横向滚动。 */
.preview-body.md-body {
  display: block;
  overflow-x: hidden;
  overflow-y: auto;
}
.md-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  /* 关掉安卓浏览器的字号自动放大（Text Autosizing），避免预览文字忽大忽小、缩放后发虚 */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
/* v-html 里的节点没有当前组件的 scoped 属性，必须用 :deep 才能命中 */
.md-view {
  min-width: 0;
  font-size: 15px;
  line-height: 1.75;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.md-view :deep(img) { max-width: 100%; height: auto; border-radius: 8px }
.md-view :deep(a) { word-break: break-all }
/* 全局 code 是 inline-flex，长令牌断不开行会把整页撑宽：改回可断行 */
.md-view :deep(code) {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.md-view :deep(.md-table) {
  max-width: 100%;
  margin: 10px 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.md-view :deep(.md-table table) { border-collapse: collapse }
.md-view :deep(.md-table th),
.md-view :deep(.md-table td) {
  padding: 6px 10px;
  border: 1px solid var(--line);
  text-align: left;
  white-space: nowrap;
}
.md-view :deep(.md-table code) { max-width: none }
.md-view :deep(.md-code) {
  max-width: 100%;
  margin: 10px 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--code-bg);
  /* 同 .md-source：--code-bg 底上必须用高对比前景，继承的浅灰字看不清 */
  color: var(--text-h);
}
.md-view :deep(.md-code-hd) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--t2);
  background: color-mix(in srgb, var(--line) 60%, transparent);
}
.md-view :deep(.md-code pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.md-view :deep(.md-code pre code) {
  display: block;
  max-width: none;
  padding: 0;
  background: none;
  white-space: pre;
  word-break: normal;
}
.md-source {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 10px 12px;
  /* 源码保留空白与换行，但超宽自动折行：手机上不必横向拖动或捏合缩放
     （缩放后浏览器重新栅格化文字会发虚），超长 token 同样能断开 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: hidden;
  font-size: 14px;
  line-height: 1.65;
  tab-size: 4;
  border-radius: 8px;
  background: var(--code-bg);
  /* 底色是 --code-bg，继承来的 --t1(#e5e7eb) 浅灰字压在上面几乎看不清；
     换成与行内 code 一致的高对比前景：浅色底 = #08060d(近黑)，深色底 = #f3f4f6 */
  color: var(--text-h);
}
</style>
