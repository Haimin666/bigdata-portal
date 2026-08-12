<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { menus } from '@/config/menu'
import SideBar from './components/SideBar.vue'
import TabStage from './components/TabStage.vue'
import type { PortalTab } from '@/views/subapp/SubappTabs.vue'

defineOptions({ name: 'MainLayout' })

const route = useRoute()
const router = useRouter()

const collapsed = ref(false)
const fullscreen = ref(false)

// ── 模块 Tab 常驻池(原生视图 + 子应用 iframe 统一管理)──────────
// 原生视图:组件常驻 v-show 切换,状态保留;refreshKey 供刷新按钮重建。
// 子应用:iframe 常驻,关闭 tab 才销毁。
const tabs = ref<PortalTab[]>([])

/** 打开模块 tab:已存在则仅激活,否则加入池(组件/iframe 首次创建) */
function openTab(path: string) {
  const menu = menus.find((m) => m.path === path)
  if (!menu) return
  if (!tabs.value.some((t) => t.path === path)) {
    tabs.value.push({ path, menu, refreshKey: 0 })
  }
}

/** 关闭 tab:销毁对应组件/iframe 释放内存;若关闭的是当前激活,激活相邻 tab(优先右侧) */
function closeTab(path: string) {
  const idx = tabs.value.findIndex((t) => t.path === path)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  if (path === route.path) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1]
    router.push(next ? next.path : '/yarn')
  }
}

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
  const menu = menus.find((m) => m.path === route.path)
  if (!menu) return
  if (menu.kind === 'native') {
    // 原生视图:重建当前 tab 组件(重新拉取数据)
    const t = tabs.value.find((x) => x.path === route.path)
    if (t) t.refreshKey++
  } else {
    // 子应用:广播刷新事件,由激活的 SubAppView 销毁重建 iframe
    window.dispatchEvent(new Event('portal-refresh'))
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

// ── 顶部状态条时钟 ──
const clockText = ref('')
let clockTimer: ReturnType<typeof setInterval> | null = null
function tickClock() {
  clockText.value = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}
onMounted(() => {
  tickClock()
  clockTimer = setInterval(tickClock, 1000)
})
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
  <div class="portal-root">
    <!-- 顶部状态条(深空控制台) -->
    <div class="portal-statusbar">
      <span class="sb-left"><span class="sb-dot"></span>BIGDATA-PORTAL // CONSOLE ONLINE</span>
      <span class="sb-right">{{ clockText }}</span>
    </div>
    <el-container class="portal-layout">
      <SideBar :collapsed="collapsed" @select="handleSelect" @toggle-collapse="collapsed = !collapsed" />
      <el-container>
        <el-main class="portal-main">
          <TabStage
            :tabs="tabs"
            @switch="handleTabSwitch"
            @close="closeTab"
            @refresh="handleRefresh"
            @toggle-fullscreen="toggleFullscreen"
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

/* 顶部状态条(深空控制台) */
.portal-statusbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 30px;
  padding: 0 18px;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 2px;
  color: $muted;
  border-bottom: 1px solid var(--bd-border);
  background: color-mix(in srgb, $bg 85%, transparent);
}
.sb-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 6px #34d399;
  animation: sbPulse 1.6s infinite;
}
@keyframes sbPulse {
  50% {
    opacity: 0.35;
  }
}
.sb-right {
  color: $muted;
}

.portal-layout {
  height: 100%;
}

.portal-main {
  background: $bg;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
