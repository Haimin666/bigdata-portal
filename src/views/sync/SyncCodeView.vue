<script setup lang="ts">
/**
 * 数据同步模块:选择已授权的数据源与 Hive 目标名前缀 → 展示 db2hive SQL 与 JSON → 一键复制。
 * 数据源:门户网关 /api/sync/db2hive → db-proxy。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, CopyDocument } from '@element-plus/icons-vue'
import { copyText } from '@/utils/clipboard'
import { listDataSources, type DbDataSource } from '@/api/db'
import StateView from '@/components/StateView.vue'
import TableToolbar from '@/components/TableToolbar.vue'

interface SyncResult {
  sqlContent: string
  jsonContent: string
  typeWarnings?: string[]
}

type DatabaseType = 'mysql' | 'oracle'

const datasources = ref<DbDataSource[]>([])
const databaseType = ref<DatabaseType>('mysql')
const datasourceId = ref('')
const serviceName = ref('')
const owner = ref('')
const dbName = ref('')
const tableName = ref('')
const datasourceLoading = ref(false)
const datasourceError = ref('')
const loading = ref(false)
const result = ref<SyncResult | null>(null)
const error = ref('')

const engineSources = computed(() => datasources.value.filter((source) => source.type === databaseType.value))
const oracleServiceNames = computed(() => [...new Set(
  datasources.value
    .filter((source) => source.type === 'oracle')
    .map((source) => source.serviceName)
    .filter((name): name is string => Boolean(name?.trim()))
)])
const oracleServiceSources = computed(() => engineSources.value.filter(
  (source) => source.type === 'oracle' && source.serviceName === serviceName.value
))
const availableSources = computed(() => databaseType.value === 'oracle' ? oracleServiceSources.value : engineSources.value)
const ownerOptions = computed(() => [...new Set(
  oracleServiceSources.value
    .map((source) => source.owner)
    .filter((value): value is string => Boolean(value?.trim()))
)])
const selectedSource = computed(() => availableSources.value.find((source) => source.name === datasourceId.value))

function sourceLabel(source: DbDataSource) {
  return source.label && source.label !== source.name ? `${source.label}（${source.name}）` : source.name
}

function selectInitialSource() {
  const source = databaseType.value === 'oracle'
    ? oracleServiceSources.value.find((item) => item.owner && ownerOptions.value.includes(item.owner)) || oracleServiceSources.value[0]
    : availableSources.value[0]
  datasourceId.value = source?.name || ''
  owner.value = databaseType.value === 'oracle' && source?.owner && ownerOptions.value.includes(source.owner)
    ? source.owner
    : ''
}

function handleDatabaseTypeChange() {
  if (databaseType.value === 'oracle') {
    serviceName.value = oracleServiceNames.value[0] || ''
  } else {
    serviceName.value = ''
    owner.value = ''
  }
  selectInitialSource()
}

function handleServiceNameChange() {
  selectInitialSource()
}

function handleDatasourceChange() {
  if (databaseType.value !== 'oracle') return
  const source = selectedSource.value
  owner.value = source?.owner && ownerOptions.value.includes(source.owner) ? source.owner : ''
}

function handleOwnerChange(value: string) {
  // Owner is sourced only from ACL entries for this Service Name. Keep the
  // selected datasource_id paired with the chosen owner when such an entry exists.
  if (!ownerOptions.value.includes(value)) {
    owner.value = ''
    return
  }
  owner.value = value
  const matchingSource = oracleServiceSources.value.find((source) => source.owner === value)
  if (matchingSource) datasourceId.value = matchingSource.name
}

async function loadDataSources() {
  datasourceLoading.value = true
  datasourceError.value = ''
  try {
    datasources.value = await listDataSources()
    const hasMysql = datasources.value.some((source) => source.type === 'mysql')
    const hasOracle = datasources.value.some((source) => source.type === 'oracle')
    databaseType.value = hasMysql || !hasOracle ? 'mysql' : 'oracle'
    serviceName.value = databaseType.value === 'oracle' ? (oracleServiceNames.value[0] || '') : ''
    selectInitialSource()
    if (!datasources.value.length) datasourceError.value = '未配置可用数据库源'
    else if (!engineSources.value.length) datasourceError.value = `未配置${databaseType.value === 'mysql' ? 'MySQL' : 'Oracle'}数据源`
  } catch (e) {
    datasourceError.value = `加载数据源失败:${e instanceof Error ? e.message : e}`
  } finally {
    datasourceLoading.value = false
  }
}

async function generate() {
  const db = dbName.value.trim()
  const tbl = tableName.value.trim()
  const selected = selectedSource.value
  if (!db || !tbl) {
    ElMessage.warning('请填写 Hive 目标名前缀和未限定表名')
    return
  }
  if (!selected) {
    ElMessage.warning('请选择可用数据源')
    return
  }
  if (databaseType.value === 'oracle' && (
    !serviceName.value ||
    !ownerOptions.value.includes(owner.value) ||
    selected.owner !== owner.value
  )) {
    ElMessage.warning('请选择与当前 Oracle 数据源匹配的 owner/schema')
    return
  }

  const payload: {
    datasource_id: string
    service_name?: string
    owner?: string
    db_name: string
    table_name: string
  } = {
    datasource_id: selected.name,
    db_name: db,
    table_name: tbl,
  }
  if (databaseType.value === 'oracle') {
    payload.service_name = serviceName.value
    payload.owner = owner.value
  }

  loading.value = true
  result.value = null
  error.value = ''
  try {
    const res = await fetch('/api/sync/db2hive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new Error(body.msg || body.detail || `HTTP ${res.status}`)
    }
    const generated = body.data as SyncResult
    result.value = generated
    if (generated.typeWarnings?.length) {
      const details = generated.typeWarnings.slice(0, 4).join('；')
      const remaining = generated.typeWarnings.length - 4
      const suffix = remaining > 0 ? `；另有 ${remaining} 项` : ''
      ElMessage.warning({
        message: `检测到数据类型问题，核对 Hive 和 DataX 字段类型是否一致：${details}${suffix}`,
        duration: 8000,
        showClose: true,
      })
    }
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

onMounted(() => {
  void loadDataSources()
})
</script>

<template>
  <div class="sync-view">
    <TableToolbar :show-density="false" :show-refresh="false">
      <div class="sync-form">
        <div class="sync-field sync-engine-field">
          <span class="sync-label">数据库</span>
          <el-select v-model="databaseType" class="sync-input" :disabled="datasourceLoading" @change="handleDatabaseTypeChange">
            <el-option label="MySQL" value="mysql" />
            <el-option label="Oracle" value="oracle" />
          </el-select>
        </div>

        <div v-if="databaseType === 'oracle'" class="sync-field">
          <span class="sync-label">Service Name</span>
          <el-select
            v-model="serviceName"
            class="sync-input sync-service-input"
            placeholder="选择服务名"
            :disabled="datasourceLoading || !oracleServiceNames.length"
            @change="handleServiceNameChange"
          >
            <el-option v-for="name in oracleServiceNames" :key="name" :label="name" :value="name" />
          </el-select>
        </div>

        <div class="sync-field">
          <span class="sync-label">数据源</span>
          <el-select
            v-model="datasourceId"
            class="sync-input sync-source-input"
            :placeholder="datasourceLoading ? '加载数据源…' : '选择数据源'"
            :disabled="datasourceLoading || !availableSources.length"
            @change="handleDatasourceChange"
          >
            <el-option v-for="source in availableSources" :key="source.name" :label="sourceLabel(source)" :value="source.name" />
          </el-select>
        </div>

        <div v-if="databaseType === 'oracle'" class="sync-field">
          <span class="sync-label">Owner / Schema</span>
          <el-select
            v-model="owner"
            class="sync-input sync-owner-input"
            placeholder="选择 owner/schema"
            :disabled="datasourceLoading || !ownerOptions.length"
            @change="handleOwnerChange"
          >
            <el-option v-for="item in ownerOptions" :key="item" :label="item" :value="item" />
          </el-select>
        </div>

        <div class="sync-field sync-target-field">
          <span class="sync-label">Hive 目标名前缀</span>
          <el-input v-model="dbName" placeholder="如 pangu" class="sync-input" clearable @keyup.enter="generate" />
        </div>
        <span class="sync-dot">.</span>
        <div class="sync-field sync-table-field">
          <span class="sync-label">源表名</span>
          <el-input
            v-model="tableName"
            :placeholder="databaseType === 'oracle' ? '未限定表名' : '表名'"
            class="sync-input"
            clearable
            @keyup.enter="generate"
          />
        </div>
        <el-button type="primary" :loading="loading" :disabled="datasourceLoading || !!datasourceError" class="sync-submit" @click="generate">
          <el-icon v-if="!loading"><Search /></el-icon> 生成
        </el-button>
      </div>
    </TableToolbar>

    <StateView v-if="datasourceError" mode="error" :description="datasourceError" @retry="loadDataSources" />
    <StateView v-else-if="error" mode="error" :description="error" @retry="generate" />
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
        <el-empty description="选择数据库源，填写 Hive 目标名前缀与源表名，点击「生成」获取 db2hive 同步代码" />
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
  overflow: hidden;
}
.sync-form {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px 10px;
  width: 100%;
  min-width: 0;
}
.sync-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sync-label {
  color: $muted;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}
.sync-input {
  width: 170px;
}
.sync-engine-field .sync-input {
  width: 130px;
}
.sync-service-input,
.sync-owner-input {
  width: 160px;
}
.sync-source-input {
  width: 190px;
}
.sync-target-field .sync-input {
  width: 180px;
}
.sync-table-field .sync-input {
  width: 180px;
}
.sync-dot {
  align-self: flex-end;
  padding: 0 0 8px;
  color: $muted;
  font-weight: 700;
}
.sync-submit {
  min-width: 86px;
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
@media (max-width: 640px) {
  .sync-view {
    gap: 10px;
    padding: 10px;
    overflow: auto;
  }
  .sync-form {
    align-items: stretch;
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 8px;
  }
  .sync-field,
  .sync-input,
  .sync-engine-field .sync-input,
  .sync-service-input,
  .sync-owner-input,
  .sync-source-input,
  .sync-target-field .sync-input,
  .sync-table-field .sync-input {
    width: 100%;
  }
  .sync-dot {
    display: none;
  }
  .sync-submit {
    width: 100%;
    min-height: 36px;
    margin-top: 2px;
  }
  .sync-body {
    min-height: 360px;
    flex-direction: column;
    overflow: visible;
  }
  .code-pane {
    min-height: 260px;
    flex: 1 0 260px;
  }
}
</style>
