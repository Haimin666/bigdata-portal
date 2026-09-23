<script setup lang="ts">
defineOptions({ name: 'StateView' })

withDefaults(
  defineProps<{
    mode: 'loading' | 'empty' | 'error'
    title?: string
    description?: string
    retryText?: string
    compact?: boolean
  }>(),
  {
    title: '',
    description: '',
    retryText: '重试',
    compact: false
  }
)

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div class="state-view" :class="{ compact }">
    <el-skeleton v-if="mode === 'loading'" :rows="compact ? 2 : 4" animated />
    <el-result v-else-if="mode === 'error'" icon="error" :title="title || '加载失败'" :sub-title="description">
      <template #extra>
        <slot name="actions">
          <el-button type="primary" @click="emit('retry')">{{ retryText }}</el-button>
        </slot>
      </template>
    </el-result>
    <el-empty v-else :image-size="compact ? 48 : 72" :description="description || '暂无数据'" />
  </div>
</template>

<style scoped lang="scss">
.state-view {
  display: flex;
  min-height: 150px;
  align-items: center;
  justify-content: center;
  padding: 16px;

  &.compact {
    min-height: 92px;
    padding: 8px;
  }
}

.state-view :deep(.el-result) {
  padding: 12px 0;
}

.state-view :deep(.el-empty) {
  padding: 8px 0;
}
</style>
