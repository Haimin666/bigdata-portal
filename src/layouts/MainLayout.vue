<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { menus } from '@/config/menu'
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
const refreshKey = ref(0)
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

function handleSelect(path: string) {
  router.push(path)
}

function handleRefresh() {
  const kind = menus.find((m) => m.path === route.path)?.kind
  if (kind === 'native') {
    // 原生视图:重挂组件重新拉取
    refreshKey.value++
  } else {
    // 子应用:广播刷新事件,由 SubAppView 销毁重建
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
        <router-view :key="refreshKey" />
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
}
</style>