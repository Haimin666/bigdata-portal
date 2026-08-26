<script setup lang="ts">
/**
 * LogViewer —— 通用只读日志查看器(2026-08,Monaco 只读实例承载):
 * 统一替换散落各域的手写 <pre> 日志面板(SparkLogPanel 日志体 / DsTaskMonitor 弹窗 /
 * FlinkPreJobDialog 抽屉)。能力:
 *  - Monaco readonly + log 语言:等宽字体、行号可选、自动贴底(append 时)、主题跟随全局
 *  - 大文本安全:value 走 model 替换,无 v-html;超长日志由调用方裁剪后传入
 *  - 空态提示 / 底部操作插槽(加载更多/刷新/清空由调用方决定)
 */
import { onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor'
import { setupMonaco } from '@/editor/setup'
import { getTheme } from '@/utils/theme'

const props = withDefaults(
  defineProps<{
    /** 日志全文(增量拼接后的完整文本) */
    text: string
    /** 空态提示(text 为空时展示) */
    empty?: string
    /** 是否显示行号(默认关:日志以阅读为主) */
    lineNumbers?: boolean
    /** 内容更新时是否自动滚到底部(默认 true) */
    follow?: boolean
    /** 高度(css height 值;默认撑满父容器) */
    height?: string
  }>(),
  { empty: '暂无日志', lineNumbers: false, follow: true, height: '100%' }
)

const box = ref<HTMLElement>()
let ed: monaco.editor.IStandaloneCodeEditor | null = null

onMounted(() => {
  setupMonaco()
  if (!box.value) return
  ed = monaco.editor.create(box.value, {
    value: props.text || '',
    // 未注册语言 = 纯文本(monaco 无内置 log 语言);日志无需语法高亮
    theme: getTheme() === 'dark' ? 'portal-dark' : 'portal-light',
    readOnly: true,
    automaticLayout: true,
    fontSize: 12,
    lineHeight: 20,
    lineNumbers: props.lineNumbers ? 'on' : 'off',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'off', // 日志保持原始行(横向滚动),不折行
    renderLineHighlight: 'none',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    contextmenu: true, // 保留右键复制
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 6,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false }
  })
  // 全局主题切换联动
  watch(
    () => getTheme(),
    (t) => monaco.editor.setTheme(t === 'dark' ? 'portal-dark' : 'portal-light')
  )
})

// 外部文本变化 → 程序性替换 model 值(保留只读);follow 时贴底
watch(
  () => props.text,
  (v) => {
    const e = ed
    if (!e) return
    if (e.getValue() === v) return
    const model = e.getModel()
    if (model) {
      // 全量替换(日志为整体刷新语义);保存光标无意义(只读)
      const full = model.getFullModelRange()
      e.executeEdits('logviewer', [{ range: full, text: v }])
      if (props.follow) e.revealLine(model.getLineCount())
    } else {
      e.setValue(v)
    }
  }
)
</script>

<template>
  <div class="log-viewer" :style="{ height }">
    <div v-if="!text" class="log-empty">{{ empty }}</div>
    <div ref="box" class="log-monaco"></div>
  </div>
</template>

<style scoped lang="scss">
.log-viewer {
  position: relative;
  min-height: 0;
  overflow: hidden;

  .log-monaco {
    position: absolute;
    inset: 0;
  }

  .log-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    z-index: 1;
    pointer-events: none;
  }
}
</style>
