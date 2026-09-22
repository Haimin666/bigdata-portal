<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'
import type { MenuItem } from '@/config/menu'

defineOptions({ name: 'SubappTabs' })

export interface PortalTab {
  path: string
  menu: MenuItem
  /** 原生视图重建计数(刷新用),子应用恒为 0 */
  refreshKey: number
}

defineProps<{
  tabs: PortalTab[]
  activePath: string
}>()

const emit = defineEmits<{
  switch: [path: string]
  close: [path: string]
}>()
</script>

<template>
  <div class="subapp-tabs">
    <div
      v-for="t in tabs"
      :key="t.path"
      class="tab"
      :class="{ active: t.path === activePath }"
      @click="emit('switch', t.path)"
    >
      <span class="tab-title">{{ t.menu.title }}</span>
      <el-icon class="tab-close" @click.stop="emit('close', t.path)">
        <Close />
      </el-icon>
    </div>
  </div>
</template>

<style scoped lang="scss">
.subapp-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: var(--bd-tabbar-height);
  padding: 4px 12px 0;
  background: var(--bd-tabbar);
  border-bottom: 1px solid $border;
  overflow-x: auto;
  flex-shrink: 0;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 14px;
  font-size: 13px;
  color: $muted;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;

  &:hover {
    color: $text;
    background: var(--bd-tab-hover);
  }

  &.active {
    color: $primary;
    font-weight: 600;
    border-color: var(--bd-border);
    border-bottom-color: var(--bd-tabbar);
    box-shadow: inset 0 -2px 0 $primary;
    background: var(--bd-tab-active);
  }
}

.tab-close {
  font-size: 12px;
  border-radius: 50%;
  padding: 1px;
  color: $muted;

  &:hover {
    color: #fff;
    background: $primary;
  }
}

</style>
