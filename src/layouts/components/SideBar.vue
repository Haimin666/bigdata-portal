<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { menus } from '@/config/menu'
import { Monitor, Timer, Folder, Odometer, Search, DataLine, Cpu, Expand, Fold } from '@element-plus/icons-vue'
import type { Component } from 'vue'

defineOptions({ name: 'SideBar' })

const route = useRoute()

const props = defineProps<{
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'toggle-collapse'): void
}>()

const icons: Record<string, Component> = {
  Monitor,
  Timer,
  Folder,
  Odometer,
  Search,
  DataLine,
  Cpu
}

// 当前激活菜单(直接按路由路径)
const activePath = computed(() => route.path)
</script>

<template>
  <el-aside :width="props.collapsed ? '64px' : '220px'" class="portal-aside">
    <div class="portal-logo">
      <span class="logo-text">大数据门户</span>
    </div>
    <el-menu
      :default-active="activePath"
      :collapse="props.collapsed"
      class="portal-menu"
      @select="(path: string) => emit('select', path)"
    >
      <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
        <el-icon><component :is="icons[m.icon]" /></el-icon>
        <template #title>
          <span>{{ m.title }}</span>
        </template>
      </el-menu-item>
    </el-menu>
    <!-- 折叠按钮:位于侧边栏右边缘栏线,垂直居中 -->
    <div class="collapse-bar" @click="emit('toggle-collapse')">
      <el-icon class="collapse-icon">
        <Expand v-if="props.collapsed" />
        <Fold v-else />
      </el-icon>
    </div>
  </el-aside>
</template>

<style scoped lang="scss">
.portal-aside {
  position: relative;
  background: #f0f1f5;
  border-right: 1px solid $border;
  transition: width 0.2s;
  overflow: hidden;
}

.portal-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  font-weight: 700;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
}

.portal-menu {
  border-right: none;
  background: transparent;
}

.collapse-bar {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 44px;
  border: 1px solid $border;
  border-right: none;
  border-radius: 6px 0 0 6px;
  background: $panel;
  cursor: pointer;
  z-index: 10;
  color: $muted;

  &:hover {
    color: $primary;
    background: #fff;
  }
}

.collapse-icon {
  font-size: 14px;
}
</style>
