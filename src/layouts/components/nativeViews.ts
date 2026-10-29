/**
 * 原生视图的异步组件与加载器。
 * TabStage 负责渲染,SideBar 在菜单 hover 时用同一份加载器预热 chunk,
 * 集中在一处可避免映射漂移(G6/Monaco 曾因静态引入被拖进首屏)。
 */
import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import ViewLoading from './ViewLoading.vue'

type ViewLoader = () => Promise<{ default: Component }>

const viewLoaders: Record<string, ViewLoader> = {
  yarn: () => import('@/views/yarn/YarnView.vue'),
  dsTask: () => import('@/views/ds/DsTaskMonitor.vue'),
  hdfs: () => import('@/views/hdfs/HdfsView.vue'),
  dbQuery: () => import('@/views/db/QueryView.vue'),
  userManage: () => import('@/views/admin/UserManageView.vue'),
  dataleap: () => import('@/views/dataleap/DataLeapView.vue'),
  sync: () => import('@/views/sync/SyncCodeView.vue'),
  creditDictionary: () => import('@/views/credit-dictionary/CreditDictionaryView.vue')
}

export const nativeViewComponents: Record<string, Component> = Object.fromEntries(
  Object.entries(viewLoaders).map(([name, loader]) => [
    name,
    defineAsyncComponent({ loader, loadingComponent: ViewLoading, delay: 200 })
  ])
)

/** 预热视图 chunk:失败静默(用户仍可通过正常导航重试) */
export function prefetchNativeView(name: string): void {
  void viewLoaders[name]?.().catch(() => {})
}
