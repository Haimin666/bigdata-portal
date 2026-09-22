<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Expand,
  Fold,
  FullScreen,
  Moon,
  Refresh,
  Sunny,
  SwitchButton,
  UserFilled
} from '@element-plus/icons-vue'
import { menus } from '@/config/menu'
import { getTheme, toggleTheme } from '@/utils/theme'
import { useAuthStore } from '@/store/auth'

defineOptions({ name: 'AppHeader' })

defineProps<{ collapsed: boolean; fullscreen: boolean }>()

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'refresh'): void
  (e: 'toggle-fullscreen'): void
}>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const theme = ref(getTheme())

const currentMenu = computed(() => menus.find((m) => m.path === route.path))
const breadcrumb = computed(() => currentMenu.value ? ['工作台', currentMenu.value.title] : ['工作台'])

function onToggleTheme() {
  theme.value = toggleTheme()
}

async function onLogout() {
  await auth.logout()
  ElMessage.success('已退出登录')
  router.replace('/login')
}

function goUserManage() {
  router.push('/users')
}
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <el-button
        class="header-icon-button"
        text
        circle
        :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'"
        @click="emit('toggle-sidebar')"
      >
        <Expand v-if="collapsed" />
        <Fold v-else />
      </el-button>
      <div class="breadcrumb" aria-label="页面位置">
        <span v-for="(item, index) in breadcrumb" :key="item" class="breadcrumb-item">
          <span :class="{ current: index === breadcrumb.length - 1 }">{{ item }}</span>
          <span v-if="index < breadcrumb.length - 1" class="breadcrumb-separator">/</span>
        </span>
      </div>
    </div>

    <div class="header-right">
      <el-button class="header-icon-button" text circle aria-label="刷新页面" @click="emit('refresh')">
        <Refresh />
      </el-button>
      <el-button class="header-icon-button" text circle aria-label="切换主题" @click="onToggleTheme">
        <Moon v-if="theme === 'light'" />
        <Sunny v-else />
      </el-button>
      <el-button class="header-icon-button" text circle aria-label="全屏" @click="emit('toggle-fullscreen')">
        <FullScreen />
      </el-button>
      <el-dropdown v-if="auth.me?.username" trigger="click" class="user-dropdown">
        <button class="user-trigger" type="button">
          <span class="user-avatar"><UserFilled /></span>
          <span class="user-label">{{ auth.me.username }}</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-if="auth.isAdmin" @click="goUserManage">用户管理</el-dropdown-item>
            <el-dropdown-item divided @click="onLogout">
              <SwitchButton />
              退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<style scoped lang="scss">
.app-header {
  height: var(--bd-header-height);
  flex: 0 0 var(--bd-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--bd-header);
  border-bottom: 1px solid var(--bd-border);
  color: $text;
  z-index: 10;
}

.header-left,
.header-right,
.breadcrumb,
.user-trigger {
  display: flex;
  align-items: center;
}

.header-left,
.header-right { gap: 8px; }

.header-icon-button {
  width: 32px;
  height: 32px;
  margin: 0;
  color: $muted;
  font-size: 16px;
}

.header-icon-button:hover {
  color: $primary;
  background: var(--bd-primary-soft);
}

.breadcrumb {
  gap: 8px;
  font-size: 13px;
  color: $muted;
}

.breadcrumb-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.breadcrumb-item .current {
  color: $text;
  font-weight: 500;
}

.breadcrumb-separator { color: var(--bd-border-strong); }

.user-dropdown { margin-left: 4px; }

.user-trigger {
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: 0;
  border-radius: 6px;
  color: $text;
  background: transparent;
  cursor: pointer;
}

.user-trigger:hover { background: var(--bd-primary-soft); }

.user-avatar {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: var(--bd-primary);
  font-size: 14px;
}

.user-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

@media (max-width: 640px) {
  .app-header { padding: 0 10px; }
  .breadcrumb-item:first-child,
  .breadcrumb-separator { display: none; }
  .user-label { display: none; }
}
</style>
