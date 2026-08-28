/**
 * Monaco 基础设施:worker 注册、主题定义、URI 约定。
 * 只负责"环境",不承载业务补全逻辑(见 SqlEditor.vue)。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
// 只带 SQL / Python 两种 Monarch 高亮(basic-languages 其余语言不打包,控制体积)
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'

// ── Worker 注册(Vite ?worker 内联,绕开 MonacoEnvironment 404 坑)──
// SQL/Python 均无独立 language worker:基础 Monarch 高亮 + 自实现补全 provider,
// 因此只需 editor worker(光标/撤销/布局计算走 worker 线程)。
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

/** 供各组件复用同一 monaco 实例(避免再全量 import) */
export { monaco }

self.MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker()
  }
}

/** 本门户 SQL 画布的 model 标识:所有编辑器 model 统一 scheme,便于 provider 判定归属 */
export const EDITOR_URI_SCHEME = 'portal-sql'
export function editorUri(modelId: string): monaco.Uri {
  return monaco.Uri.parse(`${EDITOR_URI_SCHEME}://editor/${modelId}`)
}

// ── 主题:定义 portal-dark / portal-light,跟随画布双主题切换 ──
let themesDefined = false
export function definePortalThemes(): void {
  if (themesDefined) return
  themesDefined = true
  monaco.editor.defineTheme('portal-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: 'comment', foreground: '6a9955' }, { token: 'string', foreground: 'ce9178' }],
    colors: {
      'editor.background': '#1e2233',
      'editor.lineHighlightBackground': '#2a2f45',
      'editor.selectionBackground': '#264f78',
      'editorCursor.foreground': '#dcdcaa',
      'editorLineNumber.foreground': '#5a6380',
      'editorLineNumber.activeForeground': '#aab2d0',
      'editorWidget.background': '#262b40',
      'editorWidget.border': '#3a4160',
      'editorSuggestWidget.background': '#262b40'
    }
  })
  monaco.editor.defineTheme('portal-light', {
    base: 'vs',
    inherit: true,
    rules: [{ token: 'comment', foreground: '008000' }, { token: 'string', foreground: 'a31515' }],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f2f3f8',
      'editor.selectionBackground': '#add6ff'
    }
  })
}