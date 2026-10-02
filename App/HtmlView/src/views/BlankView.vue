<script setup>
import { push } from '../router.js'

// 空白页：底部导航第三个 Tab，占位画布 —— 页面只显示引导提示，
// 内容由用户后续通过任务对话自由添加（本期不预置任何组件）。
</script>

<template>
  <div class="page">
    <!-- 内容区：整页留白，仅居中提示 -->
    <div class="content">
      <div class="blank-hint">
        <svg viewBox="0 0 24 24" class="blank-ic">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-6" />
          <path d="M9 15h6" />
        </svg>
        <p class="blank-txt">空白页随你所想，通过任务对话添加你想要的内容</p>
      </div>
    </div>

    <!-- 底部导航 -->
    <div class="tabbar">
      <div class="tab" @click="push('/')">
        <svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
        <span>首页</span>
      </div>
      <div class="tab on">
        <svg viewBox="0 0 24 24">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span>空白</span>
      </div>
      <div class="tab" @click="push('/service')">
        <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
        <span>我的</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 与 HomeView/Service 的 .page 同值，保证三个 Tab 页切换无视觉跳变 */
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

.content { flex: 1; overflow-y: auto; padding: 8px 14px 20px; -webkit-overflow-scrolling: touch }

/* 居中引导提示 */
.blank-hint {
  min-height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 40px 24px; text-align: center;
}
.blank-ic {
  width: 46px; height: 46px; fill: none; stroke: var(--t3);
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75;
}
.blank-txt {
  max-width: 260px; font-size: 13.5px; line-height: 1.8; color: var(--t2);
}

/* ===== 底部导航（与各 Tab 页同款） ===== */
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
</style>
