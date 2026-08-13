<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Folder, Document, Plus, Refresh, CaretRight, Coin, Grid, Search } from '@element-plus/icons-vue'
import {
  listScriptTree,
  createScriptNode,
  renameScriptNode,
  deleteScriptNode,
  moveScriptNode,
  listTables,
  listFields,
  type ScriptNode,
  type DbDataSource,
  type TableField
} from '@/api/db'

defineOptions({ name: 'SqlTreePanel' })

const props = defineProps<{ dbs: DbDataSource[] }>()
const emit = defineEmits<{
  (e: 'open', node: ScriptNode): void
  (e: 'insert', text: string): void
}>()

const activeTab = ref<'my' | 'catalog'>('my')

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

// ── 我的目录 ─────────────────────────────────────────────────
const myTree = ref<ScriptNode[]>([])
const myLoading = ref(false)

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

/** 节点点击:文件打开;目录展开/折叠由 el-tree 默认行为处理 */
function onNodeClick(data: ScriptNode) {
  if (data.type === 'file') emit('open', data)
}

/** 新建(根级或目录内) */
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
      const tables = await listTables(data.db || '')
      resolve(
        tables.map((t) => ({
          id: `t:${t}`,
          name: t,
          kind: 'table' as const,
          isLeaf: false,
          db: data.db,
          table: t
        }))
      )
    } else if (data.kind === 'table') {
      const fields: TableField[] = await listFields(data.db || '', data.table || data.name)
      resolve(
        fields.map((f) => ({
          id: `f:${data.table}:${f.name}`,
          name: f.name,
          kind: 'field' as const,
          isLeaf: true,
          db: data.db,
          table: data.table,
          typeName: f.type
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

/** 点击表/字段:字段插入;表仅展开(复制需点按钮) */
function onCatalogClick(data: CatNode) {
  if (data.kind === 'db' || data.kind === 'table') return // 库/表仅展开
  emit('insert', data.name) // 字段:保持点击插入
}

/** 复制表名到画布(点复制按钮) */
function onCopyTable(data: CatNode) {
  emit('insert', data.table || data.name)
  ElMessage.success(`已插入 ${data.table || data.name}`)
}

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
  // 超出视口右/下边缘时翻转
  const menuW = 150
  const menuH = node.type === 'dir' ? 150 : 80
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

// ── 拖拽移动(仅允许拖入目录内)──────────────────────────────
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
            <div class="tree-node">
              <el-icon class="node-icon cat" :class="{ field: (data as CatNode).kind === 'field' }">
                <Coin v-if="(data as CatNode).kind === 'db'" />
                <Grid v-else-if="(data as CatNode).kind === 'table'" />
                <CaretRight v-else />
              </el-icon>
              <span class="node-name" :title="(data as CatNode).name">{{ (data as CatNode).name }}</span>
              <span v-if="(data as CatNode).kind === 'table'" class="copy-btn" title="复制表名到画布" @click.stop="onCopyTable(data as CatNode)">
                <Plus />
              </span>
              <span v-if="(data as CatNode).typeName" class="field-type">{{ (data as CatNode).typeName }}</span>
            </div>
          </template>
        </el-tree>
      </div>
    </div>
  </div>

  <!-- 右键菜单(我的目录) -->
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
