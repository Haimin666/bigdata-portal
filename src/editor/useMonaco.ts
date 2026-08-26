/**
 * Vue 组合式:Monaco 编辑器实例生命周期与常用操作封装(QueryView 专用薄层)。
 * 职责:创建/销毁、主题(全局跟随或独立)、模型(model)即 tab 文档管理、内容/选区读写。
 * 业务逻辑(SQL 分段/参数替换/保存)不在此层,由调用方组合。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import * as monaco from 'monaco-editor'
import { setupMonaco } from './setup'
import { getTheme } from '@/utils/theme'

export interface MonacoOptions {
  /** 初始语言 */
  language?: string
  /** 初始字号 px(默认 13;调用方可后续 updateFont) */
  fontSize?: number
  /** 是否跟随全局主题变化(默认 false:QueryView 画布主题独立) */
  followGlobalTheme?: boolean
}

const THEME_BY_MODE = { dark: 'portal-dark', light: 'portal-light' } as const

/**
 * 挂载 Monaco 到容器;返回实例句柄与操作集。
 * automaticLayout 内建(替代原 ResizeObserver/refresh 补丁)。
 */
export function useMonaco(container: Ref<HTMLElement | undefined>, opts: MonacoOptions = {}) {
  const editor = ref<monaco.editor.IStandaloneCodeEditor | null>(null)

  /** 程序性写入抑制位:setValue/setModel 切换期间 change 事件不标 dirty(等价 CM origin==='setValue') */
  let programmatic = false

  onMounted(() => {
    setupMonaco()
    if (!container.value) return
    const initMode = getTheme() === 'dark' ? 'dark' : 'light'
    editor.value = monaco.editor.create(container.value, {
      value: '',
      language: opts.language || 'sql',
      theme: opts.followGlobalTheme === false ? THEME_BY_MODE[initMode] : THEME_BY_MODE[initMode],
      automaticLayout: true,
      fontSize: opts.fontSize ?? 13,
      lineHeight: 1.6 * (opts.fontSize ?? 13),
      lineNumbers: 'on',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on', // 对齐原 lineWrapping
      tabSize: 2,
      insertSpaces: true, // 对齐原 indentWithTabs:false + Tab 两空格
      renderWhitespace: 'none',
      matchBrackets: 'near',
      folding: true,
      lineDecorationsWidth: 8,
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      // 输入标识符自动弹补全(等价原 inputRead+150ms 防抖);注释/字符串内不弹
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'currentDocument',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      renderLineHighlight: 'line',
      guides: { indentation: true },
      bracketPairColorization: { enabled: false }
    })
    if (opts.followGlobalTheme !== false) {
      watch(
        () => getTheme(),
        (t) => monaco.editor.setTheme(THEME_BY_MODE[t === 'dark' ? 'dark' : 'light'])
      )
    }
  })

  onBeforeUnmount(() => {
    editor.value?.dispose()
    editor.value = null
  })

  /** 当前内容全文 */
  function getValue(): string {
    return editor.value?.getValue() ?? ''
  }

  /** 程序性覆盖全文:change 事件仍派发(syncRunVarBar 依赖),但不标 dirty/自动保存 */
  function setValue(text: string): void {
    const ed = editor.value
    if (!ed) return
    programmatic = true
    try {
      ed.setValue(text)
    } finally {
      programmatic = false
    }
  }

  /**
   * 程序性挂载另一文档(tab 切换):同 setValue 抑制 dirty;
   * 返回挂载是否发生(调用方据此决定快照兜底)。
   */
  function setModel(model: monaco.editor.ITextModel | null): boolean {
    const ed = editor.value
    if (!ed || !model) return false
    if (ed.getModel() === model) return false
    programmatic = true
    try {
      ed.setModel(model)
    } finally {
      programmatic = false
    }
    return true
  }

  /** 光标处插入文本并聚焦(表名/字段名/DDL 插入);插入后光标停在文本尾 */
  function insertAtCursor(text: string): void {
    const ed = editor.value
    if (!ed) return
    const sel = ed.getSelection()
    ed.executeEdits('insert', sel ? [{ range: sel, text, forceMoveMarkers: true }] : [])
    ed.pushUndoStop()
    ed.focus()
  }

  /** 选区文本(无选区返回空串) */
  function getSelectionText(): string {
    const ed = editor.value
    if (!ed) return ''
    const sel = ed.getSelection()
    return sel ? (ed.getModel()?.getValueInRange(sel) ?? '') : ''
  }

  /** 光标在全文中的偏移(光标所在段判定用) */
  function getCursorOffset(): number {
    const ed = editor.value
    if (!ed) return 0
    const pos = ed.getPosition()
    const model = ed.getModel()
    return pos && model ? model.getOffsetAt(pos) : 0
  }

  /** 切换当前文档语言(pyspark↔sql 引擎联动) */
  function setLanguage(language: string): void {
    const model = editor.value?.getModel()
    if (model) monaco.editor.setModelLanguage(model, language)
  }

  /** 设置画布主题(QueryView 独立主题按钮) */
  function setTheme(mode: 'dark' | 'light'): void {
    monaco.editor.setTheme(THEME_BY_MODE[mode])
  }

  /** 调整字号(工具栏 A-/A+) */
  function setFontSize(px: number): void {
    editor.value?.updateOptions({ fontSize: px, lineHeight: Math.round(px * 1.6) })
  }

  /**
   * 注册内容变化回调。fn(programmatic):
   *  - programmatic=true:setValue/setModel 等程序性写入(只同步参数行,不标 dirty)
   */
  function onContentChange(fn: (programmatic: boolean) => void): void {
    editor.value?.onDidChangeModelContent(() => fn(programmatic))
  }

  /** 注册快捷键(等价 CM extraKeys;返回释放函数) */
  function addCommands(map: Array<{ key: number; run: () => void }>): void {
    for (const { key, run } of map) editor.value?.addCommand(key, run)
  }

  return {
    editor,
    getValue,
    setValue,
    setModel,
    insertAtCursor,
    getSelectionText,
    getCursorOffset,
    setLanguage,
    setTheme,
    setFontSize,
    onContentChange,
    addCommands
  }
}

export type MonacoHandle = ReturnType<typeof useMonaco>
