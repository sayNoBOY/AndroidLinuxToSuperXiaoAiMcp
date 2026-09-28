<script setup>
import { currentRoute } from './router.js'
</script>

<template>
  <div
    class="route-view"
    :class="{ 'route-view--full': currentRoute.meta.full }"
  >
    <component :is="currentRoute.component" :key="currentRoute.path" />
  </div>
</template>

<style scoped>
/* 默认不生成额外盒子，保持原首页在 #app 内的布局不变 */
.route-view {
  display: contents;
}

/* 全屏路由（登录页）：脱离 #app 的宽度/边框约束，盖满视口 */
.route-view--full {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #0a0e1a;
  overflow: hidden;
}
</style>
