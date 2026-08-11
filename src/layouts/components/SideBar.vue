<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { menus, type MenuItem } from '@/config/menu'
import { getEnabledModules } from '@/api/db'
import { Monitor, Timer, Folder, Odometer, Search, DataLine, Cpu, Coin, Notebook } from '@element-plus/icons-vue'
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
  Cpu,
  Coin,
  Notebook
}

// 当前激活菜单(直接按路由路径)
const activePath = computed(() => route.path)

// 菜单项:服务端 enabledModules 白名单过滤(空 = 全部展示)
const enabled = ref<string[] | null>(null)
const filteredMenus = computed<MenuItem[]>(() => {
  const allow = enabled.value
  if (!allow || allow.length === 0) return menus
  return menus.filter((m) => allow.includes(m.name))
})

onMounted(async () => {
  enabled.value = await getEnabledModules()
})
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
      <el-menu-item v-for="m in filteredMenus" :key="m.path" :index="m.path">
        <el-icon><component :is="icons[m.icon]" /></el-icon>
        <template #title>
          <span>{{ m.title }}</span>
        </template>
      </el-menu-item>
    </el-menu>
    <!-- 折叠按钮:位于侧边栏右边缘栏线,垂直居中,箭头指示展开方向 -->
    <div class="collapse-bar" :class="{ collapsed: props.collapsed }" @click="emit('toggle-collapse')">
      <span class="collapse-arrow"></span>
    </div>
  </el-aside>
</template>

<style scoped lang="scss">
.portal-aside {
  position: relative;
  background: #f0f1f5;
  border-right: 1px solid $border;
  transition: width 0.2s;
  overflow: visible;
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
  right: -1px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 40px;
  border: 1px solid $border;
  background: $panel;
  cursor: pointer;
  z-index: 20;
  border-radius: 0 6px 6px 0;
  box-shadow: 1px 0 4px rgba(0, 0, 0, 0.06);

  &:hover {
    border-color: $primary;
    .collapse-arrow {
      border-color: $primary;
    }
  }
}

/* 纯 CSS 箭头:指向折叠后的方向(展开时→ 表示可收,折叠时← 表示可展) */
.collapse-arrow {
  width: 6px;
  height: 6px;
  border-top: 2px solid $muted;
  border-right: 2px solid $muted;
  transform: rotate(45deg);
  transition: transform 0.2s;

  /* 折叠时箭头反向 */
  .collapsed & {
    transform: rotate(225deg);
  }
}
</style>
