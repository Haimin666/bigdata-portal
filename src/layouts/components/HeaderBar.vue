<script setup lang="ts">
import { Expand, Fold } from '@element-plus/icons-vue'

defineOptions({ name: 'HeaderBar' })

const props = defineProps<{
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-collapse'): void
}>()
</script>

<template>
  <el-header class="portal-header">
    <el-icon class="header-icon" @click="emit('toggle-collapse')">
      <Expand v-if="props.collapsed" />
      <Fold v-else />
    </el-icon>
  </el-header>
</template>

<style scoped lang="scss">
.portal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border-bottom: 1px solid $border;
  height: 40px;
}

.header-icon {
  font-size: 18px;
  cursor: pointer;
  color: $muted;
  margin-left: 12px;
}
</style>
