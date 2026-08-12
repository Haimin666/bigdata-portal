<script setup lang="ts">
/**
 * 通用 iframe 弹窗:点击「追踪UI / 日志 / 资源管理器」等链接时,
 * 在弹窗内嵌入目标页面查看,避免离开当前平台。
 * 若目标系统禁止 iframe(X-Frame-Options),提供「新窗口打开」兜底。
 */
import { ref } from 'vue'
import { Refresh, FullScreen } from '@element-plus/icons-vue'

defineOptions({ name: 'UrlFrameDialog' })

const props = defineProps<{
  modelValue: boolean
  url: string
  title?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const frameKey = ref(0)

function reload() {
  frameKey.value++
}

function openNew() {
  if (props.url) window.open(props.url, '_blank')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title || '查看页面'"
    width="86%"
    top="3vh"
    destroy-on-close
    class="url-frame-dialog"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="ufd-toolbar">
      <el-input :model-value="url" readonly size="small" class="ufd-url">
        <template #prepend>地址</template>
      </el-input>
      <el-button size="small" :icon="Refresh" @click="reload">刷新</el-button>
      <el-button size="small" type="primary" :icon="FullScreen" @click="openNew">新窗口打开</el-button>
    </div>
    <div class="ufd-body">
      <iframe
        v-if="url"
        :key="frameKey"
        :src="url"
        class="ufd-iframe"
        allow="fullscreen"
      />
      <el-empty v-else description="无可用地址" />
    </div>
    <div class="ufd-tip">
      提示:若嵌入内容为空白,可能是目标系统禁止 iframe(X-Frame-Options),请点击「新窗口打开」查看。
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.url-frame-dialog {
  :deep(.el-dialog__body) {
    padding: 8px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
}

.ufd-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.ufd-url {
  flex: 1;
}

.ufd-body {
  height: calc(88vh - 130px);
  min-height: 320px;
  border: 1px solid $border;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ufd-iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.ufd-tip {
  font-size: 12px;
  color: $muted;
}
</style>
