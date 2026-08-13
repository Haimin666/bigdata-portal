<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import type { Component } from 'vue'
import SubAppView from '@/views/subapp/SubAppView.vue'
import SubappTabs, { type PortalTab } from '@/views/subapp/SubappTabs.vue'
import YarnView from '@/views/yarn/YarnView.vue'
import DsTaskMonitor from '@/views/ds/DsTaskMonitor.vue'
import HdfsView from '@/views/hdfs/HdfsView.vue'
import DbQueryView from '@/views/db/QueryView.vue'
import UserManageView from '@/views/admin/UserManageView.vue'
import ThemeSettingsView from '@/views/admin/ThemeSettingsView.vue'

defineOptions({ name: 'TabStage' })

const props = defineProps<{
  tabs: PortalTab[]
}>()

const emit = defineEmits<{
  (e: 'switch', path: string): void
  (e: 'close', path: string): void
  (e: 'refresh'): void
  (e: 'toggle-fullscreen'): void
}>()

const route = useRoute()

// 原生视图组件映射:按 menu.name 渲染
const nativeComponents: Record<string, Component> = {
  yarn: YarnView,
  dsTask: DsTaskMonitor,
  hdfs: HdfsView,
  dbQuery: DbQueryView,
  userManage: UserManageView,
  theme: ThemeSettingsView
}

const activePath = computed(() => route.path)
</script>

<template>
  <div class="tab-stage">
    <!-- 模块 Tab 条 -->
    <SubappTabs
      v-if="props.tabs.length"
      :tabs="props.tabs"
      :active-path="activePath"
      @switch="(p: string) => emit('switch', p)"
      @close="(p: string) => emit('close', p)"
      @refresh="emit('refresh')"
      @toggle-fullscreen="emit('toggle-fullscreen')"
    />
    <!-- 常驻池:v-show 仅隐藏不卸载,状态保留;关闭 tab 才真正销毁 -->
    <div class="view-stage">
      <template v-for="tab in props.tabs" :key="tab.path">
        <div v-show="tab.path === activePath" class="view-item">
          <!-- 子应用:iframe 常驻 -->
          <SubAppView
            v-if="tab.menu.kind === 'subapp'"
            :menu="tab.menu"
            :active="tab.path === activePath"
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
  </div>
</template>

<style scoped lang="scss">
.tab-stage {
  flex: 1;
  min-height: 0;
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
