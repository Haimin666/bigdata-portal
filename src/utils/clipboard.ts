/**
 * 剪贴板复制工具。
 *
 * 背景:门户在纯 HTTP 内网(开发 localhost:3002 / 容器 9910)运行,属于「非安全上下文」,
 * 此时浏览器不暴露 `navigator.clipboard`(取值为 undefined),直接
 * `navigator.clipboard.writeText()` 会抛 TypeError,导致点击复制失败。
 * 本工具做三层降级:
 *   1. `navigator.clipboard.writeText`(仅安全上下文可用,异步);
 *   2. `document.execCommand('copy')`(临时 textarea 选中复制,同步,兼容 HTTP/旧浏览器);
 *   3. 全部失败返回 false,由调用方提示用户手动复制。
 *
 * @param text 要复制的文本(null/undefined 视为空串)
 * @returns 是否复制成功
 */
export async function copyText(text: unknown): Promise<boolean> {
  const val = text == null ? '' : String(text)
  if (!val) return true

  // 1) 优先异步 Clipboard API(仅安全上下文暴露)
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(val)
      return true
    } catch {
      // 权限被拒等 → 降级 execCommand
    }
  }

  // 2) 降级:临时 textarea + document.execCommand('copy')
  return copyWithExecCommand(val)
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false
  let ta: HTMLTextAreaElement | null = null
  try {
    ta = document.createElement('textarea')
    ta.value = text
    // 移到可视区外即可,勿用 display:none(部分浏览器对隐藏元素 execCommand 无效)
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.left = '-9999px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    // iOS Safari 需要显式设置选区
    ta.setSelectionRange(0, ta.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta)
  }
}
