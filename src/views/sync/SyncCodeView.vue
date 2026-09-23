<script setup lang="ts">
/**
 * 数据同步模块:输入库名/表名 → 展示 db2hive 生成的 SQL 与 JSON 代码 → 一键复制。
 * 数据源:网关 /api/sync/db2hive(代理内部 DBA 服务 10.25.100.51:8000)。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, CopyDocument } from '@element-plus/icons-vue'
import { copyText } from '@/utils/clipboard'
import StateView from '@/components/StateView.vue'
import TableToolbar from '@/components/TableToolbar.vue'

interface SyncResult {
  sqlContent: string
  jsonContent: string
}

const dbName = ref('')
const tableName = ref('')
const loading = ref(false)
const result = ref<SyncResult | null>(null)
const error = ref('')

async function generate() {
  const db = dbName.value.trim()
  const tbl = tableName.value.trim()
  if (!db || !tbl) {
    ElMessage.warning('请填写库名和表名')
    return
  }
  loading.value = true
  result.value = null
  error.value = ''
  try {
    const res = await fetch('/api/sync/db2hive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_name: db, table_name: tbl })
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(body.msg || body.detail || `HTTP ${res.status}`)
    }
    result.value = body.data as SyncResult
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    ElMessage.error(`生成失败:${error.value}`)
  } finally {
    loading.value = false
  }
}

async function copy(text: string, label: string) {
  const ok = await copyText(text)
  if (ok) ElMessage.success(`${label} 已复制`)
  else ElMessage.warning('复制失败,请手动选择复制')
}
</script>

<template>
  <div class="sync-view">
    <TableToolbar :show-density="false" :show-refresh="false">
      <div class="sync-form">
        <el-input v-model="dbName" placeholder="库名,如 pangu" class="sync-input" clearable @keyup.enter="generate" />
        <span class="sync-dot">.</span>
        <el-input v-model="tableName" placeholder="表名,如 sys_flow_s_cap_h" class="sync-input" clearable @keyup.enter="generate" />
        <el-button type="primary" :loading="loading" @click="generate">
          <el-icon v-if="!loading"><Search /></el-icon> 生成
        </el-button>
      </div>
    </TableToolbar>

    <StateView v-if="error" mode="error" :description="error" @retry="generate" />
    <div v-else v-loading="loading" class="sync-body">
      <template v-if="result">
        <div class="code-pane">
          <div class="pane-head">
            <span class="pane-title">SQL</span>
            <el-button text size="small" type="primary" @click="copy(result.sqlContent, 'SQL 代码')">
              <el-icon><CopyDocument /></el-icon> 复制
            </el-button>
          </div>
          <pre class="code-box">{{ result.sqlContent }}</pre>
        </div>
        <div class="code-pane">
          <div class="pane-head">
            <span class="pane-title">JSON</span>
            <el-button text size="small" type="primary" @click="copy(result.jsonContent, 'JSON 代码')">
              <el-icon><CopyDocument /></el-icon> 复制
            </el-button>
          </div>
          <pre class="code-box">{{ result.jsonContent }}</pre>
        </div>
      </template>
      <div v-else class="sync-empty">
        <el-empty description="输入库名与表名,点击「生成」获取 db2hive 同步代码" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.sync-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
}
.sync-form {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.sync-input {
  width: 220px;
}
.sync-dot {
  color: $muted;
  font-weight: 700;
}
.sync-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
  overflow: hidden;
}
.code-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid $border;
  border-radius: 10px;
  background: $panel;
  box-shadow: 0 2px 8px color-mix(in srgb, $primary 4%, transparent);
  overflow: hidden;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bd-table-header, #f7f8fa);
  border-bottom: 1px solid $border;
  flex-shrink: 0;
}
.pane-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: $muted;
}
.code-box {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  background: var(--bd-panel, #fff);
  color: var(--bd-text, #24292f);
}
.sync-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  border: 1px dashed $border;
  border-radius: 10px;
  background: $panel;
}
</style>
