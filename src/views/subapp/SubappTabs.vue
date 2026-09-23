<script setup lang="ts">
import { Close, Refresh, FullScreen, Sunny, Moon, UserFilled, SwitchButton, Fold, Expand } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { MenuItem } from '@/config/menu'
import { getTheme, toggleTheme, type ThemeMode } from '@/utils/theme'
import { useAuthStore } from '@/store/auth'

defineOptions({ name: 'SubappTabs' })

export interface PortalTab {
  path: string
  menu: MenuItem
  /** 原生视图重建计数(刷新用),子应用恒为 0 */
  refreshKey: number
}

export type TabContextAction = 'close' | 'close-others' | 'close-left' | 'close-right' | 'refresh'

const emit = defineEmits<{
  switch: [path: string]
  close: [path: string]
  refresh: []
  toggleFullscreen: []
  toggleCollapse: []
  contextAction: [action: TabContextAction, path: string]
}>()

const props = defineProps<{
  tabs: PortalTab[]
  activePath: string
  collapsed: boolean
}>()

// 主题图标跟随当前主题(状态保持响应式,切换后立即更新)
const themeMode = ref<ThemeMode>(getTheme())
const isDark = computed(() => themeMode.value === 'dark')

function onToggleTheme() {
  themeMode.value = toggleTheme()
}

// ── 用户区(认证开启时显示;点击用户名弹菜单)──
const auth = useAuthStore()
const router = useRouter()

const contextMenu = ref<{ path: string; left: number; top: number } | null>(null)

function openContextMenu(event: MouseEvent, path: string) {
  const menuWidth = 168
  const menuHeight = 196
  contextMenu.value = {
    path,
    left: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    top: Math.min(event.clientY, window.innerHeight - menuHeight - 8)
  }
}

function closeContextMenu() {
  contextMenu.value = null
}

function runContextAction(action: TabContextAction) {
  const path = contextMenu.value?.path
  closeContextMenu()
  if (path) emit('contextAction', action, path)
}

function onDocumentPointerdown(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('.tab-context-menu')) closeContextMenu()
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeContextMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerdown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerdown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

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
  <div class="subapp-tabs">
    <div class="shell-start">
      <el-tooltip :content="props.collapsed ? '展开侧栏' : '收起侧栏'" placement="bottom">
        <button
          type="button"
          class="shell-icon-button"
          :aria-label="props.collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-pressed="props.collapsed"
          @click="emit('toggleCollapse')"
        >
          <el-icon><Expand v-if="props.collapsed" /><Fold v-else /></el-icon>
        </button>
      </el-tooltip>
    </div>
    <div class="tab-list">
      <div
        v-for="t in props.tabs"
        :key="t.path"
        class="tab"
        :class="{ active: t.path === props.activePath }"
        @click="emit('switch', t.path)"
        @contextmenu.prevent.stop="openContextMenu($event, t.path)"
      >
        <span class="tab-title">{{ t.menu.title }}</span>
        <el-icon class="tab-close" @click.stop="emit('close', t.path)">
          <Close />
        </el-icon>
      </div>
    </div>
    <div class="tab-actions">
      <button
        type="button"
        class="shell-icon-button theme-toggle"
        :class="{ 'is-dark': isDark }"
        :aria-label="isDark ? '切换浅色模式' : '切换深色模式'"
        :title="isDark ? '切换浅色模式' : '切换深色模式'"
        :aria-pressed="isDark"
        @click="onToggleTheme"
        >
          <el-icon><Sunny v-if="!isDark" /><Moon v-else /></el-icon>
        </button>
      <el-icon class="action-icon" title="刷新" @click="emit('refresh')"><Refresh /></el-icon>
      <el-icon class="action-icon" title="全屏" @click="emit('toggleFullscreen')"><FullScreen /></el-icon>
      <el-dropdown v-if="auth.me?.username" trigger="click" class="user-drop">
        <span class="user-badge">
          <el-icon><UserFilled /></el-icon>
          <span class="user-name">{{ auth.me.username }}</span>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-if="auth.isAdmin" @click="goUserManage">用户管理</el-dropdown-item>
            <el-dropdown-item divided @click="onLogout">
              <el-icon><SwitchButton /></el-icon>退出登录
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>

  <div
    v-if="contextMenu"
    class="tab-context-menu"
    :style="{ left: `${contextMenu.left}px`, top: `${contextMenu.top}px` }"
    @pointerdown.stop
  >
    <button type="button" @click="runContextAction('refresh')">刷新当前</button>
    <button type="button" @click="runContextAction('close')">关闭当前</button>
    <span class="context-divider"></span>
    <button type="button" @click="runContextAction('close-left')">关闭左侧</button>
    <button type="button" @click="runContextAction('close-right')">关闭右侧</button>
    <button type="button" @click="runContextAction('close-others')">关闭其他</button>
  </div>
</template>

<style scoped lang="scss">
.subapp-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 46px;
  padding: 7px 12px;
  background: var(--bd-panel-sub);
  border-bottom: 1px solid $border;
  box-shadow: 0 1px 2px color-mix(in srgb, $text 5%, transparent);
  flex-shrink: 0;
}

.shell-start {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding-right: 2px;
  border-right: 1px solid color-mix(in srgb, $border 86%, transparent);
}

.tab-list {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: thin;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px 7px 12px;
  font-size: 13px;
  color: $muted;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease;

  &:hover {
    color: $text;
    background: var(--bd-panel-sub);
  }

  &.active {
    color: $primary;
    font-weight: 600;
    border-color: color-mix(in srgb, $primary 18%, transparent);
    background: var(--bd-primary-soft);
  }
}

.tab-context-menu {
  position: fixed;
  z-index: 3000;
  display: grid;
  width: 168px;
  padding: 5px;
  border: 1px solid $border;
  border-radius: 10px;
  background: $panel;
  box-shadow: var(--bd-shadow);

  button {
    display: block;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 7px;
    color: $text;
    font: inherit;
    font-size: 12px;
    text-align: left;
    background: transparent;
    cursor: pointer;

    &:hover {
      color: $primary;
      background: var(--bd-primary-soft);
    }
  }
}

.context-divider {
  height: 1px;
  margin: 4px 4px;
  background: $border;
}

.tab-close {
  font-size: 12px;
  border-radius: 50%;
  padding: 1px;
  color: $muted;

  &:hover {
    color: $primary;
    background: color-mix(in srgb, $primary 14%, transparent);
  }
}

.shell-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: $muted;
  background: transparent;
  cursor: pointer;
  transition: color 0.18s ease, background 0.18s ease, transform 0.18s ease;

  &:hover {
    color: $primary;
    background: var(--bd-primary-soft);
  }

  &:active {
    transform: translateY(1px) scale(0.98);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, $primary 72%, transparent);
    outline-offset: 2px;
  }

  :deep(.el-icon),
  > svg {
    font-size: 18px;
  }
}

.tab-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  padding: 0;
  align-self: center;
  flex-shrink: 0;
  align-items: center;
}

.theme-toggle {
  color: $text;

  &.is-dark {
    color: $primary;
    background: var(--bd-primary-soft);
  }
}

.action-icon {
  width: 30px;
  height: 30px;
  padding: 7px;
  font-size: 16px;
  cursor: pointer;
  color: $muted;
  border-radius: 7px;
  transition: color 0.18s ease, background 0.18s ease;

  &:hover {
    color: $primary;
    background: var(--bd-primary-soft);
  }
}

.user-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: $text;
  cursor: pointer;
  padding: 5px 8px;
  border-radius: 7px;
  transition: color 0.18s ease, background 0.18s ease;

  &:hover {
    color: $primary;
    background: var(--bd-primary-soft);
  }
}

.user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
