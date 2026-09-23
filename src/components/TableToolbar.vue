<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'

defineOptions({ name: 'TableToolbar' })

type TableDensity = 'large' | 'default' | 'small'

const props = withDefaults(
  defineProps<{
    loading?: boolean
    density?: TableDensity
    storageKey?: string
    showDensity?: boolean
    showRefresh?: boolean
  }>(),
  {
    loading: false,
    density: 'default',
    storageKey: '',
    showDensity: true,
    showRefresh: true
  }
)

const emit = defineEmits<{
  refresh: []
  'update:density': [value: TableDensity]
}>()

const densityValue = ref<TableDensity>(props.density)
const densityOptions: Array<{ label: string; value: TableDensity }> = [
  { label: '宽松', value: 'large' },
  { label: '标准', value: 'default' },
  { label: '紧凑', value: 'small' }
]

const densityLabel = computed(() => densityOptions.find((item) => item.value === densityValue.value)?.label || '标准')

function loadDensity() {
  if (!props.storageKey) return
  try {
    const stored = localStorage.getItem(`table-density:${props.storageKey}`) as TableDensity | null
    if (stored && densityOptions.some((item) => item.value === stored)) densityValue.value = stored
  } catch {
    // 浏览器禁用 localStorage 时仍使用当前页面默认值。
  }
}

function saveDensity(value: TableDensity) {
  if (!props.storageKey) return
  try {
    localStorage.setItem(`table-density:${props.storageKey}`, value)
  } catch {
    // 忽略偏好保存失败,不影响表格操作。
  }
}

watch(
  () => props.density,
  (value) => {
    if (value !== densityValue.value) densityValue.value = value
  }
)

watch(densityValue, (value) => {
  saveDensity(value)
  emit('update:density', value)
})

onMounted(() => loadDensity())
</script>

<template>
  <div class="data-toolbar">
    <div class="toolbar-filters">
      <slot name="filters" />
      <slot />
    </div>
    <div class="toolbar-actions">
      <slot name="actions" />
      <el-tooltip v-if="showDensity" content="表格密度">
        <el-select v-model="densityValue" class="density-select" :aria-label="`表格密度:${densityLabel}`">
          <el-option v-for="item in densityOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-tooltip>
      <el-button v-if="showRefresh" :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新</el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.data-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  background: $panel;
  border: 1px solid $border;
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 2px 8px color-mix(in srgb, $primary 4%, transparent);
}

.toolbar-filters,
.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.toolbar-filters {
  flex: 1 1 auto;
  min-width: 0;
}

.toolbar-actions {
  margin-left: auto;
}

.density-select {
  width: 88px;
}
</style>
