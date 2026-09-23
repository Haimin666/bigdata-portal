<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { menus } from '@/config/menu'
import { useAuthStore } from '@/store/auth'
import SideBar from './components/SideBar.vue'
import TabStage from './components/TabStage.vue'
import type { PortalTab, TabContextAction } from '@/views/subapp/SubappTabs.vue'

defineOptions({ name: 'MainLayout' })

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const collapsed = ref(false)
const fullscreen = ref(false)

// ── 模块 Tab 常驻池(原生视图统一管理)──
// 组件常驻 v-show 切换,状态保留;refreshKey 供刷新按钮重建。
const tabs = ref<PortalTab[]>([])
const tabStorageKey = computed(() => `portal-open-tabs:${auth.username || 'anonymous'}`)

/** 打开模块 tab:已存在则仅激活,否则加入池(组件首次创建) */
function openTab(path: string) {
  const menu = menus.find((m) => m.path === path)
  if (!menu) return
  if (!tabs.value.some((t) => t.path === path)) {
    tabs.value.push({ path, menu, refreshKey: 0 })
  }
}

function restoreTabs() {
  try {
    const raw = sessionStorage.getItem(tabStorageKey.value)
    const paths = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(paths)) return
    for (const path of paths) {
      if (typeof path === 'string') openTab(path)
    }
  } catch {
    // 会话存储不可用或内容损坏时,回退到当前路由创建单个 tab。
  }
}

function persistTabs() {
  try {
    sessionStorage.setItem(tabStorageKey.value, JSON.stringify(tabs.value.map((tab) => tab.path)))
  } catch {
    // 不影响页面使用。
  }
}

/** 关闭 tab:销毁对应组件释放内存;若关闭的是当前激活,激活相邻 tab(优先右侧) */
function closeTab(path: string) {
  const idx = tabs.value.findIndex((t) => t.path === path)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  if (path === route.path) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1]
    router.push(next ? next.path : '/yarn')
  }
}

restoreTabs()

watch(tabs, persistTabs, { deep: true })

// 路由变化(菜单/URL 直达/关闭后跳转)→ 自动补/切 tab
watch(
  () => route.path,
  (p) => {
    if (menus.some((m) => m.path === p)) openTab(p)
  },
  { immediate: true }
)

function handleSelect(path: string) {
  openTab(path)
  router.push(path)
}

function handleTabSwitch(path: string) {
  router.push(path)
}

function handleRefresh() {
  // 重建当前 tab 组件(重新拉取数据)
  const t = tabs.value.find((x) => x.path === route.path)
  if (t) t.refreshKey++
}

function handleTabContextAction(action: TabContextAction, path: string) {
  const index = tabs.value.findIndex((tab) => tab.path === path)
  if (index === -1) return

  if (action === 'refresh') {
    tabs.value[index].refreshKey++
    return
  }
  if (action === 'close') {
    closeTab(path)
    return
  }

  if (action === 'close-others') {
    tabs.value = tabs.value.filter((tab) => tab.path === path)
  } else if (action === 'close-left') {
    tabs.value = tabs.value.slice(index)
  } else if (action === 'close-right') {
    tabs.value = tabs.value.slice(0, index + 1)
  }

  // 关闭范围可能包含当前路由,自动回到仍然存在的目标 tab。
  if (!tabs.value.some((tab) => tab.path === route.path)) {
    const next = tabs.value.find((tab) => tab.path === path) ?? tabs.value[tabs.value.length - 1]
    router.push(next?.path ?? '/yarn')
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await document.documentElement.requestFullscreen()
    }
  } catch (e) {
    console.error('[portal] fullscreen error:', e)
  }
}

// 全屏状态由浏览器事件同步,避免状态与实际不符导致按钮失效
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement
}
onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
onUnmounted(() => document.removeEventListener('fullscreenchange', onFullscreenChange))

// ── 快捷键切换已打开的 tab(Ctrl/⌘+←/→ 或 Ctrl/⌘+Tab/Shift+Tab)──
function switchTab(delta: number) {
  if (tabs.value.length < 2) return
  const idx = tabs.value.findIndex((t) => t.path === route.path)
  if (idx === -1) return
  const next = tabs.value[(idx + delta + tabs.value.length) % tabs.value.length]
  openTab(next.path) // 已存在则仅激活
  router.push(next.path)
}
function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    switchTab(1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    switchTab(-1)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    switchTab(e.shiftKey ? -1 : 1)
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="portal-root">
    <el-container class="portal-layout">
      <SideBar :collapsed="collapsed" @select="handleSelect" />
      <el-container>
        <el-main class="portal-main">
          <TabStage
            :tabs="tabs"
            @switch="handleTabSwitch"
            @close="closeTab"
            @refresh="handleRefresh"
            @toggle-fullscreen="toggleFullscreen"
            :collapsed="collapsed"
            @toggle-collapse="collapsed = !collapsed"
            @context-action="handleTabContextAction"
          />
        </el-main>
      </el-container>
    </el-container>
  </div>
</template>

<style scoped lang="scss">
.portal-root {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.portal-layout {
  height: 100%;
  min-height: 0;

  :deep(.el-container) {
    min-height: 0;
  }
}

.portal-main {
  background: $bg;
  padding: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
</style>
