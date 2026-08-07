<script setup lang="ts">
import { Close, Refresh, FullScreen } from '@element-plus/icons-vue'
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
  refresh: []
  toggleFullscreen: []
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
    <div class="tab-actions">
      <el-icon class="action-icon" title="刷新" @click="emit('refresh')"><Refresh /></el-icon>
      <el-icon class="action-icon" title="全屏" @click="emit('toggleFullscreen')"><FullScreen /></el-icon>
    </div>
  </div>
</template>

<style scoped lang="scss">
.subapp-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px 0;
  background: $bg;
  border-bottom: 1px solid $border;
  overflow-x: auto;
  flex-shrink: 0;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 12px;
  font-size: 13px;
  color: $muted;
  background: $panel;
  border: 1px solid $border;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;

  &:hover {
    color: $text;
  }

  &.active {
    color: $primary;
    font-weight: 600;
    border-color: $primary;
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

.tab-actions {
  display: flex;
  gap: 10px;
  margin-left: auto;
  padding: 0 4px;
  align-self: center;
}

.action-icon {
  font-size: 16px;
  cursor: pointer;
  color: $muted;

  &:hover {
    color: $primary;
  }
}
</style>
