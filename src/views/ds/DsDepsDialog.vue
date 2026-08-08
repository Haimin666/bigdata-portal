<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  fetchWorkflowTree,
  rerunCascade,
  refreshDeps,
  type WorkflowTree,
  type DepNode,
  type CascadeNode
} from '@/api/dsDeps'

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
}>()

const tree = ref<WorkflowTree | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const error = ref('')
// 勾选重跑的节点(递归收集)
const checked = ref<Set<string>>(new Set())

// 把树拍平成带路径的节点列表(用于勾选)
interface FlatNode {
  processId: number
  processName: string
  projectName: string
  level: number
  isCurrent: boolean
  /** 下游节点的最近实例(有实例才可重跑) */
  instance?: { instanceId: number; name: string; state: string } | null
}
const flatNodes = ref<FlatNode[]>([])
const currentKey = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    tree.value = await fetchWorkflowTree(props.processId)
    currentKey.value = String(props.processId)
    // 拍平:上游(倒序) + 当前 + 下游
    const flat: FlatNode[] = []
    const walkUp = (nodes: DepNode[] | undefined, level: number) => {
      for (const n of nodes || []) {
        walkUp(n.upstream, level + 1)
        flat.push({ processId: n.processId, processName: n.processName, projectName: n.projectName, level, isCurrent: false })
      }
    }
    walkUp(tree.value?.upstream, 1)
    flat.push({
      processId: props.processId,
      processName: props.processName,
      projectName: props.projectName,
      level: 0,
      isCurrent: true
    })
    const walkDown = (nodes: DepNode[] | undefined, level: number) => {
      for (const n of nodes || []) {
        flat.push({ processId: n.processId, processName: n.processName, projectName: n.projectName, level, isCurrent: false, instance: n.instance })
        walkDown(n.downstream, level + 1)
      }
    }
    walkDown(tree.value?.downstream, 1)
    flatNodes.value = flat
    // 默认勾选:当前 + 所有下游(上游不重跑)
    checked.value = new Set([currentKey.value])
    for (const n of flat) {
      if (!n.isCurrent && flat.indexOf(n) >= flat.findIndex((x) => x.isCurrent)) checked.value.add(String(n.processId))
    }
    // 简单方式:勾选当前和所有下游节点
    checked.value = new Set([currentKey.value, ...flat.filter((n) => !n.isCurrent && n.level >= 1).map((n) => String(n.processId))])
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function toggle(node: FlatNode) {
  const k = String(node.processId)
  const s = new Set(checked.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  checked.value = s
}

/** 下游实例状态文本 */
function instStateText(inst: FlatNode['instance']): string {
  if (!inst) return '近1天无实例'
  const map: Record<string, string> = {
    SUCCESS: '成功',
    FAILURE: '失败',
    RUNNING_EXEUTION: '运行中',
    RUNNING_EXECUTION: '运行中',
    PAUSE: '暂停',
    STOP: '停止'
  }
  return map[inst.state] || inst.state
}

function instStateCls(state?: string): string {
  if (state === 'FAILURE') return 'inst-fail'
  if (state === 'SUCCESS') return 'inst-ok'
  if (state === 'RUNNING_EXEUTION' || state === 'RUNNING_EXECUTION') return 'inst-run'
  return ''
}

async function doRefresh() {
  refreshing.value = true
  try {
    await refreshDeps(props.processId)
    ElMessage.success('依赖已刷新')
    await load()
  } catch (e) {
    ElMessage.error(`刷新失败:${e instanceof Error ? e.message : e}`)
  } finally {
    refreshing.value = false
  }
}

/** 级联重跑:勾选的节点,有实例重跑/无实例后端自动新建 */
async function doRerun() {
  if (!props.instanceId && !checked.value.has(currentKey.value)) {
    ElMessage.warning('缺少当前实例')
    return
  }
  // 勾选节点:当前 + 下游(上游不重跑)
  const nodes: CascadeNode[] = []
  if (checked.value.has(currentKey.value)) {
    nodes.push({ projectName: props.projectName, processId: props.processId, processName: props.processName, instanceId: props.instanceId })
  }
  for (const n of flatNodes.value) {
    if (!n.isCurrent && checked.value.has(String(n.processId)) && n.level >= 1) {
      nodes.push({ projectName: n.projectName, processId: n.processId, processName: n.processName, instanceId: n.instance?.instanceId })
    }
  }
  if (!nodes.length) {
    ElMessage.warning('未勾选可重跑节点')
    return
  }
  try {
    const results = await rerunCascade(nodes)
    const ok = results.filter((r) => r.ok)
    const fail = results.filter((r) => !r.ok)
    ElMessage.success(`级联重跑完成:成功 ${ok.length},失败 ${fail.length}`)
    if (fail.length) ElMessage.error(fail.map((f) => `${f.name}:${f.msg}`).join(';'))
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
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
    @open="load"
  >
    <div v-loading="loading" class="deps-body">
      <div v-if="error" class="deps-error">{{ error }}</div>
      <!-- 上游链 -->
      <template v-if="tree">
        <div class="dep-section-title">上游依赖(→ 当前)</div>
        <div v-if="!flatNodes.filter((n) => n.level >= 1 && !n.isCurrent && tree?.downstream?.length === 0).length && flatNodes.filter((n) => n.isCurrent).length === 0" class="dep-empty">无</div>
        <div
          v-for="(n, i) in flatNodes"
          :key="n.processId + '-' + i"
          class="dep-node"
          :class="{ current: n.isCurrent, upstream: !n.isCurrent && flatNodes.findIndex((x) => x.isCurrent) > i }"
          :style="{ marginLeft: n.level * 24 + 'px' }"
        >
          <el-checkbox
            :model-value="checked.has(String(n.processId))"
            :disabled="n.isCurrent || n.level === 0"
            @change="toggle(n)"
          />
          <span class="dep-name" :class="{ 'dep-current': n.isCurrent }">{{ n.isCurrent ? '★ ' : '' }}{{ n.processName }}</span>
          <span class="dep-proj">{{ n.projectName }}</span>
          <span v-if="n.isCurrent" class="dep-tag">当前</span>
          <span v-else-if="!n.isCurrent && flatNodes.findIndex((x) => x.isCurrent) < i" class="dep-tag down">下游</span>
          <span v-else class="dep-tag up">上游</span>
          <!-- 下游节点实例状态 -->
          <span v-if="!n.isCurrent && flatNodes.findIndex((x) => x.isCurrent) < i" class="dep-inst" :class="instStateCls(n.instance?.state)">
            {{ instStateText(n.instance) }}
          </span>
        </div>
      </template>
      <div v-else-if="!loading" class="dep-empty">暂无依赖数据(可点击刷新)</div>
    </div>
    <template #footer>
      <el-button :loading="refreshing" :icon="Refresh" @click="doRefresh">刷新依赖</el-button>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button v-if="instanceId" type="primary" :disabled="!checked.size" @click="doRerun">
        级联重跑({{ checked.size }})
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.deps-body {
  max-height: 60vh;
  overflow: auto;
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
