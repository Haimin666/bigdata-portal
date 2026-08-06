<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { menus } from '@/config/menu'
import SubAppView from '@/views/subapp/SubAppView.vue'
import SubappTabs, { type PortalTab } from '@/views/subapp/SubappTabs.vue'
import YarnView from '@/views/yarn/YarnView.vue'
import DsTaskMonitor from '@/views/ds/DsTaskMonitor.vue'
import HdfsView from '@/views/hdfs/HdfsView.vue'
import {
  Monitor,
  Timer,
  Folder,
  Odometer,
  Search,
  DataLine,
  Cpu,
  Expand,
  Fold,
  Refresh,
  FullScreen
} from '@element-plus/icons-vue'
import type { Component } from 'vue'

defineOptions({ name: 'MainLayout' })

const route = useRoute()
const router = useRouter()

const collapsed = ref(false)
const fullscreen = ref(false)

const icons: Record<string, Component> = {
  Monitor,
  Timer,
  Folder,
  Odometer,
  Search,
  DataLine,
  Cpu
}

// 原生视图组件映射:按 menu.name 渲染
const nativeComponents: Record<string, Component> = {
  yarn: YarnView,
  dsTask: DsTaskMonitor,
  hdfs: HdfsView
}

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
</script>

<template>
  <el-container class="portal-layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="portal-aside">
      <div class="portal-logo">
        <span class="logo-text">大数据门户</span>
      </div>
      <el-menu
        :default-active="route.path"
        :collapse="collapsed"
        class="portal-menu"
        @select="handleSelect"
      >
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          <el-icon><component :is="icons[m.icon]" /></el-icon>
          <template #title>
            <span>{{ m.title }}</span>
          </template>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="portal-header">
        <el-icon class="header-icon" @click="collapsed = !collapsed">
          <Expand v-if="collapsed" />
          <Fold v-else />
        </el-icon>
        <span class="header-title">{{ menus.find((m) => m.path === route.path)?.title }}</span>
        <div class="header-actions">
          <el-icon class="header-icon" @click="handleRefresh"><Refresh /></el-icon>
          <el-icon class="header-icon" @click="toggleFullscreen"><FullScreen /></el-icon>
        </div>
      </el-header>
      <el-main class="portal-main">
        <!-- 模块 Tab 条 -->
        <SubappTabs
          v-if="tabs.length"
          :tabs="tabs"
          :active-path="route.path"
          @switch="handleTabSwitch"
          @close="closeTab"
        />
        <!-- 常驻池:v-show 仅隐藏不卸载,状态保留;关闭 tab 才真正销毁 -->
        <div class="view-stage">
          <template v-for="tab in tabs" :key="tab.path">
            <div v-show="tab.path === route.path" class="view-item">
              <!-- 子应用:iframe 常驻 -->
              <SubAppView
                v-if="tab.menu.kind === 'subapp'"
                :menu="tab.menu"
                :active="tab.path === route.path"
              />
              <!-- 原生视图:组件常驻,刷新时按 key 重建 -->
              <component
                v-else
                :is="nativeComponents[tab.menu.name]"
                :key="tab.refreshKey"
              />
            </div>
          </template>
        </div>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped lang="scss">
.portal-layout {
  height: 100%;
}

.portal-aside {
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

.portal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border-bottom: 1px solid $border;
}

.header-icon {
  font-size: 18px;
  cursor: pointer;
  color: $muted;
}

.header-title {
  font-weight: 600;
  color: $text;
}

.header-actions {
  display: flex;
  gap: 12px;
  margin-left: auto;
}

.portal-main {
  background: $bg;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.view-stage {
  flex: 1;
  min-height: 0;
  position: relative;
}

.view-item {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
