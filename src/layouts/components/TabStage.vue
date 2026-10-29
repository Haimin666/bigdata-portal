<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SubAppView from '@/views/subapp/SubAppView.vue'
import SubappTabs, { type PortalTab, type TabContextAction } from '@/views/subapp/SubappTabs.vue'
// 原生视图一律异步(加载器集中在 nativeViews.ts,SideBar hover 复用同一份预热);
// 静态引入会把 G6(~424KB gzip)/Monaco 拖进首屏 chunk,曾致 index 4.9MB
import { nativeViewComponents } from './nativeViews'

defineOptions({ name: 'TabStage' })

const props = defineProps<{
  tabs: PortalTab[]
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'switch', path: string): void
  (e: 'close', path: string): void
  (e: 'refresh'): void
  (e: 'toggle-fullscreen'): void
  (e: 'toggle-collapse'): void
  // 右键菜单动作(关闭其他/左侧/右侧等)。此前未透传,MainLayout 只能收到空事件
  (e: 'context-action', action: TabContextAction, path: string): void
  // 拖拽排序
  (e: 'reorder', from: number, to: number): void
}>()

const route = useRoute()

// 原生视图组件映射:按 menu.name 渲染(异步加载器与预热共用 nativeViews.ts)
const nativeComponents = nativeViewComponents

const activePath = computed(() => route.path)
</script>

<template>
  <div class="tab-stage">
    <!-- 模块 Tab 条 -->
    <SubappTabs
      v-if="props.tabs.length"
      :tabs="props.tabs"
      :active-path="activePath"
      :collapsed="props.collapsed"
      @switch="(p: string) => emit('switch', p)"
      @close="(p: string) => emit('close', p)"
      @refresh="emit('refresh')"
      @toggle-fullscreen="emit('toggle-fullscreen')"
      @toggle-collapse="emit('toggle-collapse')"
      @context-action="(action: TabContextAction, path: string) => emit('context-action', action, path)"
      @reorder="(from: number, to: number) => emit('reorder', from, to)"
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
