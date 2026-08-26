/**
 * Monaco 全局初始化(单一入口,应用启动时调用一次):
 * - 自定义 portal 亮/暗主题(替代原 CodeMirror 的 :deep 样式适配)
 * - SQL/Python 语言注册(SQL 补全 provider 在 sqlCompletion.ts 单独注册)
 * 幂等:重复调用直接跳过。
 */
import * as monaco from 'monaco-editor'
import { registerSqlCompletion } from './sqlCompletion'

let initialized = false

/** 门户暗色主题(与全局 html.dark 的 #0b1220 系背景协调) */
const PORTAL_DARK: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a7a8f', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7aa2f7' },
    { token: 'string', foreground: '9ece6a' },
    { token: 'number', foreground: 'ff9e64' }
  ],
  colors: {
    'editor.background': '#111827',
    'editorLineNumber.foreground': '#4b5a6e',
    'editor.lineHighlightBackground': '#1c2536',
    'editor.selectionBackground': '#2d3f5e',
    'editorGutter.background': '#111827',
    'editorIndentGuide.background1': '#232e42'
  }
}

/** 门户亮色主题(微调默认 vs,贴近原 CodeMirror default 观感) */
const PORTAL_LIGHT: monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [{ token: 'comment', foreground: '8a94a3', fontStyle: 'italic' }],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f5f7fa'
  }
}

/** 初始化 Monaco:主题 + 语言。必须在创建任何 editor 实例之前完成。 */
export function setupMonaco(): void {
  if (initialized) return
  initialized = true
  monaco.editor.defineTheme('portal-dark', PORTAL_DARK)
  monaco.editor.defineTheme('portal-light', PORTAL_LIGHT)
  registerSqlCompletion(monaco)
}
