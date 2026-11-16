/**
 * 数据库查询模块统一 localStorage 读写 / 容量保护工具。
 *
 * 背景(2026-09 审计):
 *  - 历史 / 收藏存在两套读写实现与两套上限(20 / 50),整表覆盖写容易丢数据;
 *  - 历史结果快照写 localStorage 触发配额时被静默吞掉,连历史本身也一起丢;
 *  - 结果列宽键无上限、签名用 SQL 前 40 字符,不同查询容易碰撞;
 *  - 临时草稿与快照分散在各组件里各自 try/catch。
 *
 * 本模块只依赖浏览器 localStorage,不引入任何第三方依赖;所有写操作失败都降级为
 * console.warn,不向用户弹窗。
 */

/** 历史记录(新在前,按 sql 去重) */
export interface QueryHistoryEntry {
  ts: number
  sql: string
  /** 结果快照(执行成功时写入,最多前 100 行) */
  result?: { columns: string[]; rows: Record<string, unknown>[] }
  /** 快照行数(便于 UI 展示「前 N 行」) */
  snapshotRows?: number
}

/** 历史 / 收藏统一上限(写端读端共用,避免两套上限互相截断) */
export const HISTORY_MAX = 50
export const FAVORITES_MAX = 50
/** 结果快照最多保留行数 */
export const HISTORY_RESULT_ROWS = 100
/** 结果快照序列化后的真实字节上限(按 Blob 字节而非字符数估算) */
export const HISTORY_RESULT_MAX_BYTES = 200_000

/** 临时草稿(未命名 tab 刷新后可恢复) */
export const TEMP_DRAFTS_KEY = 'db-query-temp-tabs'
/** 列宽缓存前缀(容量治理按该前缀统计) */
export const COLW_PREFIX = 'db-query-colw.'
/** 列宽缓存最多保留的键数 */
export const COLW_MAX_KEYS = 200

const HISTORY_PREFIX = 'db-query-history:'
const FAVORITES_PREFIX = 'db-query-favorites:'

export function historyKey(username: string): string {
  return `${HISTORY_PREFIX}${username || 'default'}`
}

export function favoritesKey(username: string): string {
  return `${FAVORITES_PREFIX}${username || 'default'}`
}

/** 是否 localStorage 配额错误(各浏览器 name/code 不一致) */
function isQuotaError(error: unknown): boolean {
  const e = error as { name?: string; code?: number } | null
  if (!e) return false
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  )
}

/** 统一 JSON 读取:损坏 / 不可用时返回 fallback,不抛错 */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 统一 JSON 写入:失败(含配额)返回 false,不抛错 */
export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (error) {
    if (isQuotaError(error)) {
      console.warn(`[db-query-cache] localStorage 配额不足,写入失败: ${key}`)
    } else {
      console.warn(`[db-query-cache] localStorage 写入失败: ${key}`, error)
    }
    return false
  }
}

/** 按真实 UTF-8 字节估算 JSON 大小(Blob 不可用时退回字符数) */
export function estimateJsonBytes(value: unknown): number {
  let json = ''
  try {
    json = JSON.stringify(value) ?? ''
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
  try {
    if (typeof Blob !== 'undefined') return new Blob([json]).size
  } catch {
    /* 忽略,回退字符数 */
  }
  return json.length
}

/** 稳定短哈希(djb2),用于列宽签名 / localStorage 键,不用于安全场景 */
export function djb2Hash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

function normalizeEntry(raw: unknown): QueryHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<QueryHistoryEntry>
  if (typeof item.sql !== 'string' || typeof item.ts !== 'number') return null
  const entry: QueryHistoryEntry = { ts: item.ts, sql: item.sql }
  if (item.result && Array.isArray(item.result.columns) && Array.isArray(item.result.rows)) {
    entry.result = { columns: item.result.columns, rows: item.result.rows }
    entry.snapshotRows = typeof item.snapshotRows === 'number' ? item.snapshotRows : item.result.rows.length
  }
  return entry
}

/** 读取历史(过滤损坏条目) */
export function readHistory(username: string): QueryHistoryEntry[] {
  const parsed = readJson<unknown>(historyKey(username), [])
  if (!Array.isArray(parsed)) return []
  return parsed.map(normalizeEntry).filter((entry): entry is QueryHistoryEntry => entry !== null)
}

/** 读取收藏 */
export function readFavorites(username: string): QueryHistoryEntry[] {
  const parsed = readJson<unknown>(favoritesKey(username), [])
  if (!Array.isArray(parsed)) return []
  return parsed.map(normalizeEntry).filter((entry): entry is QueryHistoryEntry => entry !== null)
}

function trySetItem(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (error) {
    if (isQuotaError(error)) return false
    console.warn(`[db-query-cache] localStorage 写入失败: ${key}`, error)
    return false
  }
}

/**
 * 写历史:配额不足时逐条丢弃最旧的快照后重试(最多 HISTORY_MAX 次),
 * 仍失败则降级写不含快照的条目;再失败只 warn,不影响调用方。
 */
function writeHistoryEntries(username: string, entries: QueryHistoryEntry[]): void {
  let list = entries.slice(0, HISTORY_MAX).map((entry) => ({ ...entry }))
  const maxRetries = Math.min(HISTORY_MAX, list.length)
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (trySetItem(historyKey(username), list)) return
    // 从最旧(数组尾部)开始找第一个带快照的条目并剥离
    let snapshotIdx = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].result) {
        snapshotIdx = i
        break
      }
    }
    if (snapshotIdx < 0) break
    list = list.map((entry, i) => {
      if (i !== snapshotIdx) return entry
      const { result: _result, snapshotRows: _snapshotRows, ...rest } = entry
      return rest
    })
  }
  // 降级:整体去掉快照再写一次
  const stripped = list.map(({ result: _result, snapshotRows: _snapshotRows, ...rest }) => rest)
  if (!trySetItem(historyKey(username), stripped)) {
    console.warn(`[db-query-cache] 历史记录写入失败(已降级为不含快照): ${historyKey(username)}`)
  }
}

/**
 * 追加历史(读-改-写前重新读取最新值,降低多 tab 互相覆盖概率):
 * 新在前、按 sql 去重、上限 HISTORY_MAX。
 * @returns 写入后的最新历史列表
 */
export function addHistoryEntry(
  username: string,
  sql: string,
  result?: { columns: string[]; rows: Record<string, unknown>[] } | null
): QueryHistoryEntry[] {
  const normalizedSql = String(sql ?? '').trim()
  if (!normalizedSql || normalizedSql.length > 2000) return readHistory(username)
  let list = readHistory(username).filter((entry) => entry.sql !== normalizedSql)
  const entry: QueryHistoryEntry = { ts: Date.now(), sql: normalizedSql }
  if (
    result &&
    Array.isArray(result.columns) &&
    result.columns.length &&
    Array.isArray(result.rows) &&
    result.rows.length
  ) {
    const snapshot = {
      columns: [...result.columns],
      rows: result.rows.slice(0, HISTORY_RESULT_ROWS)
    }
    // 快照大小按真实字节估算;超限则不缓存快照,历史本身仍保留
    if (estimateJsonBytes(snapshot) <= HISTORY_RESULT_MAX_BYTES) {
      entry.result = snapshot
      entry.snapshotRows = snapshot.rows.length
    }
  }
  list = [entry, ...list].slice(0, HISTORY_MAX)
  writeHistoryEntries(username, list)
  return list
}

/** 删除一条历史(按 sql 匹配,与去重口径一致) */
export function removeHistoryEntry(username: string, item: QueryHistoryEntry): QueryHistoryEntry[] {
  const list = readHistory(username).filter((entry) => entry.sql !== item.sql)
  writeHistoryEntries(username, list)
  return list
}

/** 清空历史 */
export function clearHistoryEntries(username: string): void {
  writeHistoryEntries(username, [])
}

/** 收藏:从最新历史里按 sql 移除,再按 sql 去重写入收藏(新在前,上限 FAVORITES_MAX) */
export function toggleFavoriteEntry(
  username: string,
  item: QueryHistoryEntry
): { history: QueryHistoryEntry[]; favorites: QueryHistoryEntry[] } {
  const sql = String(item.sql ?? '').trim()
  if (!sql) return { history: readHistory(username), favorites: readFavorites(username) }
  const history = readHistory(username).filter((entry) => entry.sql !== sql)
  const favorites = [
    { ...item, sql },
    ...readFavorites(username).filter((entry) => entry.sql !== sql)
  ].slice(0, FAVORITES_MAX)
  writeHistoryEntries(username, history)
  if (!trySetItem(favoritesKey(username), favorites)) {
    console.warn(`[db-query-cache] 收藏写入失败: ${favoritesKey(username)}`)
  }
  return { history, favorites }
}

/** 取消收藏(按 sql 匹配) */
export function removeFavoriteEntry(username: string, item: QueryHistoryEntry): QueryHistoryEntry[] {
  const favorites = readFavorites(username).filter((entry) => entry.sql !== item.sql)
  if (!trySetItem(favoritesKey(username), favorites)) {
    console.warn(`[db-query-cache] 收藏写入失败: ${favoritesKey(username)}`)
  }
  return favorites
}

/** localStorage 变化(其它浏览器 tab 写入历史/收藏)时回调;返回取消订阅函数 */
export function onDbQueryStorageChange(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = (event: StorageEvent): void => {
    if (!event.key || event.key.startsWith(HISTORY_PREFIX) || event.key.startsWith(FAVORITES_PREFIX)) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

// ── 结果列宽缓存 ─────────────────────────────────────────────
// key: db-query-colw.<签名哈希>.<列名>.<写入时间戳>
// 读时扫描同一签名前缀,取该列最新时间戳的值;写入后按前缀总量做容量治理。

function colWidthPrefix(signature: string): string {
  return `${COLW_PREFIX}${djb2Hash(signature)}.`
}

function listStorageKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) keys.push(key)
    }
  } catch {
    /* localStorage 不可用 */
  }
  return keys
}

/** 读取一个结果签名下的全部列宽(列名 → 宽度);按前缀只扫描一次 */
export function readColumnWidths(signature: string): Map<string, number> {
  const prefix = colWidthPrefix(signature)
  const latest = new Map<string, { ts: number; width: number }>()
  for (const key of listStorageKeys()) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    const dot = rest.lastIndexOf('.')
    if (dot <= 0) continue
    let column = rest.slice(0, dot)
    try {
      column = decodeURIComponent(column)
    } catch {
      continue
    }
    const ts = Number(rest.slice(dot + 1))
    let width = 0
    try {
      width = Number(localStorage.getItem(key) || '')
    } catch {
      continue
    }
    if (!Number.isFinite(ts) || !Number.isFinite(width) || width <= 60) continue
    const prev = latest.get(column)
    if (!prev || ts > prev.ts) latest.set(column, { ts, width: Math.round(width) })
  }
  const result = new Map<string, number>()
  for (const [column, item] of latest) result.set(column, item.width)
  return result
}

/** 容量治理:超出 COLW_MAX_KEYS 时按写入时间戳删除最旧的键 */
function pruneColumnWidthKeys(): void {
  const entries: Array<{ key: string; ts: number }> = []
  for (const key of listStorageKeys()) {
    if (!key.startsWith(COLW_PREFIX)) continue
    const dot = key.lastIndexOf('.')
    const ts = dot >= 0 ? Number(key.slice(dot + 1)) : NaN
    entries.push({ key, ts: Number.isFinite(ts) ? ts : 0 })
  }
  if (entries.length <= COLW_MAX_KEYS) return
  entries.sort((a, b) => a.ts - b.ts)
  const removeCount = entries.length - COLW_MAX_KEYS
  for (let i = 0; i < removeCount; i++) {
    try {
      localStorage.removeItem(entries[i].key)
    } catch {
      /* 忽略单条删除失败 */
    }
  }
}

/** 写入单列宽度;同名旧键先删除,再写入带时间戳的新键 */
export function writeColumnWidth(signature: string, column: string, width: number): void {
  const prefix = colWidthPrefix(signature)
  const columnKey = `${prefix}${encodeURIComponent(column)}.`
  try {
    const staleKeys: string[] = []
    for (const key of listStorageKeys()) {
      if (key.startsWith(columnKey)) staleKeys.push(key)
    }
    for (const key of staleKeys) localStorage.removeItem(key)
    localStorage.setItem(`${columnKey}${Date.now()}`, String(Math.round(width)))
  } catch (error) {
    console.warn('[db-query-cache] 列宽写入失败', error)
  }
  pruneColumnWidthKeys()
}
