<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Folder, Document, Plus, Refresh, CaretRight, Coin, Grid, Search, CopyDocument, Star, StarFilled, Delete } from '@element-plus/icons-vue'
import {
  listScriptTree,
  createScriptNode,
  renameScriptNode,
  deleteScriptNode,
  moveScriptNode,
  listTables,
  listFields,
  getTableDDL,
  type ScriptNode,
  type DbDataSource,
  type TableMeta,
  type TableFieldDetail
} from '@/api/db'
import { copyText } from '@/utils/clipboard'

defineOptions({ name: 'SqlTreePanel' })

const props = defineProps<{ dbs: DbDataSource[] }>()
const emit = defineEmits<{
  (e: 'open', node: ScriptNode): void
  (e: 'insert', text: string): void
  (e: 'openTable', payload: { db: string; table: string }): void
  (e: 'runSql', sql: string, result?: HistResult): void
}>()

const activeTab = ref<'my' | 'catalog' | 'history'>('my')

// ── 模糊搜索(我的目录 / 表目录,按名称包含匹配)────────────────
const mySearch = ref('')
const catSearch = ref('')
const myTreeRef = ref()
const catTreeRef = ref()

/** el-tree filter-node-method:名称模糊匹配(大小写不敏感) */
function filterNode(value: string, data: { name?: string }): boolean {
  if (!value) return true
  return String(data.name || '').toLowerCase().includes(String(value).toLowerCase())
}

watch(mySearch, (v) => myTreeRef.value?.filter(v))
watch(catSearch, (v) => catTreeRef.value?.filter(v))

// ── 我的目录(双根:我的文件夹私有 + 共享文件夹公共)───────────────
const SHARED_ROOT_ID = '__shared_root'
const myTree = ref<ScriptNode[]>([])
const myLoading = ref(false)

/** 判断节点是否在共享文件夹内(含根);共享内容全员可编辑,仅用于「复制到我的文件夹」入口 */
function isShared(data: ScriptNode): boolean {
  if (data.id === SHARED_ROOT_ID) return true
  const sharedRoot = myTree.value.find((n) => n.id === SHARED_ROOT_ID)
  if (!sharedRoot?.children) return false
  const stack = [...sharedRoot.children]
  while (stack.length) {
    const n = stack.pop()!
    if (n.id === data.id) return true
    if (n.children) stack.push(...n.children)
  }
  return false
}

async function reloadMy() {
  myLoading.value = true
  try {
    const t = await listScriptTree()
    myTree.value = t.my || []
  } catch (e) {
    ElMessage.error(`加载脚本目录失败:${e instanceof Error ? e.message : e}`)
  } finally {
    myLoading.value = false
  }
}

defineExpose({ reloadMy })

/** 节点点击:文件打开;目录展开/折叠由 el-tree 默认行为处理 */
function onNodeClick(data: ScriptNode) {
  if (data.type === 'file') emit('open', data)
}

/** 新建(根级或目录内;共享文件夹全员可写) */
async function onCreate(parent: ScriptNode | null, kind: 'dir' | 'file') {
  const defaultName = kind === 'dir' ? '新建目录' : '新建脚本.sql'
  try {
    const { value } = await ElMessageBox.prompt('名称', kind === 'dir' ? '新建目录' : '新建 SQL 文件', {
      inputValue: defaultName,
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    await createScriptNode(parent?.id ?? null, (value || '').trim(), kind)
    await reloadMy()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(`新建失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 重命名 */
async function onRename(node: ScriptNode) {
  try {
    const { value } = await ElMessageBox.prompt('新名称', '重命名', {
      inputValue: node.name,
      inputValidator: (v) => (v?.trim() ? true : '名称不能为空')
    })
    await renameScriptNode(node.id, (value || '').trim())
    await reloadMy()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(`重命名失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 删除 */
async function onDelete(node: ScriptNode) {
  try {
    await ElMessageBox.confirm(
      node.type === 'dir' ? `删除目录「${node.name}」及其全部文件?` : `删除文件「${node.name}」?`,
      '确认删除',
      { type: 'warning' }
    )
    await deleteScriptNode(node.id)
    await reloadMy()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(`删除失败:${e instanceof Error ? e.message : e}`)
  }
}

// ── 表目录(库→表→字段,懒加载树,库来自数据源列表)────────────
interface CatNode extends Record<string, unknown> {
  id: string
  name: string
  kind: 'db' | 'table' | 'field'
  isLeaf: boolean
  db?: string
  table?: string
  typeName?: string
  /** 表/字段注释(detail=1 时后端返回) */
  comment?: string
}

/** 树懒加载:根=库 → 表 → 字段 */
async function lazyLoad(node: any, resolve: (nodes: CatNode[]) => void) {
  try {
    if (node.level === 0) {
      // 根节点:库列表(来自数据源)
      resolve(
        props.dbs.map((d) => ({
          id: `db:${d.name}`,
          name: d.label || d.name,
          kind: 'db' as const,
          isLeaf: false,
          db: d.name
        }))
      )
      return
    }
    const data = node.data as CatNode
    if (data.kind === 'db') {
      const tables = await listTables(data.db || '', true)
      resolve(
        (tables as TableMeta[]).map((t) => ({
          id: `t:${t.name}`,
          name: t.name,
          kind: 'table' as const,
          isLeaf: false,
          db: data.db,
          table: t.name,
          comment: t.comment
        }))
      )
    } else if (data.kind === 'table') {
      const fields = (await listFields(data.db || '', data.table || data.name, true)) as TableFieldDetail[]
      resolve(
        fields.map((f) => ({
          id: `f:${data.table}:${f.name}`,
          name: f.name,
          kind: 'field' as const,
          isLeaf: true,
          db: data.db,
          table: data.table,
          typeName: f.type,
          comment: f.comment
        }))
      )
    } else {
      resolve([])
    }
  } catch (e) {
    ElMessage.error(`加载表结构失败:${e instanceof Error ? e.message : e}`)
    resolve([])
  }
}

/** 单击:字段插入;库/表仅展开(双击预览需点表按钮) */
function onCatalogClick(data: CatNode) {
  if (data.kind === 'db' || data.kind === 'table') return // 库/表仅展开
  emit('insert', data.name) // 字段:保持点击插入
}

/** 双击表:预览数据(交给父组件开新 tab 查 SELECT * LIMIT 100) */
function onTableDblClick(data: CatNode) {
  if (data.kind !== 'table') return
  emit('openTable', { db: data.db || '', table: data.table || data.name })
}

/** 复制表名到画布(点 + 按钮) */
function onCopyTable(data: CatNode) {
  emit('insert', data.table || data.name)
  ElMessage.success(`已插入 ${data.table || data.name}`)
}

/** 复制建表语句(点复制 DDL 按钮) */
async function onCopyDDL(data: CatNode) {
  const db = data.db || ''
  const table = data.table || data.name
  try {
    const { ddl } = await getTableDDL(db, table)
    const ok = await copyText(ddl)
    if (!ok) throw new Error('剪贴板写入失败')
    ElMessage.success(`已复制建表语句 ${table}`)
  } catch (e) {
    ElMessage.error(`复制建表语句失败:${e instanceof Error ? e.message : e}`)
  }
}

// ── 历史与收藏(localStorage 持久化,history 由父组件 QueryView 写入)──────
const HISTORY_KEY = 'db-query-history'
const FAV_KEY = 'db-query-favorites'
const HISTORY_MAX = 50

interface HistItem {
  ts: number
  sql: string
  /** 查询结果快照(执行成功时由 QueryView 写入,截断到前 100 行) */
  result?: HistResult
}

/** 结果快照形状(与 QueryView 写入端一致) */
interface HistResult {
  columns: string[]
  rows: Record<string, unknown>[]
}

const historyList = ref<HistItem[]>([])
const favList = ref<HistItem[]>([])

/** 容错读取 localStorage(损坏 JSON/非数组返回空,不抛错) */
function readStore(key: string): HistItem[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (h): h is HistItem => !!h && typeof h === 'object' && typeof h.sql === 'string' && typeof h.ts === 'number'
    )
  } catch {
    return []
  }
}

/** 写回 localStorage(截断到上限;localStorage 不可用如 Safari 隐私模式时静默忽略) */
function writeStore(key: string, list: HistItem[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, HISTORY_MAX)))
  } catch {
    /* 忽略 */
  }
}

/** 读取历史 + 收藏(挂载与激活历史 tab 时各刷新一次) */
function loadHistory() {
  historyList.value = readStore(HISTORY_KEY)
  favList.value = readStore(FAV_KEY)
}

/** 时间格式:今天 HH:mm,跨天 MM-DD HH:mm */
function formatTime(ts: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date(ts)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** 点击历史/收藏条目:回填编辑器(不自动执行);有缓存结果则一并交给父组件直接展示 */
function onRunItem(item: HistItem) {
  emit('runSql', item.sql, item.result)
}

/** 收藏:从历史移除该条,写入收藏(去重、新在前、上限 50) */
function toggleFav(item: HistItem) {
  const sql = String(item.sql || '').trim()
  if (!sql) return
  historyList.value = historyList.value.filter((h) => h !== item)
  writeStore(HISTORY_KEY, historyList.value)
  favList.value = [{ ...item, sql }, ...favList.value.filter((f) => f.sql !== sql)].slice(0, HISTORY_MAX)
  writeStore(FAV_KEY, favList.value)
  ElMessage.success('已收藏')
}

/** 取消收藏:从收藏列表移除 */
function removeFav(item: HistItem) {
  favList.value = favList.value.filter((f) => f !== item)
  writeStore(FAV_KEY, favList.value)
}

/** 删除单条历史 */
function removeHistory(item: HistItem) {
  historyList.value = historyList.value.filter((h) => h !== item)
  writeStore(HISTORY_KEY, historyList.value)
}

/** 清空全部历史(确认后) */
async function clearHistory() {
  if (!historyList.value.length) return
  try {
    await ElMessageBox.confirm('确定清空全部查询历史?清空后不可恢复。', '清空历史', { type: 'warning' })
  } catch {
    return // 取消/关闭
  }
  historyList.value = []
  writeStore(HISTORY_KEY, historyList.value)
  ElMessage.success('历史已清空')
}

watch(activeTab, (v) => {
  if (v === 'history') loadHistory()
})

// datasources 异步到达后重建表目录树(重新加载根库列表)
const dbsKey = computed(() => props.dbs.map((d) => d.name).join(','))

// ── 右键菜单(我的目录节点)──────────────────────────────────
const ctx = ref<{ show: boolean; x: number; y: number; node: ScriptNode | null }>({
  show: false,
  x: 0,
  y: 0,
  node: null
})

function openCtx(e: MouseEvent, node: ScriptNode) {
  e.preventDefault()
  e.stopPropagation()
  // 全部节点同一套完整菜单;共享节点额外提供「复制到我的文件夹」
  const menuW = 170
  const menuH = node.type === 'dir' ? (isShared(node) ? 190 : 150) : isShared(node) ? 140 : 110
  const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
  ctx.value = { show: true, x, y, node }
}

function closeCtx() {
  ctx.value.show = false
}

function menuCreate(kind: 'dir' | 'file') {
  const node = ctx.value.node
  closeCtx()
  if (node) void onCreate(node, kind)
}

function menuRename() {
  const node = ctx.value.node
  closeCtx()
  if (node) void onRename(node)
}

function menuDelete() {
  const node = ctx.value.node
  closeCtx()
  if (node) void onDelete(node)
}

/** 把共享文件/目录复制到我的文件夹根(新建副本,不动原件;递归复制目录) */
async function menuCopyToMy() {
  const node = ctx.value.node
  closeCtx()
  if (!node) return
  try {
    const sharedRoot = myTree.value.find((n) => n.id === SHARED_ROOT_ID)
    await copyIntoMy(sharedRoot, node, null)
    ElMessage.success(`已复制「${node.name}」到我的文件夹`)
    await reloadMy()
  } catch (e) {
    ElMessage.error(`复制失败:${e instanceof Error ? e.message : e}`)
  }
}

/** 递归把 sharedNode(来自共享区)克隆进我的文件夹目标父目录 */
async function copyIntoMy(
  sharedRoot: ScriptNode | undefined,
  srcNode: ScriptNode,
  targetParentId: string | null
) {
  void sharedRoot
  const clean = srcNode.type === 'file' && !srcNode.name.endsWith('.sql') ? `${srcNode.name}.sql` : srcNode.name
  const created = await createScriptNode(targetParentId, clean, srcNode.type)
  if (srcNode.type === 'file') {
    // 复制内容:get 原文 → save 副本(动态引入避免顶层循环依赖)
    const { getScriptContent, saveScriptContent } = await import('@/api/db')
    const { content } = await getScriptContent(srcNode.id)
    await saveScriptContent(created.id, content)
  } else {
    for (const child of srcNode.children || []) {
      await copyIntoMy(sharedRoot, child, created.id)
    }
  }
}

// ── 拖拽移动(共享文件夹全员可写,允许拖入/拖出)──────────
function allowDrop(_draggingNode: unknown, dropNode: any, type: 'prev' | 'inner' | 'next'): boolean {
  if (type !== 'inner') return false
  const target = dropNode.data as ScriptNode
  return target.type === 'dir'
}

async function onNodeDrop(draggingNode: any, dropNode: any, type: 'prev' | 'inner' | 'next') {
  if (type !== 'inner') return
  const node = draggingNode.data as ScriptNode
  const target = dropNode.data as ScriptNode
  try {
    await moveScriptNode(node.id, target.id)
    await reloadMy()
    ElMessage.success(`已移动到「${target.name}」`)
  } catch (e) {
    ElMessage.error(`移动失败:${e instanceof Error ? e.message : e}`)
    await reloadMy() // 回滚展示
  }
}

onMounted(() => {
  void reloadMy()
  loadHistory()
  window.addEventListener('click', closeCtx)
  window.addEventListener('contextmenu', closeCtx)
})

onUnmounted(() => {
  window.removeEventListener('click', closeCtx)
  window.removeEventListener('contextmenu', closeCtx)
})
</script>

<template>
  <div class="sql-tree-panel">
    <div class="panel-tabs">
      <div class="ptab" :class="{ active: activeTab === 'my' }" @click="activeTab = 'my'">我的目录</div>
      <div class="ptab" :class="{ active: activeTab === 'catalog' }" @click="activeTab = 'catalog'">表目录</div>
      <div class="ptab" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">历史</div>
    </div>

    <!-- 我的目录 -->
    <div v-show="activeTab === 'my'" class="panel-body">
      <div class="panel-toolbar">
        <span class="toolbar-title">SQL 脚本</span>
        <el-button-group size="small">
          <el-button :icon="Plus" title="新建 SQL 文件" @click="onCreate(null, 'file')" />
          <el-button :icon="Folder" title="新建目录" @click="onCreate(null, 'dir')" />
          <el-button :icon="Refresh" title="刷新" @click="reloadMy" />
        </el-button-group>
      </div>
      <el-input
        v-model="mySearch"
        class="tree-search"
        size="small"
        placeholder="搜索脚本/目录…"
        clearable
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div v-loading="myLoading" class="tree-wrap">
        <el-tree
          v-if="myTree.length"
          ref="myTreeRef"
          :data="myTree"
          node-key="id"
          default-expand-all
          draggable
          :allow-drop="allowDrop"
          @node-drop="onNodeDrop"
          class="file-tree"
          :filter-node-method="filterNode"
          @node-click="(d: ScriptNode) => onNodeClick(d)"
        >
          <template #default="{ data }">
            <div class="tree-node" @contextmenu="(e: MouseEvent) => openCtx(e, data as ScriptNode)">
              <el-icon class="node-icon" :class="{ dir: (data as ScriptNode).type === 'dir' }">
                <Folder v-if="(data as ScriptNode).type === 'dir'" />
                <Document v-else />
              </el-icon>
              <span class="node-name" :title="(data as ScriptNode).name">{{ (data as ScriptNode).name }}</span>
            </div>
          </template>
        </el-tree>
        <div v-else-if="!myLoading" class="tree-empty">暂无脚本,点 + 新建 SQL 文件</div>
      </div>
    </div>

    <!-- 表目录 -->
    <div v-show="activeTab === 'catalog'" class="panel-body">
      <div class="panel-toolbar">
        <span class="toolbar-title">表结构(点击表/字段插入)</span>
      </div>
      <el-input
        v-model="catSearch"
        class="tree-search"
        size="small"
        placeholder="搜索库/表/字段…"
        clearable
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div class="tree-wrap">
        <el-tree
          ref="catTreeRef"
          :key="dbsKey"
          :props="{ label: 'name', children: 'children', isLeaf: 'isLeaf' }"
          node-key="id"
          lazy
          :load="lazyLoad"
          class="file-tree cat-tree"
          :filter-node-method="filterNode"
          @node-click="(d: CatNode) => onCatalogClick(d)"
        >
          <template #default="{ data }">
            <div class="tree-node" @dblclick="(e: MouseEvent) => { e.stopPropagation(); onTableDblClick(data as CatNode) }">
              <el-icon class="node-icon cat" :class="{ field: (data as CatNode).kind === 'field' }">
                <Coin v-if="(data as CatNode).kind === 'db'" />
                <Grid v-else-if="(data as CatNode).kind === 'table'" />
                <CaretRight v-else />
              </el-icon>
              <span
                class="node-name"
                :title="(data as CatNode).comment ? `${(data as CatNode).name} — ${(data as CatNode).comment}` : (data as CatNode).name"
              >{{ (data as CatNode).name }}</span>
              <span v-if="(data as CatNode).kind === 'table' && (data as CatNode).comment" class="node-comment" :title="(data as CatNode).comment">
                {{ (data as CatNode).comment }}
              </span>
              <span v-if="(data as CatNode).typeName" class="field-type" :title="(data as CatNode).comment ? `${(data as CatNode).typeName} — ${(data as CatNode).comment}` : (data as CatNode).typeName">
                {{ (data as CatNode).typeName }}
              </span>
              <span v-if="(data as CatNode).kind === 'table'" class="copy-btn" title="复制建表语句" @click.stop="onCopyDDL(data as CatNode)">
                <CopyDocument />
              </span>
              <span v-if="(data as CatNode).kind === 'table'" class="copy-btn" title="复制表名到画布" @click.stop="onCopyTable(data as CatNode)">
                <Plus />
              </span>
            </div>
          </template>
        </el-tree>
      </div>
    </div>

    <!-- 历史 / 收藏 -->
    <div v-show="activeTab === 'history'" class="panel-body">
      <div class="panel-toolbar">
        <span class="toolbar-title">查询历史</span>
        <el-button
          v-if="historyList.length"
          text
          type="primary"
          size="small"
          class="clear-history-btn"
          @click="clearHistory"
        >清空历史</el-button>
      </div>
      <div class="tree-wrap">
        <template v-if="favList.length || historyList.length">
          <div v-if="favList.length" class="hist-group">
            <div class="hist-group-title">收藏</div>
            <div v-for="it in favList" :key="`fav:${it.ts}:${it.sql}`" class="hist-item" @click="onRunItem(it)">
              <span class="hist-sql" :title="it.sql">{{ it.sql }}</span>
              <span class="hist-time">
                <span v-if="it.result" class="hist-cached" title="已缓存查询结果,点击直接查看">结果</span>
                {{ formatTime(it.ts) }}
              </span>
              <span class="hist-ops">
                <el-icon class="starred" title="取消收藏" @click.stop="removeFav(it)"><StarFilled /></el-icon>
              </span>
            </div>
          </div>
          <div v-if="historyList.length" class="hist-group">
            <div class="hist-group-title">最近</div>
            <div v-for="it in historyList" :key="`hist:${it.ts}:${it.sql}`" class="hist-item" @click="onRunItem(it)">
              <span class="hist-sql" :title="it.sql">{{ it.sql }}</span>
              <span class="hist-time">
                <span v-if="it.result" class="hist-cached" title="已缓存查询结果,点击直接查看">结果</span>
                {{ formatTime(it.ts) }}
              </span>
              <span class="hist-ops">
                <el-icon title="收藏" @click.stop="toggleFav(it)"><Star /></el-icon>
                <el-icon class="danger" title="删除" @click.stop="removeHistory(it)"><Delete /></el-icon>
              </span>
            </div>
          </div>
        </template>
        <div v-else class="tree-empty">暂无历史,执行过的 SQL 会出现在这里</div>
      </div>
    </div>
  </div>

  <!-- 右键菜单(我的目录):完整菜单全员可用;共享节点额外有「复制到我的文件夹」 -->
  <div
    v-if="ctx.show && ctx.node"
    class="ctx-menu"
    :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
    @click.stop
    @contextmenu.prevent
  >
    <template v-if="ctx.node.type === 'dir'">
      <div class="ctx-item" @click="menuCreate('file')">新建 SQL 文件</div>
      <div class="ctx-item" @click="menuCreate('dir')">新建目录</div>
      <div class="ctx-divider" />
    </template>
    <div class="ctx-item" @click="menuRename">重命名</div>
    <div class="ctx-item danger" @click="menuDelete">删除</div>
    <template v-if="isShared(ctx.node)">
      <div class="ctx-divider" />
      <div class="ctx-item" @click="menuCopyToMy">复制到我的文件夹</div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.sql-tree-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-right: 1px solid $border;
  background: var(--bd-panel-sub, #fafbfc);
  overflow: hidden;
}

.panel-tabs {
  display: flex;
  border-bottom: 1px solid $border;
  flex-shrink: 0;

  .ptab {
    flex: 1;
    padding: 8px 0;
    text-align: center;
    font-size: 14px;
    color: $muted;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    user-select: none;

    &.active {
      color: $primary;
      border-bottom-color: $primary;
      font-weight: 600;
    }
  }
}

.panel-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid $border;
  flex-shrink: 0;

  .toolbar-title {
    font-size: 14px;
    font-weight: 600;
    color: $text;
  }

  .cat-db {
    width: 100%;
  }
}

.tree-wrap {
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.tree-search {
  margin: 6px 8px 0;
  flex-shrink: 0;
}

.tree-empty {
  padding: 16px 8px;
  font-size: 14px;
  color: $muted;
  text-align: center;
}

/* ── 历史 / 收藏 ───────────────────────────────────────── */
.clear-history-btn {
  padding: 0;
}

.hist-group {
  padding: 2px 0 6px;
}

.hist-group-title {
  padding: 8px 8px 4px;
  font-size: 12px;
  color: $muted;
  user-select: none;
}

.hist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: var(--bd-table-hover);
  }

  .hist-sql {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    color: $text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist-time {
    flex-shrink: 0;
    font-size: 12px;
    color: $muted;
  }

  .hist-cached {
    font-size: 11px;
    padding: 0 4px;
    margin-right: 3px;
    border-radius: 3px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9, rgba(64, 158, 255, 0.12));
  }

  .hist-ops {
    display: none;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;

    :deep(.el-icon) {
      font-size: 14px;
      color: $muted;
      cursor: pointer;

      &:hover {
        color: $primary;
      }

      &.starred {
        color: #e6a23c;

        &:hover {
          color: #d08c1d;
        }
      }

      &.danger:hover {
        color: #f56c6c;
      }
    }
  }

  &:hover .hist-ops {
    display: inline-flex;
  }
}

.file-tree {
  background: transparent;

  :deep(.el-tree-node__content) {
    height: 30px;
    border-radius: 4px;

    &:hover {
      background: var(--bd-table-hover);
    }
  }

  :deep(.el-tree-node__expand-icon) {
    color: $muted;
  }
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  padding-right: 4px;

  .node-icon {
    color: #e6a23c;
    flex-shrink: 0;

    &.dir {
      color: #e6a23c;
    }

    &.cat {
      color: #5e6ad2;

      &.field {
        color: $muted;
        transform: rotate(90deg);
      }
    }
  }

  .node-name {
    font-size: 14px;
    color: $text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .field-type {
    font-size: 12px;
    color: $muted;
    flex-shrink: 0;
  }

  .node-comment {
    font-size: 12px;
    color: $muted;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
    flex-shrink: 1;
  }

  .copy-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    background: #5e6ad2;
    color: #fff;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
    line-height: 1;

    &:hover {
      background: #4752b8;
    }
  }

  &:hover .copy-btn {
    display: inline-flex;
  }
}

/* ── 右键菜单 ───────────────────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 140px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 4px;
  font-size: 13px;
  user-select: none;
}

.ctx-item {
  padding: 7px 12px;
  border-radius: 4px;
  color: $text;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--bd-table-hover);
    color: $primary;
  }

  &.danger:hover {
    color: #f56c6c;
  }
}

.ctx-divider {
  height: 1px;
  background: $border;
  margin: 4px 8px;
}
</style>
