<script setup lang="ts">
// EXPLAIN 执行计划面板(自 QueryView.vue 拆出,2026-08):
// 纯展示组件 —— 树形(MySQL EXPLAIN ANALYZE / FORMAT=TREE)或表格(普通 EXPLAIN 行)二选一渲染。
// 数据获取留在父组件(runExplain 依赖当前引擎/SQL),这里只接收结果。
import { type ExplainNode } from '@/api/db'

defineProps<{
  modelValue: boolean
  loading: boolean
  error: string
  tree: ExplainNode | null
  table: { columns: string[]; rows: Record<string, unknown>[] } | null
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

/** 树节点标签(与拆解前 QueryView 内联实现语义一致,含 filtered 统计) */
function explainNodeLabel(n: ExplainNode | null | undefined): string {
  if (!n) return '(空节点)'
  const parts = [
    n.operation,
    n.name || n.object_name,
    n.access_type ? `[${n.access_type}]` : '',
    n.rows != null && n.rows !== '' ? `rows=${n.rows}` : '',
    n.filtered != null && n.filtered !== '' ? `filtered=${n.filtered}` : '',
    n.cost != null && n.cost !== '' ? `cost=${n.cost}` : '',
    n.extra
  ].filter(Boolean)
  return parts.join(' ')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="EXPLAIN 执行计划"
    width="720px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-loading="loading" class="explain-body">
      <el-alert v-if="error" type="error" :title="error" show-icon :closable="false" class="explain-error" />
      <template v-else-if="tree">
        <el-tree
          :data="[tree]"
          :props="{ label: 'operation', children: 'children' }"
          default-expand-all
          :expand-on-click-node="false"
          class="explain-tree"
        >
          <template #default="{ data }">
            <span class="explain-node">{{ explainNodeLabel(data) }}</span>
          </template>
        </el-tree>
      </template>
      <template v-else-if="table">
        <el-table :data="table.rows" border size="small" max-height="420" class="explain-table">
          <el-table-column v-for="c in table.columns" :key="c" :prop="c" :label="c" min-width="140" />
        </el-table>
      </template>
      <el-empty v-else-if="!loading" description="暂无执行计划" />
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.explain-body {
  max-height: 520px;
  overflow: auto;
}

.explain-error {
  margin-bottom: 0;
}

.explain-tree {
  font-size: 12px;

  :deep(.el-tree-node__content) {
    height: auto;
    min-height: 28px;
    padding: 2px 0;
  }
}

.explain-node {
  display: inline-block;
  padding: 2px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.explain-table {
  width: 100%;
}
</style>
