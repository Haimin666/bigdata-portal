<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ name: 'StateSelect' })

export type StateTagType = 'success' | 'warning' | 'info' | 'danger' | 'primary'

export interface StateOption {
  /** 展示标签 */
  label: string
  /** 实际值(筛选/匹配用) */
  value: string
  /** 展示颜色 */
  type?: StateTagType
  /** 是否视为"运行中"状态(控制重跑/停止等操作) */
  running?: boolean
}

const props = withDefaults(
  defineProps<{
    /** 当前选中值 */
    modelValue: string
    /** 全部状态选项(含"全部"占位时传空值项即可) */
    options: StateOption[]
    /** 是否显示"全部"占位(默认 true,占位值 '') */
    showAll?: boolean
    /** 占位文案 */
    placeholder?: string
    /** 选中后是否立即触发 change(默认 true) */
    clearable?: boolean
    /** 是否过滤(默认 true) */
    filterable?: boolean
    /** 样式宽度 */
    width?: string
  }>(),
  {
    showAll: true,
    placeholder: '状态筛选',
    clearable: true,
    filterable: true,
    width: '130px'
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', value: string): void
}>()

/** 全部状态占位:统一作为 options 第一项 */
const allOption = computed<StateOption>(() => ({
  label: props.showAll ? '全部状态' : '',
  value: ''
}))

function onChange(value: string) {
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<template>
  <el-select
    :model-value="modelValue"
    class="state-select"
    :placeholder="placeholder"
    :clearable="clearable"
    :filterable="filterable"
    :style="{ width }"
    @update:model-value="onChange"
  >
    <el-option v-if="showAll" :key="allOption.value" :label="allOption.label" :value="allOption.value" />
    <el-option v-for="o in options" :key="o.value" :label="o.label" :value="o.value" />
  </el-select>
</template>

<style scoped lang="scss">
.state-select {
  // 宽度由外部 style 控制,这里只保留最小高度一致性
  :deep(.el-select__wrapper) {
    min-height: 32px;
  }
}
</style>
