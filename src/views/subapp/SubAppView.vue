<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MenuItem } from '@/config/menu'

// 海豚 3.x 实例详情 hash 路由:/projects/instance/list/:processInstanceId
// (项目上下文在 DS 自身 vuex,hash 导航不重载页面可保留;若未选项目 DS 会引导到项目选择页)
const DS_INSTANCE_DETAIL = (id: number | string) => `#/projects/instance/list/${id}`

defineOptions({ name: 'SubAppView' })

// tab 内容组件:由 MainLayout 的常驻 iframe 池渲染(每个子应用一个实例)
const props = defineProps<{
  menu: MenuItem
  /** 是否为当前激活 tab(激活的才响应刷新重建) */
  active: boolean
}>()

const route = useRoute()
const router = useRouter()

// 首次创建时拼一次地址;常驻后 iframe 不重载,后续切换不重新拼接
const appUrl = computed(() => {
  // 依赖 iframeKey:顶栏刷新重建 iframe 时重新计算(Stingray 时间戳随之更新)
  void iframeKey.value
  const base = props.menu.url ?? `${props.menu.path}/#/`
  // Stingray 同源代理:网关对 HTML 已设 no-store,但浏览器可能残留加 no-store 之前
  // 缓存的旧 HTML(无路由注入脚本 → React 读 /apps/stingray/login → 兜底 404 页)。
  // 首次创建追加时间戳,强制走网络拿新 HTML,彻底绕开缓存问题。
  if (props.menu.name === 'stingray') return `${base}?_t=${Date.now()}`
  return base
})
// 原生 iframe 直连(同源代理或跨源直连)
const isNativeIframe = computed(() => props.menu.iframe ?? false)

// 顶栏刷新联动:仅激活的 tab 强制重建 iframe 重新加载
const iframeKey = ref(0)
function onPortalRefresh() {
  if (props.active && isNativeIframe.value) iframeKey.value++
}
onMounted(() => window.addEventListener('portal-refresh', onPortalRefresh))
onUnmounted(() => window.removeEventListener('portal-refresh', onPortalRefresh))

// ---- DS 实例详情跳转(工作流列表点击名称进入 iframe 详情) ----
const iframeRef = ref<HTMLIFrameElement>()
// 仅海豚菜单消费 dsTarget query
const dsTarget = computed(() =>
  props.menu.name === 'ds' ? (route.query.dsTarget as string | undefined) : undefined,
)

let dsNavTimer: ReturnType<typeof setInterval> | undefined
let dsNavTries = 0
function navigateDsToInstance() {
  const frame = iframeRef.value
  const target = dsTarget.value
  // 目标已被清除(用户切走/URL 变化):停止轮询,但不干预路由,避免把用户拉回 /ds
  if (!target) {
    clearInterval(dsNavTimer)
    return
  }
  // iframe 未就绪(如刷新重建中):跳过本次,等 onIframeLoad 重启轮询
  if (!frame?.contentWindow) return
  // 尝试 8 次(约 12s)仍未定位则放弃;仅在用户仍在 /ds 时清除 query
  if (dsNavTries >= 8) {
    clearInterval(dsNavTimer)
    if (route.path === '/ds') router.replace({ path: '/ds' })
    return
  }
  dsNavTries++
  const hash = DS_INSTANCE_DETAIL(target)
  if (frame.contentWindow.location.hash === hash) {
    // hash 已生效:停止轮询;仍在 /ds 时清除 query(用户已切走则保留原路径)
    clearInterval(dsNavTimer)
    if (route.path === '/ds') router.replace({ path: '/ds' })
    return
  }
  // 同源 iframe:改 hash 触发 DS SPA 路由,不重载页面(vuex 项目上下文保留)
  frame.contentWindow.location.hash = hash
}

function onIframeLoad() {
  if (!dsTarget.value) return
  clearInterval(dsNavTimer)
  dsNavTries = 0
  // DS SPA 初始化较慢(bundle 大),轮询设置 hash 直到详情页定位成功
  dsNavTimer = setInterval(navigateDsToInstance, 1500)
  navigateDsToInstance()
}

// tab 常驻后 iframe 不重载,onIframeLoad 仅首次触发;从任务监控再次携带 dsTarget 跳转时,
// iframe 已就绪则直接开始定位轮询;首次创建(iframe 未就绪)时由 onIframeLoad 接管
watch(dsTarget, (target) => {
  if (!target) return
  const frame = iframeRef.value
  if (!frame?.contentWindow) return
  clearInterval(dsNavTimer)
  dsNavTries = 0
  dsNavTimer = setInterval(navigateDsToInstance, 1500)
  navigateDsToInstance()
})

onUnmounted(() => clearInterval(dsNavTimer))
</script>

<template>
  <div class="subapp-view">
    <iframe
      ref="iframeRef"
      :key="iframeKey"
      :src="appUrl"
      class="native-iframe"
      allow="fullscreen"
      @load="onIframeLoad"
    />
  </div>
</template>

<style scoped lang="scss">
.subapp-view {
  width: 100%;
  height: 100%;
}

.native-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

.subapp-status {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $panel;
  padding: 24px;
}
</style>
