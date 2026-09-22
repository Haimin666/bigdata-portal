<script setup lang="ts">
import { ref } from 'vue'
import type { DepNode } from '@/api/dsDeps'

defineOptions({ name: 'DepBranch' })

// 递归横向分支:direction=left 往左展开上游,right 往右展开下游
// 思维导图风格:平滑圆角连接线 + 并行节点可折叠
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

// 折叠状态:key=processId
const collapsed = ref<Set<string>>(new Set())

function isCurrent(n: DepNode): boolean {
  return String(n.processId) === props.currentKey
}

function isCollapsed(n: DepNode): boolean {
  return collapsed.value.has(String(n.processId))
}

function toggleCollapse(n: DepNode) {
  const k = String(n.processId)
  const s = new Set(collapsed.value)
  if (s.has(k)) s.delete(k)
  else s.add(k)
  collapsed.value = s
}

function hasChildren(n: DepNode): boolean {
  return props.direction === 'right' ? !!n.downstream?.length : !!n.upstream?.length
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
  <!-- 一层多个节点:垂直堆叠 -->
  <div class="dep-branch" :class="direction">
    <div v-for="n in nodes" :key="n.processId" class="branch-node">
      <!-- 上游子节点(向左) -->
      <div v-if="direction === 'left' && n.upstream?.length" class="children-col left">
        <div class="children" v-show="!isCollapsed(n)">
          <div class="child-item left" v-for="ch in n.upstream" :key="ch.processId">
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
          <!-- 折叠按钮(有子节点时) -->
          <span
            v-if="hasChildren(n)"
            class="fold-btn"
            :class="{ folded: isCollapsed(n) }"
            @click.stop="toggleCollapse(n)"
          >{{ isCollapsed(n) ? '▸' : '▾' }}</span>
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

      <!-- 下游子节点(向右,平滑曲线分叉) -->
      <div v-if="direction === 'right' && n.downstream?.length" class="children-col right">
        <div class="children" v-show="!isCollapsed(n)">
          <div class="child-item right" v-for="ch in n.downstream" :key="ch.processId">
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
  gap: 6px;
}

.branch-node {
  display: flex;
  align-items: center;
  gap: 0;
}

/* 子节点列 */
.children-col {
  display: flex;

  &.right {
    flex-direction: row;
  }

  &.left {
    flex-direction: row-reverse;
  }
}

.children {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 子项:伪元素画平滑圆角连接线(思维导图曲线感) */
.child-item {
  position: relative;
  display: flex;
  align-items: center;

  &.right {
    /* 竖线从主干弯出 + 圆角过渡到卡片 */
    &::before {
      content: '';
      position: absolute;
      right: 100%;
      top: -50%;
      width: 18px;
      height: 50%;
      border-left: 2px solid $border;
      border-bottom: 2px solid $border;
      border-bottom-left-radius: 10px;
    }
  }

  &.left {
    &::before {
      content: '';
      position: absolute;
      left: 100%;
      top: -50%;
      width: 18px;
      height: 50%;
      border-right: 2px solid $border;
      border-bottom: 2px solid $border;
      border-bottom-right-radius: 10px;
    }
  }
}

.node-card {
  min-width: 150px;
  max-width: 180px;
  padding: 7px 10px;
  border: 1px solid $border;
  border-radius: 8px;
  background: $panel;
  display: flex;
  flex-direction: column;
  gap: 3px;
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
    box-shadow: 0 2px 10px rgba(0, 229, 255, 0.18);
    cursor: default;
    background: color-mix(in srgb, $primary 5%, transparent);
  }

  /* 状态色左边框 */
  &.inst.inst-fail {
    border-left: 3px solid #f56c6c;
  }
  &.inst.inst-ok {
    border-left: 3px solid #67c23a;
  }
  &.inst.inst-run {
    border-left: 3px solid $primary;
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

.fold-btn {
  font-size: 10px;
  color: $muted;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0 2px;
  border-radius: 3px;

  &:hover {
    color: $primary;
    background: color-mix(in srgb, $primary 10%, transparent);
  }
}

.tag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 4px;
  flex-shrink: 0;
  background: color-mix(in srgb, $primary 10%, transparent);
  color: $primary;

  &.cur {
    background: color-mix(in srgb, $primary 15%, transparent);
    color: $primary;
    font-weight: 600;
  }
  &.down {
    background: color-mix(in srgb, $primary 10%, transparent);
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
  gap: 5px;
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
    background: color-mix(in srgb, $primary 10%, transparent);
  }
}

.card-cron {
  font-size: 10px;
  color: $muted;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
