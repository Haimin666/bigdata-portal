<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { menus } from '@/config/menu'
import { Expand, Fold, Refresh, FullScreen } from '@element-plus/icons-vue'

defineOptions({ name: 'HeaderBar' })

const props = defineProps<{
  collapsed: boolean
  fullscreen: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-collapse'): void
  (e: 'refresh'): void
  (e: 'toggle-fullscreen'): void
}>()

const route = useRoute()

const title = computed(() => menus.find((m) => m.path === route.path)?.title || '')
</script>

<template>
  <el-header class="portal-header">
    <el-icon class="header-icon" @click="emit('toggle-collapse')">
      <Expand v-if="props.collapsed" />
      <Fold v-else />
    </el-icon>
    <span class="header-title">{{ title }}</span>
    <div class="header-actions">
      <el-icon class="header-icon" @click="emit('refresh')"><Refresh /></el-icon>
      <el-icon class="header-icon" @click="emit('toggle-fullscreen')"><FullScreen /></el-icon>
    </div>
  </el-header>
</template>

<style scoped lang="scss">
.portal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border-bottom: 1px solid $border;
}

.header-icon {
  font-size: 18px;
  cursor: pointer;
  color: $muted;
}

.header-title {
  font-weight: 600;
  color: $text;
}

.header-actions {
  display: flex;
  gap: 12px;
  margin-left: auto;
}
</style>
