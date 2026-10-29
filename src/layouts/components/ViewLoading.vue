<script setup lang="ts">
// 视图 chunk 加载态的占位骨架:仅在异步视图超过 defineAsyncComponent 的 delay 时出现,
// 避免首次切 tab 时内容区一片空白。
defineOptions({ name: 'ViewLoading' })
</script>

<template>
  <div class="view-loading" aria-busy="true" aria-live="polite">
    <div class="view-loading__title"></div>
    <div class="view-loading__body">
      <el-skeleton :rows="6" animated />
    </div>
  </div>
</template>

<style scoped lang="scss">
.view-loading {
  padding: 20px 24px;
  height: 100%;
}

.view-loading__title {
  width: 180px;
  height: 18px;
  margin-bottom: 20px;
  border-radius: 4px;
  background: var(--bd-panel-sub, #f2f3f8);
  animation: viewLoadingPulse 1.6s ease-in-out infinite;
}

.view-loading__body {
  max-width: 720px;
}

@keyframes viewLoadingPulse {
  50% {
    opacity: 0.45;
  }
}
</style>
