<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Folder, Document, Plus, Refresh, CaretRight, Download, Coin, Grid } from '@element-plus/icons-vue'
import {
  listScriptTree,
  createScriptNode,
  renameScriptNode,
  deleteScriptNode,
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

onMounted(reloadMy)
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
      <div v-loading="myLoading" class="tree-wrap">
        <el-tree
          v-if="myTree.length"
          :data="myTree"
          node-key="id"
          default-expand-all
          class="file-tree"
          @node-click="(d: ScriptNode) => onNodeClick(d)"
        >
          <template #default="{ data }">
            <div class="tree-node">
              <el-icon class="node-icon" :class="{ dir: (data as ScriptNode).type === 'dir' }">
                <Folder v-if="(data as ScriptNode).type === 'dir'" />
                <Document v-else />
              </el-icon>
              <span class="node-name" :title="(data as ScriptNode).name">{{ (data as ScriptNode).name }}</span>
              <span class="node-ops" @click.stop>
                <el-icon v-if="(data as ScriptNode).type === 'dir'" class="op" title="新建子文件" @click="onCreate(data as ScriptNode, 'file')"><Plus /></el-icon>
                <el-icon v-if="(data as ScriptNode).type === 'dir'" class="op" title="新建子目录" @click="onCreate(data as ScriptNode, 'dir')"><Folder /></el-icon>
                <el-icon class="op" title="重命名" @click="onRename(data as ScriptNode)"><CaretRight class="rot" /></el-icon>
                <el-icon class="op danger" title="删除" @click="onDelete(data as ScriptNode)"><Download class="rot45" /></el-icon>
              </span>
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
      <div class="tree-wrap">
        <el-tree
          :key="dbsKey"
          :props="{ label: 'name', children: 'children', isLeaf: 'isLeaf' }"
          node-key="id"
          lazy
          :load="lazyLoad"
          class="file-tree cat-tree"
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
    color: #606266;
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
      background: #eef1f6;
    }
  }

  :deep(.el-tree-node__expand-icon) {
    color: #909399;
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
        color: #909399;
        transform: rotate(90deg);
      }
    }
  }

  .node-name {
    font-size: 14px;
    color: #333;
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

  .node-ops {
    display: none;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;

    .op {
      font-size: 15px;
      color: #909399;
      cursor: pointer;
      padding: 3px;
      border-radius: 4px;

      &:hover {
        color: $primary;
        background: rgba(94, 106, 210, 0.08);
      }

      &.danger:hover {
        color: #f56c6c;
        background: rgba(245, 108, 108, 0.08);
      }

      &.rot {
        transform: rotate(90deg);
      }

      &.rot45 {
        transform: rotate(45deg);
      }
    }
  }

  &:hover .node-ops {
    display: inline-flex;
  }
}
</style>
