<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { menus, type MenuItem } from '@/config/menu'
import { getEnabledModules } from '@/api/db'
import { Monitor, Timer, Folder, Odometer, Search, DataLine, Cpu, Coin, Notebook, UserFilled, MagicStick, Lock, Message, Refresh } from '@element-plus/icons-vue'
import type { Component } from 'vue'
import RobotIcon from '@/components/RobotIcon.vue'

defineOptions({ name: 'SideBar' })

import { useAuthStore } from '@/store/auth'

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

// 菜单项:优先当前用户可访问模块(用户体系),回退服务端 enabledModules 白名单(空 = 全部展示)。
// 认证关闭时走 enabledModules(兼容旧部署);admin 额外展示「用户管理」。
const auth = useAuthStore()
const enabled = ref<string[] | null>(null)
const filteredMenus = computed<MenuItem[]>(() => {
  let allow = enabled.value
  if (auth.me?.username) allow = auth.modules // 用户体系优先
  let list = menus
  if (allow && allow.length > 0) list = menus.filter((m) => allow.includes(m.name))
  // 用户管理 / 数据权限仅管理员可见(静态菜单,此处按角色过滤)
  if (!auth.isAdmin) list = list.filter((m) => m.name !== 'userManage' && m.name !== 'dbPerm')
  return list
})

onMounted(async () => {
  if (!auth.loaded) await auth.fetchMe()
  if (!auth.me?.username) {
    enabled.value = await getEnabledModules()
  }
})
</script>

<template>
  <el-aside :width="props.collapsed ? '64px' : '220px'" class="portal-aside">
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
  background: var(--bd-sidebar, #f0f1f5);
  border-right: 1px solid $border;
  transition: width 0.2s;
  overflow: visible;
}

.portal-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 56px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 3px;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  border-bottom: 1px solid var(--bd-border);
}
.logo-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: $primary;
  box-shadow: 0 0 8px $primary;
  animation: logoPulse 1.6s infinite;
}
@keyframes logoPulse {
  50% {
    opacity: 0.35;
  }
}

.portal-menu {
  border-right: none;
  background: transparent;

  /* 菜单项 hover/选中:深空控制台(青色 ▸ 指示) */
  :deep(.el-menu-item) {
    font-size: 13px;
    letter-spacing: 1px;
    color: $muted;
    height: 44px;
    line-height: 44px;
    transition: color 0.2s, background 0.2s;
  }
  :deep(.el-menu-item:hover) {
    color: $text;
    background: color-mix(in srgb, $primary 6%, transparent);
  }
  :deep(.el-menu-item.is-active) {
    color: $primary;
    background: color-mix(in srgb, $primary 9%, transparent);
    border-right: 2px solid $primary;
  }
  :deep(.el-menu-item.is-active)::before {
    content: '▸';
    margin-right: 6px;
    font-size: 11px;
  }
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
