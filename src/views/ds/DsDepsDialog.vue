<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  fetchWorkflowTree,
  rerunCascade,
  type WorkflowTree,
  type DepNode,
  type CascadeNode
} from '@/api/dsDeps'
import DepBranch from './DepBranch.vue'

defineOptions({ name: 'DsDepsDialog' })

const props = defineProps<{
  modelValue: boolean
  // 当前工作流信息
  processId: number
  processName: string
  projectName: string
  // 当前实例(用于级联重跑)
  instanceId?: number
  instanceName?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'jump', node: DepNode): void
}>()

const tree = ref<WorkflowTree | null>(null)
const loading = ref(false)
const error = ref('')
// 勾选重跑的节点(递归收集下游)
const checked = ref<Set<string>>(new Set())
const currentKey = ref('')

/** 递归收集下游节点 */
function collectDownstream(nodes: DepNode[] | undefined): DepNode[] {
  const out: DepNode[] = []
  for (const n of nodes || []) {
    out.push(n)
    out.push(...collectDownstream(n.downstream))
  }
  return out
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    tree.value = await fetchWorkflowTree(props.processId)
    currentKey.value = String(props.processId)
    // 默认勾选:当前 + 所有下游(上游不重跑)
    const downs = collectDownstream(tree.value?.downstream)
    checked.value = new Set([currentKey.value, ...downs.map((n) => String(n.processId))])
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function toggle(processId: number) {
  const k = String(processId)
  const s = new Set(checked.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  checked.value = s
}

/** 点击节点卡片 → 关闭弹窗并跳转到任务监控对应工作流实例 */
function onJump(node: DepNode) {
  emit('update:modelValue', false)
  emit('jump', node)
}

/** 级联重跑:勾选的节点,有实例重跑/无实例后端自动新建 */
interface RerunDisplayItem {
  ok: boolean
  msg: string
  projectName: string
  processName: string
  instanceId?: number
  newInstance?: boolean
}
const rerunResult = ref<RerunDisplayItem[]>([])
const rerunResultVisible = ref(false)

async function doRerun() {
  if (!props.instanceId && !checked.value.has(currentKey.value)) {
    ElMessage.warning('缺少当前实例')
    return
  }
  const nodes: CascadeNode[] = []
  if (checked.value.has(currentKey.value)) {
    nodes.push({ projectName: props.projectName, processId: props.processId, processName: props.processName, instanceId: props.instanceId })
  }
  for (const n of collectDownstream(tree.value?.downstream)) {
    if (checked.value.has(String(n.processId))) {
      nodes.push({ projectName: n.projectName, processId: n.processId, processName: n.processName, instanceId: n.instance?.instanceId })
    }
  }
  if (!nodes.length) {
    ElMessage.warning('未勾选可重跑节点')
    return
  }
  try {
    const results = await rerunCascade(nodes)
    // 结果与 nodes 顺序一一对应,合并项目名标记(项目-工作流)
    rerunResult.value = results.map((r, i) => ({
      ok: r.ok,
      msg: r.msg,
      projectName: nodes[i]?.projectName || '',
      processName: r.name || nodes[i]?.processName || '',
      instanceId: r.instanceId,
      newInstance: r.newInstance
    }))
    rerunResultVisible.value = true
    const ok = results.filter((r) => r.ok).length
    const fail = results.length - ok
    if (fail) ElMessage.warning(`${fail} 个工作流执行失败,详见结果列表`)
  } catch (e) {
    ElMessage.error(`重跑失败:${e instanceof Error ? e.message : e}`)
  }
}

onMounted(() => {
  if (props.modelValue) load()
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="工作流依赖与级联重跑"
    width="94vw"
    top="4vh"
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading" class="deps-body">
      <div v-if="error" class="deps-error">{{ error }}</div>
      <!-- 横向思维导图:上游(左) + 当前(中) + 下游(右) -->
      <template v-if="tree">
        <div class="mindmap">
          <!-- 上游分支(向左) -->
          <DepBranch
            v-if="tree.upstream?.length"
            :nodes="tree.upstream"
            direction="left"
            :current-key="currentKey"
            :checked="checked"
            @toggle="toggle"
            @jump="onJump"
          />
          <!-- 当前节点 -->
          <div class="node-card current">
            <div class="card-head">
              <span class="node-name cur">★ {{ processName }}</span>
              <span class="tag cur">当前</span>
            </div>
            <div class="card-sub">
              <span class="proj">{{ projectName }}</span>
            </div>
          </div>
          <!-- 下游分支(向右) -->
          <DepBranch
            v-if="tree.downstream?.length"
            :nodes="tree.downstream"
            direction="right"
            :current-key="currentKey"
            :checked="checked"
            @toggle="toggle"
            @jump="onJump"
          />
        </div>
        <div v-if="!tree.upstream?.length && !tree.downstream?.length" class="dep-empty">该工作流无上下游依赖</div>
      </template>
      <div v-else-if="!loading" class="dep-empty">暂无依赖数据(联系运维在服务器执行全量刷新)</div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button v-if="instanceId" type="primary" :disabled="!checked.size" @click="doRerun">
        级联重跑({{ checked.size }})
      </el-button>
    </template>
  </el-dialog>

  <!-- 级联重跑结果弹窗:列出每个被执行的工作流(项目-工作流) -->
  <el-dialog v-model="rerunResultVisible" title="级联重跑结果" width="680px">
    <el-table :data="rerunResult" border size="small" max-height="420">
      <el-table-column type="index" label="#" width="50" align="center" />
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '已执行' : '失败' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="项目" prop="projectName" min-width="120" show-overflow-tooltip />
      <el-table-column label="工作流" prop="processName" min-width="180" show-overflow-tooltip />
      <el-table-column label="实例ID" width="110">
        <template #default="{ row }">
          <span>{{ row.instanceId || (row.newInstance ? '新建' : '—') }}</span>
        </template>
      </el-table-column>
      <el-table-column label="信息" prop="msg" min-width="120" show-overflow-tooltip />
    </el-table>
    <template #footer>
      <el-button @click="rerunResultVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.deps-body {
  max-height: 60vh;
  overflow: auto;
}

/* 横向思维导图:flex row,居中对齐 */
.mindmap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: max-content;
  padding: 12px 4px;
}

/* 当前节点样式(与 DepBranch 卡片一致) */
.node-card {
  min-width: 150px;
  max-width: 180px;
  padding: 8px 10px;
  border: 1px solid $border;
  border-radius: 8px;
  background: $panel;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
  flex-shrink: 0;

  &.current {
    border-color: $primary;
    border-width: 2px;
    box-shadow: 0 2px 10px rgba(94, 106, 210, 0.25);
  }
}

.card-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.node-name {
  font-size: 12px;
  color: $text;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;

  &.cur {
    color: $primary;
    font-weight: 700;
  }
}

.tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 3px;
  flex-shrink: 0;

  &.cur {
    background: rgba(94, 106, 210, 0.12);
    color: $primary;
  }
}

.card-sub {
  display: flex;
  align-items: center;
  gap: 6px;
}

.proj {
  font-size: 10px;
  color: $muted;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deps-error {
  color: #f56c6c;
  padding: 8px;
}

.dep-section-title {
  font-size: 13px;
  font-weight: 600;
  color: $muted;
  margin: 8px 0 4px;
}

.dep-empty {
  color: $muted;
  font-size: 12px;
  padding: 8px;
}

.dep-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  margin: 2px 0;

  &:hover {
    background: rgba(94, 106, 210, 0.06);
  }
}

.dep-name {
  font-size: 13px;
  color: $text;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dep-current {
  font-weight: 700;
  color: $primary;
}

.dep-proj {
  font-size: 11px;
  color: $muted;
  flex-shrink: 0;
}

.dep-inst {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  background: $bg;
  color: $muted;

  &.inst-fail {
    color: #f56c6c;
    background: rgba(245, 108, 108, 0.1);
  }

  &.inst-ok {
    color: #67c23a;
    background: rgba(103, 194, 58, 0.1);
  }

  &.inst-run {
    color: $primary;
    background: rgba(94, 106, 210, 0.1);
  }
}

.dep-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;

  &.current,
  &.down {
    background: rgba(94, 106, 210, 0.12);
    color: $primary;
  }

  &.up {
    background: rgba(245, 108, 108, 0.1);
    color: #f56c6c;
  }
}
</style>
