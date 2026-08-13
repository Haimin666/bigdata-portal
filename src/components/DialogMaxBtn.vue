<script setup lang="ts">
/** 弹窗「放大/还原」按钮:自绘图标按钮,边框+文字跟随主题,保证任何主题下都清晰可见 */
defineProps<{ fs: boolean }>()
const emit = defineEmits(['toggle'])
</script>

<template>
  <button class="dlg-max-btn" type="button" :title="fs ? '还原' : '放大'" @click="emit('toggle')">
    <svg v-if="!fs" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <!-- 放大:四角斜线外扩 -->
      <path d="M6.5 2.5H2.5v4" />
      <path d="M9.5 13.5h4v-4" />
      <path d="M2.5 9.5v4h4" />
      <path d="M13.5 6.5v-4h-4" />
    </svg>
    <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <!-- 还原:四角斜线内收 -->
      <path d="M6.5 2.5H2.5v4" />
      <path d="M9.5 13.5h4v-4" />
      <path d="M2.5 2.5l3 3" />
      <path d="M13.5 13.5l-3-3" />
    </svg>
  </button>
</template>

<style scoped lang="scss">
.dlg-max-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--bd-border);
  color: var(--bd-text);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s, transform 0.12s;
  &:hover {
    border-color: var(--bd-primary);
    color: var(--bd-primary);
    background: color-mix(in srgb, var(--bd-primary) 8%, transparent);
    transform: translateY(-1px);
  }
  &:active {
    transform: translateY(0);
  }
}
</style>
