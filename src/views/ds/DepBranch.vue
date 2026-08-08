<script setup lang="ts">
import type { DepNode } from '@/api/dsDeps'

defineOptions({ name: 'DepBranch' })

// 递归横向分支:direction=left 往左展开上游,right 往右展开下游
// 支持并行:一个节点多个子节点垂直堆叠,经汇聚线分叉
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

function crontabText(n: DepNode): string {
  return n.crontab ? `cron ${n.crontab.trim()}` : ''
}
</script>

<template>
  <!-- 一层节点:垂直堆叠 -->
  <div class="dep-branch" :class="direction">
    <div v-for="n in nodes" :key="n.processId" class="branch-node">
      <!-- 上游:子节点在左,递归展开 -->
      <div v-if="direction === 'left' && n.upstream?.length" class="children-col left">
        <div class="vert-line" />
        <div class="children">
          <div class="child-item" v-for="ch in n.upstream" :key="ch.processId">
            <div class="hor-line left" />
            <DepBranch
              :nodes="[ch]"
              direction="left"
              :current-key="currentKey"
              :checked="checked"
              @toggle="emit('toggle', $event)"
              @jump="emit('jump', $event)"
            />
          </div>
        </div>
      </div>

      <!-- 节点卡片 -->
      <div
        class="node-card"
        :class="{ current: isCurrent(n), inst: instStateCls(n.instance?.state) }"
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
        <div v-if="crontabText(n)" class="card-cron">{{ crontabText(n) }}</div>
        <!-- 勾选(仅下游可勾选重跑) -->
        <el-checkbox
          v-if="direction === 'right' && !isCurrent(n)"
          :model-value="checked.has(String(n.processId))"
          size="small"
          @click.stop
          @change="emit('toggle', n.processId)"
        >重跑</el-checkbox>
      </div>

      <!-- 下游:子节点在右,垂直堆叠分叉 -->
      <div v-if="direction === 'right' && n.downstream?.length" class="children-col right">
        <div class="vert-line" />
        <div class="children">
          <div class="child-item" v-for="ch in n.downstream" :key="ch.processId">
            <div class="hor-line right" />
            <DepBranch
              :nodes="[ch]"
              direction="right"
              :current-key="currentKey"
              :checked="checked"
              @toggle="emit('toggle', $event)"
              @jump="emit('jump', $event)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 一层多个节点:垂直堆叠 */
.dep-branch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.branch-node {
  display: flex;
  align-items: center;
  gap: 0;
}

/* 子节点列(右侧下游/左侧上游) */
.children-col {
  display: flex;
  align-items: center;

  &.right {
    flex-direction: row;
  }

  &.left {
    flex-direction: row-reverse;
  }
}

/* 父到子:竖直干线 */
.vert-line {
  width: 2px;
  height: 100%;
  min-height: 12px;
  background: #c9cdd6;
  align-self: stretch;
}

.children {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.child-item {
  display: flex;
  align-items: center;
}

/* 父到子的水平线 */
.hor-line {
  width: 20px;
  height: 2px;
  background: #c9cdd6;

  &.left {
    margin-right: 0;
  }

  &.right {
    margin-left: 0;
  }
}

.node-card {
  min-width: 170px;
  max-width: 200px;
  padding: 10px 12px;
  /* 统一为当前节点样式:主题色粗边框 */
  border: 2px solid $primary;
  border-radius: 10px;
  background: $panel;
  display: flex;
  flex-direction: column;
  gap: 5px;
  box-shadow: 0 1px 4px rgba(94, 106, 210, 0.15);
  flex-shrink: 0;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;

  &:hover {
    box-shadow: 0 2px 10px rgba(94, 106, 210, 0.25);
  }

  &.current {
    border-width: 2px;
    box-shadow: 0 2px 12px rgba(94, 106, 210, 0.3);
    cursor: default;
    background: rgba(94, 106, 210, 0.04);
  }

  /* 状态色左边框:失败红/成功绿/运行蓝 */
  &.inst.inst-fail {
    border-left: 4px solid #f56c6c;
  }
  &.inst.inst-ok {
    border-left: 4px solid #67c23a;
  }
  &.inst.inst-run {
    border-left: 4px solid $primary;
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
  background: rgba(94, 106, 210, 0.1);
  color: $primary;

  &.cur {
    background: rgba(94, 106, 210, 0.15);
    color: $primary;
    font-weight: 600;
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

.card-cron {
  font-size: 10px;
  color: #c0c4cc;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
