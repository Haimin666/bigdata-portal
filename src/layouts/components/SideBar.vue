<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { menus, type MenuItem } from '@/config/menu'
import { Monitor, Timer, Folder, Odometer, Search, DataLine, Cpu, Coin, Notebook, UserFilled, MagicStick, Lock, Message, Refresh } from '@element-plus/icons-vue'
import type { Component } from 'vue'
import RobotIcon from '@/components/RobotIcon.vue'

defineOptions({ name: 'SideBar' })

import { useAuthStore } from '@/store/auth'

const route = useRoute()

const props = defineProps<{
  collapsed: boolean
  mobileOpen?: boolean
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
  Notebook,
  User: UserFilled,
  Lock,
  MagicStick,
  Message,
  Refresh,
  Robot: RobotIcon
}

// 当前激活菜单(直接按路由路径)
const activePath = computed(() => route.path)

// 菜单项统一使用 auth store 的模块判断;认证关闭时由 store 读取 enabledModules。
const auth = useAuthStore()
const filteredMenus = computed<MenuItem[]>(() => {
  let list = menus.filter((m) => auth.hasModule(m.name))
  // 用户管理等管理员模块由注册表统一声明
  if (!auth.isAdmin) list = list.filter((m) => !m.adminOnly)
  return list
})

onMounted(async () => {
  if (!auth.loaded) await auth.fetchMe()
})
</script>

<template>
    <el-aside
      :width="props.collapsed ? '60px' : '224px'"
      class="portal-aside"
      :class="{ 'mobile-open': props.mobileOpen }"
    >
    <div class="portal-logo">
      <span class="logo-dot"></span>
      <span class="logo-text">BIGDATA 门户</span>
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
  display: flex;
  flex-direction: column;
  background: var(--bd-sidebar);
  border-right: 1px solid $border;
  transition: width 0.2s ease;
  overflow: visible;
}

@media (max-width: 768px) {
  .portal-aside {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 20;
    width: 224px !important;
    transform: translateX(-100%);
    box-shadow: 8px 0 24px rgba(15, 23, 42, 0.12);
  }
  .portal-aside.mobile-open { transform: translateX(0); }
  .portal-aside .collapse-bar { display: none; }
}

.portal-logo {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: var(--bd-header-height);
  padding: 0 20px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
  border-bottom: 1px solid var(--bd-border);
}
.logo-dot {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 6px 6px 10px 10px;
  background: var(--bd-primary);
  box-shadow: 0 4px 10px color-mix(in srgb, var(--bd-primary) 24%, transparent);
}

.portal-menu {
  border-right: none;
  background: transparent;
  padding: 10px 8px;
  flex: 1;
  overflow-y: auto;

  :deep(.el-menu-item) {
    height: 40px;
    line-height: 40px;
    margin: 3px 0;
    padding: 0 12px !important;
    border-radius: 6px;
    color: $muted;
    font-size: 13px;
    transition: color 0.18s ease, background 0.18s ease;
  }
  :deep(.el-menu-item:hover) {
    color: $text;
    background: var(--bd-primary-soft);
  }
  :deep(.el-menu-item.is-active) {
    color: $primary;
    background: var(--bd-primary-soft);
    font-weight: 600;
  }
  :deep(.el-menu-item .el-icon) { margin-right: 10px; }
}

.collapse-bar {
  position: absolute;
  right: -12px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 32px;
  border: 1px solid $border;
  background: $panel;
  cursor: pointer;
  z-index: 20;
  border-radius: 0 8px 8px 0;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);

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

:deep(.el-menu--collapse) {
  width: 60px;
  padding-left: 8px;
  padding-right: 8px;
}

:deep(.el-menu--collapse .el-menu-item) {
  padding: 0 !important;
  justify-content: center;
}

:deep(.el-menu--collapse .el-menu-item .el-icon) { margin-right: 0; }

:deep(.el-menu--collapse .el-menu-item span) { display: none; }
</style>
