<script setup lang="ts">
/**
 * 数据同步模块:输入库名/表名 → 展示 db2hive 生成的 SQL 与 JSON 代码 → 一键复制。
 * 数据源:网关 /api/sync/db2hive(代理内部 DBA 服务 10.25.100.51:8000)。
 */
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, CopyDocument } from '@element-plus/icons-vue'
import { copyText } from '@/utils/clipboard'

interface SyncResult {
  sqlContent: string
  jsonContent: string
}

const dbName = ref('')
const tableName = ref('')
const loading = ref(false)
const result = ref<SyncResult | null>(null)

async function generate() {
  const db = dbName.value.trim()
  const tbl = tableName.value.trim()
  if (!db || !tbl) {
    ElMessage.warning('请填写库名和表名')
    return
  }
  loading.value = true
  result.value = null
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
    ElMessage.error(`生成失败:${e instanceof Error ? e.message : e}`)
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
    <div class="sync-header">
      <div class="sync-title">数据同步 <span class="sync-sub">db2hive 代码生成</span></div>
      <div class="sync-form">
        <el-input v-model="dbName" placeholder="库名,如 pangu" class="sync-input" clearable @keyup.enter="generate" />
        <span class="sync-dot">.</span>
        <el-input v-model="tableName" placeholder="表名,如 sys_flow_s_cap_h" class="sync-input" clearable @keyup.enter="generate" />
        <el-button type="primary" :loading="loading" @click="generate">
          <el-icon v-if="!loading"><Search /></el-icon> 生成
        </el-button>
      </div>
    </div>

    <div v-loading="loading" class="sync-body">
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
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
}
.sync-header {
  flex-shrink: 0;
  padding-bottom: 10px;
}
.sync-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
  .sync-sub {
    font-size: 12px;
    font-weight: 400;
    color: $muted;
    margin-left: 6px;
  }
}
.sync-form {
  display: flex;
  align-items: center;
  gap: 8px;
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
  border-radius: 8px;
  overflow: hidden;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: var(--bd-table-header, #f7f8fa);
  border-bottom: 1px solid $border;
  flex-shrink: 0;
}
.pane-title {
  font-size: 13px;
  font-weight: 600;
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
}
</style>