<template>
  <div class="cron-setter">
    <div class="cron-row">
      <el-select v-model="mode" size="small" class="cron-mode">
        <el-option label="每天" value="daily" />
        <el-option label="每周" value="weekly" />
        <el-option label="每月" value="monthly" />
        <el-option label="自定义" value="custom" />
      </el-select>

      <template v-if="mode !== 'custom'">
        <el-time-select
          v-model="time"
          size="small"
          start="00:00"
          step="00:30"
          end="23:30"
          placeholder="时间"
          class="cron-time"
        />
      </template>

      <template v-if="mode === 'weekly'">
        <el-checkbox-group v-model="dows" size="small" class="cron-dows">
          <el-checkbox-button v-for="(d, i) in WEEK" :key="i" :value="i">{{ d }}</el-checkbox-button>
        </el-checkbox-group>
      </template>

      <template v-if="mode === 'monthly'">
        <el-input-number v-model="dom" :min="1" :max="31" size="small" class="cron-dom" />
        <span class="cron-unit">日</span>
      </template>

      <template v-if="mode === 'custom'">
        <el-input v-model="custom" size="small" placeholder="5 字段,如 0 3 * * *" class="cron-custom" />
      </template>
    </div>
    <div class="cron-desc">
      <template v-if="desc"><el-icon class="desc-icon"><Clock /></el-icon>{{ desc }}</template>
      <span v-else class="desc-empty">未设置调度(仅手动执行)</span>
      <span v-if="mode !== 'custom' && desc" class="cron-raw">{{ cronText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Clock } from '@element-plus/icons-vue'

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
type Mode = 'daily' | 'weekly' | 'monthly' | 'custom'

const mode = ref<Mode>('daily')
const time = ref('03:00')
const dows = ref<number[]>([])
const dom = ref(1)
const custom = ref('')

/** 解析已有 cron 回填模式 */
function parseCron(cron: string): void {
  const parts = String(cron || '').trim().split(/\s+/)
  if (parts.length !== 5) return
  const [min, hour, d, m, w] = parts
  const validTime = /^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour)
  if (validTime) time.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (d === '*' && m === '*' && w === '*') mode.value = 'daily'
  else if (d === '*' && m === '*' && w !== '*') {
    mode.value = 'weekly'
    dows.value = w.split(',').map(Number).filter((x) => x >= 0 && x <= 6)
  } else if (d !== '*' && m === '*' && w === '*') {
    mode.value = 'monthly'
    const dv = parseInt(d, 10)
    if (dv >= 1 && dv <= 31) dom.value = dv
  } else {
    mode.value = 'custom'
    custom.value = String(cron || '')
  }
}

/** 生成 5 字段 cron */
function buildCron(): string {
  if (mode.value === 'custom') return custom.value.trim()
  const [h, m] = (time.value || '03:00').split(':')
  if (mode.value === 'daily') return `${m} ${h} * * *`
  if (mode.value === 'weekly') return dows.value.length ? `${m} ${h} * * ${dows.value.sort((a, b) => a - b).join(',')}` : ''
  return `${m} ${h} ${dom.value} * *`
}

/** 人类可读描述 */
const desc = computed(() => {
  if (mode.value === 'custom') return custom.value.trim() ? `自定义: ${custom.value.trim()}` : ''
  const t = time.value || '--:--'
  if (mode.value === 'daily') return `每天 ${t} 执行`
  if (mode.value === 'weekly') {
    if (!dows.value.length) return ''
    const names = dows.value.sort((a, b) => a - b).map((i) => `周${WEEK[i]}`).join('、')
    return `每周 ${names} ${t} 执行`
  }
  if (mode.value === 'monthly') return `每月 ${dom.value} 日 ${t} 执行`
  return ''
})

const cronText = computed(() => (mode.value === 'custom' ? '' : buildCron()))

watch([mode, time, dows, dom, custom], () => {
  const c = buildCron()
  emit('update:modelValue', c)
})

watch(
  () => props.modelValue,
  (v) => parseCron(v || ''),
  { immediate: true }
)
</script>

<style scoped lang="scss">
.cron-setter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cron-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  .cron-mode {
    width: 90px;
  }

  .cron-time {
    width: 120px;
  }

  .cron-dom {
    width: 90px;
  }

  .cron-unit {
    font-size: 12px;
    color: var(--bd-muted, #888);
  }

  .cron-custom {
    width: 200px;
  }
}

.cron-desc {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--bd-text, #1c2b36);

  .desc-icon {
    color: var(--bd-primary, #00849c);
  }

  .desc-empty {
    color: var(--bd-muted, #888);
  }

  .cron-raw {
    margin-left: auto;
    font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
    font-size: 11px;
    color: var(--bd-muted, #888);
  }
}
</style>
