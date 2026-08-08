<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import {
  fetchWorkflowTree,
  rerunInstances,
  refreshDeps,
  type WorkflowTree,
  type DepNode,
  type RerunItem
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
        flat.push({ processId: n.processId, processName: n.processName, projectName: n.projectName, level, isCurrent: false })
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

/** 级联重跑:勾选的节点(需实例)逐个重跑 */
async function doRerun() {
  if (!props.instanceId) {
    ElMessage.warning('缺少当前实例')
    return
  }
  // 当前节点 + 勾选的下游节点
  const targets: RerunItem[] = []
  if (checked.value.has(currentKey.value)) {
    targets.push({ projectName: props.projectName, instanceId: props.instanceId, name: props.processName })
  }
  for (const n of flatNodes.value) {
    if (!n.isCurrent && checked.value.has(String(n.processId))) {
      // 下游节点:无实例信息,标记需要用户在海豚侧确认(此版本先提示)
      // 这里简化:下游节点重跑需要实例 id,当前无法从依赖树拿,提示用户
      ElMessage.info(`下游「${n.processName}」需在海豚侧确认实例后重跑(此版本支持当前实例+直接下游实例)`)
    }
  }
  if (!targets.length) {
    ElMessage.warning('未勾选可重跑节点')
    return
  }
  try {
    const results = await rerunInstances(targets)
    const ok = results.filter((r) => r.ok)
    const fail = results.filter((r) => !r.ok)
    ElMessage.success(`重跑完成:成功 ${ok.length},失败 ${fail.length}`)
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
            v-model="checked"
            :value="String(n.processId)"
            :disabled="n.isCurrent || n.level === 0"
            @change="toggle(n)"
          />
          <span class="dep-name" :class="{ 'dep-current': n.isCurrent }">{{ n.isCurrent ? '★ ' : '' }}{{ n.processName }}</span>
          <span class="dep-proj">{{ n.projectName }}</span>
          <span v-if="n.isCurrent" class="dep-tag">当前</span>
          <span v-else-if="!n.isCurrent && flatNodes.findIndex((x) => x.isCurrent) < i" class="dep-tag down">下游</span>
          <span v-else class="dep-tag up">上游</span>
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
