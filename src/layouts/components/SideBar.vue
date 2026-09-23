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
  <el-aside
    :width="props.collapsed ? '64px' : '220px'"
    class="portal-aside"
    :class="{ 'is-collapsed': props.collapsed }"
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
  </el-aside>
</template>

<style scoped lang="scss">
.portal-aside {
  position: relative;
  background: var(--bd-sidebar, #ffffff);
  border-right: 1px solid $border;
  transition: width 0.22s ease, background-color 0.22s ease, border-color 0.22s ease;
  overflow: hidden;
}

.portal-logo {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 56px;
  padding: 0 18px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: $text;
  white-space: nowrap;
  overflow: hidden;
  border-bottom: 1px solid var(--bd-border);
}
.portal-aside.is-collapsed {
  .portal-logo {
    justify-content: center;
    padding: 0;
  }

  .logo-text {
    display: none;
  }

  .portal-menu :deep(.el-menu-item) {
    justify-content: center;
    margin-left: 10px;
    margin-right: 10px;
    padding: 0 !important;
  }
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
  padding: 8px 0;

  /* 菜单项采用轻量圆角状态,保持现有侧栏宽度与折叠行为 */
  :deep(.el-menu-item) {
    font-size: 13px;
    letter-spacing: 0;
    color: $muted;
    height: 44px;
    line-height: 44px;
    margin: 3px 10px;
    padding: 0 12px !important;
    border-radius: 8px;
    transition: color 0.18s ease, background 0.18s ease;
  }
  :deep(.el-menu-item:hover) {
    color: $text;
    background: var(--bd-panel-sub);
  }
  :deep(.el-menu-item.is-active) {
    color: $primary;
    background: var(--bd-primary-soft);
    font-weight: 600;
  }
}

</style>
