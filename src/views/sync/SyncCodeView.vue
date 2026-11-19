<script setup lang="ts">
/**
 * 数据同步模块:按 MySQL 库.表 / Oracle 服务.库.表选择源路径 → 展示 db2hive SQL 与 JSON → 一键复制。
 * 数据源:门户网关 /api/sync/db2hive → db-proxy。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, CopyDocument } from '@element-plus/icons-vue'
import { copyText } from '@/utils/clipboard'
import { listDataSources, listOwners, listTables, type DbDataSource, type TableMeta } from '@/api/db'
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
const oracleSchemaName = ref('')
const oracleOwners = ref<string[]>([])
const oracleOwnersLoading = ref(false)
const tableName = ref('')
const tableOptions = ref<string[]>([])
const datasourceLoading = ref(false)
const datasourceError = ref('')
const tableLoading = ref(false)
const tableError = ref('')
const loading = ref(false)
const result = ref<SyncResult | null>(null)
const error = ref('')
let tableLoadSequence = 0
let ownerLoadSequence = 0

const mysqlSources = computed(() => datasources.value.filter(
  (source) => source.type === 'mysql' && source.sourceType !== 'doris'
))
const oracleSources = computed(() => datasources.value.filter((source) => source.type === 'oracle'))
const oracleServiceNames = computed(() => [...new Set(
  oracleSources.value
    .map((source) => source.serviceName?.trim())
    .filter((name): name is string => Boolean(name))
)])
const engineSources = computed(() => databaseType.value === 'oracle' ? oracleSources.value : mysqlSources.value)
const oracleServiceSources = computed(() => oracleSources.value.filter(
  (source) => serviceName.value && source.serviceName?.trim() === serviceName.value
))
const availableSources = computed(() => databaseType.value === 'oracle' ? oracleServiceSources.value : mysqlSources.value)
const selectedSource = computed(() => availableSources.value.find((source) => source.name === datasourceId.value))
const selectedDatabase = computed(() => {
  const source = selectedSource.value
  if (!source) return ''
  if (databaseType.value === 'mysql') return source.database?.trim() || source.name
  if (oracleSchemaName.value) return oracleSchemaName.value
  return tableName.value.includes('.') ? tableName.value.split('.', 1)[0] : source.owner?.trim() || ''
})

function sourceLabel(source: DbDataSource) {
  return source.label && source.label !== source.name ? `${source.label}（${source.name}）` : source.name
}

function databaseLabel(source: DbDataSource) {
  if (databaseType.value === 'oracle') {
    const defaultOwner = source.owner?.trim()
    return `${sourceLabel(source)}${defaultOwner ? ` · 默认 ${defaultOwner}` : ''}`
  }
  const database = source.database?.trim() || source.name
  const duplicates = availableSources.value.filter((item) => (item.database?.trim() || item.name) === database).length > 1
  return duplicates ? `${database}（${sourceLabel(source)}）` : database
}

function clearSelectedSource() {
  datasourceId.value = ''
  oracleSchemaName.value = ''
  oracleOwners.value = []
  ownerLoadSequence += 1
  oracleOwnersLoading.value = false
}

async function loadOracleOwners(source: DbDataSource) {
  const sequence = ++ownerLoadSequence
  oracleSchemaName.value = ''
  oracleOwners.value = []
  if (databaseType.value !== 'oracle') return
  oracleOwnersLoading.value = true
  try {
    const owners = await listOwners(source.name)
    if (sequence !== ownerLoadSequence || selectedSource.value?.name !== source.name) return
    oracleOwners.value = owners.map((owner) => owner.toUpperCase())
    const configuredOwner = source.owner?.trim().toUpperCase() || ''
    oracleSchemaName.value = oracleOwners.value.find((owner) => owner === configuredOwner) || ''
  } catch (e) {
    if (sequence === ownerLoadSequence) datasourceError.value = `加载 Oracle Schema 失败:${e instanceof Error ? e.message : e}`
  } finally {
    if (sequence === ownerLoadSequence) oracleOwnersLoading.value = false
  }
}

async function loadSelectedTables() {
  const sequence = ++tableLoadSequence
  const source = selectedSource.value
  tableName.value = ''
  tableOptions.value = []
  tableError.value = ''
  if (!source) {
    tableLoading.value = false
    return
  }

  tableLoading.value = true
  try {
    const isOracle = databaseType.value === 'oracle'
    const schemaAtRequest = isOracle ? oracleSchemaName.value : undefined
    const tables = await listTables(source.name, isOracle, schemaAtRequest)
    if (sequence !== tableLoadSequence) return
    tableOptions.value = isOracle
      ? (tables as TableMeta[])
          .map((item) => schemaAtRequest ? item.name : item.qualifiedName || (item.owner ? `${item.owner}.${item.name}` : item.name))
          .filter((name) => Boolean(name?.trim()))
          .map((name) => name.trim())
      : (tables as string[])
          .filter((name) => Boolean(name?.trim()))
          .map((name) => name.trim())
  } catch (e) {
    if (sequence === tableLoadSequence) {
      tableError.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (sequence === tableLoadSequence) tableLoading.value = false
  }
}

async function handleDatabaseTypeChange() {
  serviceName.value = ''
  clearSelectedSource()
  datasourceError.value = !engineSources.value.length
    ? `未配置${databaseType.value === 'mysql' ? 'MySQL' : 'Oracle'}数据源`
    : databaseType.value === 'oracle' && !oracleServiceNames.value.length
      ? '未配置 Oracle Service Name'
      : ''
  await loadSelectedTables()
}

async function handleServiceNameChange() {
  clearSelectedSource()
  await loadSelectedTables()
}

async function handleDatabaseChange() {
  const source = selectedSource.value
  if (databaseType.value === 'oracle') {
    if (source) await loadOracleOwners(source)
    else {
      ownerLoadSequence += 1
      oracleOwnersLoading.value = false
      oracleOwners.value = []
      oracleSchemaName.value = ''
    }
  }
  await loadSelectedTables()
}

async function loadDataSources() {
  datasourceLoading.value = true
  datasourceError.value = ''
  try {
    datasources.value = await listDataSources()
    const hasMysql = datasources.value.some((source) => source.type === 'mysql' && source.sourceType !== 'doris')
    const hasOracle = datasources.value.some((source) => source.type === 'oracle')
    databaseType.value = hasMysql || !hasOracle ? 'mysql' : 'oracle'
    serviceName.value = ''
    clearSelectedSource()
    if (!datasources.value.length) datasourceError.value = '未配置可用数据库源'
    else if (!engineSources.value.length) datasourceError.value = `未配置${databaseType.value === 'mysql' ? 'MySQL' : 'Oracle'}数据源`
    else if (databaseType.value === 'oracle' && !oracleServiceNames.value.length) datasourceError.value = '未配置 Oracle Service Name'
  } catch (e) {
    datasourceError.value = `加载数据源失败:${e instanceof Error ? e.message : e}`
  } finally {
    datasourceLoading.value = false
  }
}

async function generate() {
  const db = selectedDatabase.value.trim()
  const tbl = tableName.value.trim()
  const selected = selectedSource.value
  if (!selected || !db) {
    ElMessage.warning('请先选择库')
    return
  }
  if (!tbl) {
    ElMessage.warning('请先选择表')
    return
  }
  if (databaseType.value === 'oracle' && !serviceName.value) {
    ElMessage.warning('请先选择 Oracle Service Name')
    return
  }
  if (databaseType.value === 'oracle' && !oracleSchemaName.value && !tbl.includes('.')) {
    ElMessage.warning('全部 Schema 模式下请选择 OWNER.TABLE 格式的表')
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
    if (oracleSchemaName.value) payload.owner = oracleSchemaName.value
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
          <span class="sync-label">类型</span>
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
            placeholder="输入或选择服务名"
            filterable
            clearable
            :disabled="datasourceLoading || !oracleServiceNames.length"
            @change="handleServiceNameChange"
          >
            <el-option v-for="name in oracleServiceNames" :key="name" :label="name" :value="name" />
          </el-select>
        </div>
        <div class="sync-field">
          <span class="sync-label">{{ databaseType === 'oracle' ? '连接' : '库' }}</span>
          <el-select
            v-model="datasourceId"
            class="sync-input sync-source-input"
            :placeholder="datasourceLoading ? '加载库…' : '输入或选择库'"
            filterable
            clearable
            :disabled="datasourceLoading || !availableSources.length"
            @change="handleDatabaseChange"
          >
            <el-option v-for="source in availableSources" :key="source.name" :label="databaseLabel(source)" :value="source.name" />
          </el-select>
        </div>
        <div v-if="databaseType === 'oracle'" class="sync-field">
          <span class="sync-label">Schema</span>
          <el-select
            v-model="oracleSchemaName"
            class="sync-input sync-schema-input"
            placeholder="全部可见 Schema"
            filterable
            clearable
            :loading="oracleOwnersLoading"
            :disabled="datasourceLoading || !selectedSource"
            @change="loadSelectedTables"
          >
            <el-option label="全部可见 Schema" value="" />
            <el-option v-for="owner in oracleOwners" :key="owner" :label="owner" :value="owner" />
          </el-select>
        </div>

        <span class="sync-dot">.</span>
        <div class="sync-field sync-table-field">
          <span class="sync-label">表</span>
          <el-select
            v-model="tableName"
            class="sync-input"
            :placeholder="tableLoading ? '加载表…' : tableError ? '表加载失败，请重新选择库' : selectedSource ? '输入或选择表' : '请先选择库'"
            filterable
            clearable
            :loading="tableLoading"
            :disabled="!selectedSource || tableLoading || !!tableError"
          >
            <el-option v-for="table in tableOptions" :key="table" :label="table" :value="table" />
          </el-select>
          <span v-if="tableError" class="sync-inline-error">
            {{ tableError }}
            <el-button text size="small" type="primary" @click="loadSelectedTables">重试</el-button>
          </span>
        </div>
        <el-button type="primary" :loading="loading" :disabled="datasourceLoading || tableLoading || !!datasourceError" class="sync-submit" @click="generate">
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
        <el-empty description="按库路径选择库和表，点击「生成」获取 db2hive 同步代码" />
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
.sync-service-input {
  width: 160px;
}
.sync-source-input {
  width: 190px;
}
.sync-schema-input {
  width: 160px;
}
.sync-table-field .sync-input {
  width: 180px;
}
.sync-inline-error {
  color: var(--el-color-danger);
  font-size: 11px;
  line-height: 1.3;
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
  .sync-source-input,
  .sync-schema-input,
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
