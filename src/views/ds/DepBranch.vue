<script setup lang="ts">
import type { DepNode } from '@/api/dsDeps'

defineOptions({ name: 'DepBranch' })

// 递归横向分支:direction=left 表示往左展开上游,direction=right 往右展开下游
const props = defineProps<{
  nodes?: DepNode[]
  direction: 'left' | 'right'
  currentKey: string
  checked: Set<string>
}>()

const emit = defineEmits<{
  (e: 'toggle', processId: number): void
  (e: 'jump', node: DepNode): void
}>()

function isCurrent(n: DepNode): boolean {
  return String(n.processId) === props.currentKey
}

function instStateText(n: DepNode): string {
  const inst = n.instance
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
</script>

<template>
  <div class="dep-branch" :class="direction">
    <template v-for="n in nodes" :key="n.processId">
      <!-- 上游分支:继续向左展开 -->
      <div v-if="direction === 'left'" class="branch-col">
        <DepBranch
          v-if="n.upstream?.length"
          :nodes="n.upstream"
          direction="left"
          :current-key="currentKey"
          :checked="checked"
          @toggle="emit('toggle', $event)"
          @jump="emit('jump', $event)"
        />
        <div class="conn-line left" />
      </div>

      <!-- 节点卡片:点击跳转到任务监控实例 -->
      <div
        class="node-card"
        :class="{ current: isCurrent(n) }"
        @click="emit('jump', n)"
      >
        <div class="card-head">
          <span class="node-name" :class="{ cur: isCurrent(n) }">{{ isCurrent(n) ? '★ ' : '' }}{{ n.processName }}</span>
          <span v-if="isCurrent(n)" class="tag cur">当前</span>
          <span v-else-if="direction === 'right'" class="tag down">下游</span>
          <span v-else class="tag up">上游</span>
        </div>
        <div class="card-sub">
          <span class="proj">{{ n.projectName }}</span>
          <span class="inst" :class="instStateCls(n.instance?.state)">{{ instStateText(n) }}</span>
        </div>
        <!-- 勾选(仅下游可勾选重跑),stop 阻止冒泡到卡片跳转 -->
        <el-checkbox
          v-if="direction === 'right' && !isCurrent(n)"
          :model-value="checked.has(String(n.processId))"
          size="small"
          @click.stop
          @change="emit('toggle', n.processId)"
        >重跑</el-checkbox>
      </div>
      <!-- 下游分支:继续向右展开 -->
      <div v-if="direction === 'right'" class="branch-col">
        <div class="conn-line right" />
        <DepBranch
          v-if="n.downstream?.length"
          :nodes="n.downstream"
          direction="right"
          :current-key="currentKey"
          :checked="checked"
          @toggle="emit('toggle', $event)"
          @jump="emit('jump', $event)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.dep-branch {
  display: flex;
  align-items: center;
  gap: 0;

  &.left {
    flex-direction: row-reverse; /* 上游往左 */
  }

  &.right {
    flex-direction: row;
  }
}

.branch-col {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 4px;
}

/* 连接线 */
.conn-line {
  width: 24px;
  height: 2px;
  background: #c9cdd6;

  &.left {
    margin-left: 0;
  }

  &.right {
    margin-right: 0;
  }
}

.node-card {
  min-width: 170px;
  max-width: 200px;
  padding: 10px 12px;
  border: 1px solid #e6e8ec;
  border-radius: 10px;
  background: $panel;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  flex-shrink: 0;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;

  &:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    border-color: $primary;
  }

  &.current {
    border-color: $primary;
    border-width: 2px;
    box-shadow: 0 2px 10px rgba(94, 106, 210, 0.2);
    cursor: default;
  }
}

.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.node-name {
  font-size: 13px;
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
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
  background: $bg;
  color: $muted;

  &.cur {
    background: rgba(94, 106, 210, 0.12);
    color: $primary;
  }
  &.down {
    background: rgba(94, 106, 210, 0.1);
    color: $primary;
  }
  &.up {
    background: rgba(245, 108, 108, 0.1);
    color: #f56c6c;
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

.inst {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  color: $muted;
  background: $bg;
  flex-shrink: 0;

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
</style>
