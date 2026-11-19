<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, EditPen, Plus, Refresh, Connection, Search } from '@element-plus/icons-vue'
import {
  createDbConnection,
  deleteDbConnection,
  listDbConnections,
  testDbConnection,
  updateDbConnection,
  type DbConnection,
  type DbConnectionPayload,
  type DbConnectionType
} from '@/api/db-connections'

const connections = ref<DbConnection[]>([])
const activeType = ref<DbConnectionType>('oracle')
const revision = ref('')
const loading = ref(false)
const loadError = ref('')
const dialogVisible = ref(false)
const isEditing = ref(false)
const saving = ref(false)
const deletingName = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean; elapsedMs: number; error?: string } | null>(null)

const form = reactive<DbConnectionPayload>({
  name: '', label: '', type: 'mysql', host: '', port: 3306, user: '', database: '',
  serviceName: '', owner: '', charset: 'utf8mb4', rowLimit: '', readOnly: true, password: ''
})

const defaultPort: Record<DbConnectionType, number> = { mysql: 3306, oracle: 1521, doris: 9030 }
const typeLabels: Record<DbConnectionType, string> = { mysql: 'MySQL', oracle: 'Oracle', doris: 'Doris' }
function connectionTypeLabel(type: DbConnectionType): string { return typeLabels[type] || type }
const keyword = ref('')
const currentPage = ref(1)
const pageSize = ref(16)
const sortProp = ref('')
const sortOrder = ref<'ascending' | 'descending' | null>(null)

const typeCounts = computed(() => ({
  mysql: connections.value.filter((item) => item.type === 'mysql').length,
  oracle: connections.value.filter((item) => item.type === 'oracle').length,
  doris: connections.value.filter((item) => item.type === 'doris').length
}))
const activeConnections = computed(() => connections.value.filter((item) => item.type === activeType.value))

const filteredConnections = computed(() => {
  const terms = keyword.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = activeConnections.value.filter((item) => {
    if (!terms.length) return true
    const searchable = [
      item.label, item.name, typeLabels[item.type] || item.type, item.type,
      item.host, String(item.port), item.user, item.database, item.serviceName, item.owner
    ].filter(Boolean).join(' ').toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
  if (!sortProp.value || !sortOrder.value) return matches

  const direction = sortOrder.value === 'ascending' ? 1 : -1
  const compareText = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  return [...matches].sort((left, right) => {
    let result = 0
    switch (sortProp.value) {
      case 'name': result = compareText(left.label || left.name, right.label || right.name); break
      case 'host': result = compareText(left.host, right.host) || left.port - right.port; break
      case 'user': result = compareText(left.user, right.user); break
      case 'database': result = compareText(left.database || left.serviceName, right.database || right.serviceName); break
      case 'hasPassword': result = Number(left.hasPassword) - Number(right.hasPassword); break
      case 'readOnly': result = Number(left.readOnly) - Number(right.readOnly); break
      default: result = 0
    }
    return (result || compareText(left.name, right.name)) * direction
  })
})

const pagedConnections = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredConnections.value.slice(start, start + pageSize.value)
})

watch(keyword, () => { currentPage.value = 1 })
watch(activeType, () => { currentPage.value = 1 })
watch(pageSize, () => { currentPage.value = 1 })
watch(() => filteredConnections.value.length, (total) => {
  const lastPage = Math.max(1, Math.ceil(total / pageSize.value))
  if (currentPage.value > lastPage) currentPage.value = lastPage
})

function onSortChange({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  sortProp.value = order ? prop : ''
  sortOrder.value = order
  currentPage.value = 1
}

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await listDbConnections()
    connections.value = result.datasources
    revision.value = result.revision
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    ElMessage.error(`加载数据库连接失败：${loadError.value}`)
  } finally {
    loading.value = false
  }
}

function resetForm() {
  Object.assign(form, {
    name: '', label: '', type: 'mysql', host: '', port: 3306, user: '', database: '',
    serviceName: '', owner: '', charset: 'utf8mb4', rowLimit: '', readOnly: true, password: ''
  })
  testResult.value = null
}

function openCreate() {
  if (saving.value || deletingName.value) return
  resetForm()
  isEditing.value = false
  form.type = activeType.value
  form.port = defaultPort[activeType.value]
  dialogVisible.value = true
}

function openEdit(connection: DbConnection) {
  if (saving.value || deletingName.value) return
  resetForm()
  isEditing.value = true
  Object.assign(form, {
    name: connection.name,
    label: connection.label || '',
    type: connection.type,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    database: connection.database || '',
    serviceName: connection.serviceName || '',
    owner: connection.owner || '',
    charset: connection.charset || '',
    rowLimit: connection.rowLimit || '',
    readOnly: connection.readOnly,
    password: ''
  })
  dialogVisible.value = true
}

function validate(requirePassword: boolean): string {
  if (!form.name.trim()) return '请输入连接名称'
  if (!form.host.trim()) return '请输入主机地址'
  if (!Number.isInteger(Number(form.port)) || Number(form.port) < 1 || Number(form.port) > 65535) return '请输入有效端口'
  if (!form.user.trim()) return '请输入用户名'
  if (form.type === 'oracle' && !form.serviceName.trim()) return 'Oracle 连接必须填写 Service Name'
  if (form.type !== 'oracle' && !form.database.trim()) return '请输入数据库名'
  if (requirePassword && !form.password) return '连接测试需要输入密码'
  if (!isEditing.value && !form.password) return '新增连接必须填写密码'
  return ''
}

function payload(): DbConnectionPayload {
  return {
    ...form,
    name: form.name.trim(), label: form.label.trim(), host: form.host.trim(),
    user: form.user.trim(), database: form.database.trim(), serviceName: form.serviceName.trim(),
    owner: form.type === 'oracle' ? form.owner?.trim() || undefined : undefined,
    password: form.password, expectedRevision: revision.value || undefined
  }
}

async function save() {
  if (saving.value || deletingName.value) return
  const invalid = validate(false)
  if (invalid) return ElMessage.warning(invalid)
  saving.value = true
  try {
    const savedType = form.type
    if (isEditing.value) await updateDbConnection(form.name, payload())
    else await createDbConnection(payload())
    activeType.value = savedType
    ElMessage.success(isEditing.value ? '数据库连接已更新' : '数据库连接已创建')
    dialogVisible.value = false
    await refresh()
  } catch (error) {
    ElMessage.error(`保存失败：${error instanceof Error ? error.message : error}`)
  } finally {
    saving.value = false
  }
}

async function remove(connection: DbConnection) {
  if (saving.value || deletingName.value) return
  deletingName.value = connection.name
  try {
    await ElMessageBox.confirm(
      `确定删除数据库连接「${connection.label || connection.name}」？删除后无法从门户恢复。`,
      '删除数据库连接',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    deletingName.value = ''
    return
  }
  try {
    await deleteDbConnection(connection.name, revision.value)
    ElMessage.success('数据库连接已删除')
    await refresh()
  } catch (error) {
    ElMessage.error(`删除失败：${error instanceof Error ? error.message : error}`)
  } finally {
    deletingName.value = ''
  }
}

async function testConnection() {
  if (testing.value || saving.value || deletingName.value) return
  const invalid = validate(true)
  if (invalid) return ElMessage.warning(invalid)
  testing.value = true
  testResult.value = null
  try {
    const result = await testDbConnection(payload())
    testResult.value = result
    if (result.ok) ElMessage.success(`连接成功（${result.elapsedMs} ms）`)
    else ElMessage.error(result.error || '连接测试失败')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    testResult.value = { ok: false, elapsedMs: 0, error: message }
    ElMessage.error(`连接测试失败：${message}`)
  } finally {
    testing.value = false
  }
}

function onTypeChange(type: DbConnectionType) {
  form.port = defaultPort[type]
  testResult.value = null
}

onMounted(refresh)
</script>

<template>
  <section class="connection-page">
    <div class="toolbar">
      <div class="toolbar-copy">
        <span class="toolbar-title">数据库连接</span>
        <span class="tip">管理查询工作台使用的 MySQL、Oracle 与 Doris 数据源</span>
      </div>
      <div class="toolbar-actions">
        <el-input v-model="keyword" class="keyword-search" :prefix-icon="Search" clearable placeholder="搜索名称、主机、用户、数据库…" />
        <el-button :icon="Refresh" :loading="loading" @click="refresh">刷新</el-button>
        <el-button type="primary" :icon="Plus" :disabled="saving || !!deletingName" @click="openCreate">新增连接</el-button>
      </div>
    </div>

    <el-alert v-if="loadError" class="load-error" type="error" :closable="false" show-icon :title="`连接列表加载失败：${loadError}`">
      <template #default><el-button link type="primary" @click="refresh">重试</el-button></template>
    </el-alert>

    <el-tabs v-model="activeType" class="connection-tabs">
      <el-tab-pane name="oracle">
        <template #label><span class="connection-tab-label">Oracle <el-tag size="small" effect="plain">{{ typeCounts.oracle }}</el-tag></span></template>
      </el-tab-pane>
      <el-tab-pane name="mysql">
        <template #label><span class="connection-tab-label">MySQL <el-tag size="small" effect="plain">{{ typeCounts.mysql }}</el-tag></span></template>
      </el-tab-pane>
      <el-tab-pane name="doris">
        <template #label><span class="connection-tab-label">Doris <el-tag size="small" effect="plain">{{ typeCounts.doris }}</el-tag></span></template>
      </el-tab-pane>
    </el-tabs>

    <div class="list-shell">
      <div v-loading="loading" class="table-wrap">
        <el-table
          :data="pagedConnections"
          border
          height="100%"
          class="connection-table"
          @sort-change="onSortChange"
        >
          <el-table-column prop="name" label="数据源" min-width="180" sortable="custom">
            <template #default="{ row }">
              <div class="source-name">{{ row.label || row.name }}</div>
              <div class="source-key">{{ row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="host" label="连接地址" min-width="210" sortable="custom">
            <template #default="{ row }"><span class="mono">{{ row.host }}:{{ row.port }}</span></template>
          </el-table-column>
          <el-table-column prop="user" label="用户名" min-width="130" sortable="custom" />
          <el-table-column prop="database" label="数据库 / 服务名" min-width="160" sortable="custom">
            <template #default="{ row }">
              <div>{{ row.database || row.serviceName || '—' }}</div>
              <div v-if="row.type === 'oracle'" class="source-key">Owner / Schema: {{ row.owner || row.name }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="hasPassword" label="认证" width="110" align="center" sortable="custom">
            <template #default="{ row }"><el-tag size="small" :type="row.hasPassword ? 'success' : 'warning'">{{ row.hasPassword ? '已配置密码' : '未配置密码' }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="readOnly" label="访问模式" width="105" align="center" sortable="custom">
            <template #default="{ row }"><el-tag size="small" :type="row.readOnly ? 'info' : 'warning'">{{ row.readOnly ? '只读' : '读写' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :icon="EditPen" :disabled="saving || !!deletingName" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" text type="danger" :icon="Delete" :loading="deletingName === row.name" :disabled="saving || (!!deletingName && deletingName !== row.name)" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty v-if="activeConnections.length && !loading" description="当前引擎中没有匹配的数据库连接" />
            <el-empty v-else-if="!loading && !loadError" :description="connections.length ? `${connectionTypeLabel(activeType)} 暂无连接` : '暂无数据库连接'">
              <el-button type="primary" :icon="Plus" @click="openCreate">{{ connections.length ? `新增 ${connectionTypeLabel(activeType)} 连接` : '新增第一个连接' }}</el-button>
            </el-empty>
          </template>
        </el-table>
      </div>
      <div v-if="connections.length || (!loading && !loadError)" class="list-footer">
        <div class="list-summary">
          <span class="summary-total">{{ connectionTypeLabel(activeType) }} 共 <strong>{{ activeConnections.length }}</strong> 个连接</span>
          <span v-if="keyword.trim()" class="match-count">当前搜索匹配 {{ filteredConnections.length }} 条</span>
          <span v-if="revision" class="revision">配置版本 {{ revision }}</span>
        </div>
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[16, 32, 64, 1000]"
          :total="filteredConnections.length"
          layout="total, sizes, prev, pager, next, jumper"
          class="connection-pagination"
        />
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="isEditing ? '编辑数据库连接' : '新增数据库连接'" width="650px" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @closed="resetForm">
      <el-form label-position="top" class="connection-form">
        <div class="form-grid">
          <el-form-item label="连接名称" required>
            <el-input v-model="form.name" :disabled="isEditing || saving" placeholder="用于查询与权限规则的唯一名称" />
          </el-form-item>
          <el-form-item label="显示名称">
            <el-input v-model="form.label" :disabled="saving" placeholder="可选，默认显示连接名称" />
          </el-form-item>
          <el-form-item label="数据库类型" required>
            <el-select v-model="form.type" :disabled="saving || isEditing" style="width: 100%" @change="onTypeChange">
              <el-option label="MySQL" value="mysql" /><el-option label="Oracle" value="oracle" /><el-option label="Doris" value="doris" />
            </el-select>
          </el-form-item>
          <el-form-item label="主机" required><el-input v-model="form.host" :disabled="saving" placeholder="数据库主机名或 IP" /></el-form-item>
          <el-form-item label="端口" required><el-input-number v-model="form.port" :min="1" :max="65535" :disabled="saving" controls-position="right" style="width: 100%" /></el-form-item>
          <el-form-item label="用户名" required><el-input v-model="form.user" :disabled="saving" /></el-form-item>
          <el-form-item v-if="form.type !== 'oracle'" label="数据库名" required><el-input v-model="form.database" :disabled="saving" /></el-form-item>
          <el-form-item v-if="form.type === 'oracle'" label="Oracle Service Name" required><el-input v-model="form.serviceName" :disabled="saving" placeholder="必须明确填写服务名" /></el-form-item>
          <el-form-item v-else label="字符集"><el-input v-model="form.charset" :disabled="saving" placeholder="例如 utf8mb4" /></el-form-item>
          <el-form-item v-if="form.type === 'oracle'" label="Oracle Owner / Schema">
            <el-input v-model="form.owner" :disabled="saving" placeholder="可选，留空默认使用数据源名称" />
            <span class="field-note">用于 Oracle 元数据和当前 schema；旧配置未设置时也默认使用数据源名称。</span>
          </el-form-item>
          <el-form-item v-if="form.type === 'oracle'" label="行数限制模式"><el-select v-model="form.rowLimit" :disabled="saving" clearable placeholder="自动探测"><el-option label="自动探测" value="" /><el-option label="FETCH (12c+)" value="fetch" /><el-option label="ROWNUM (11g)" value="rownum" /></el-select></el-form-item>
          <el-form-item label="数据库密码" :required="!isEditing">
            <el-input v-model="form.password" type="password" show-password autocomplete="new-password" :disabled="saving" :placeholder="isEditing ? '留空表示保留现有密码；测试连接需输入密码' : '新增连接必须填写密码'" />
            <span v-if="isEditing" class="field-note">密码不会回显。保存时留空保留当前密码；临时连接测试需要输入密码。</span>
          </el-form-item>
          <el-form-item label="访问限制" class="readonly-item"><el-checkbox v-model="form.readOnly" :disabled="saving">只读连接</el-checkbox></el-form-item>
        </div>
        <el-alert v-if="testResult" class="test-result" :type="testResult.ok ? 'success' : 'error'" :closable="false" show-icon>
          <template #title>{{ testResult.ok ? `连接成功 · ${testResult.elapsedMs} ms` : testResult.error || '连接测试失败' }}</template>
        </el-alert>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button :icon="Connection" :loading="testing" :disabled="saving || !!deletingName" @click="testConnection">测试连接</el-button>
          <span class="footer-spacer" />
          <el-button :disabled="saving || testing" @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="testing || !!deletingName" @click="save">{{ isEditing ? '保存修改' : '创建连接' }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.connection-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.toolbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0 14px;
  border-bottom: 1px solid var(--bd-border);
}
.toolbar-copy, .toolbar-actions { display: flex; align-items: center; gap: 12px; min-width: 0; }
.toolbar-actions { flex-shrink: 0; }
.keyword-search { width: 280px; }
.toolbar-title { color: var(--bd-text); font-size: 13px; font-weight: 600; white-space: nowrap; }
.tip { overflow: hidden; color: var(--bd-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.load-error { margin-top: 12px; }
.connection-tabs { flex: 0 0 auto; }
.connection-tabs :deep(.el-tabs__header) { margin: 0; }
.connection-tabs :deep(.el-tabs__content) { display: none; }
.connection-tab-label { display: inline-flex; align-items: center; gap: 7px; }
.list-shell { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
.table-wrap { position: relative; flex: 1; min-height: 0; padding-top: 12px; overflow: hidden; }
.connection-table { width: 100%; height: 100%; }
.connection-table :deep(.el-table__inner-wrapper::before) { display: none; }
.source-name { color: var(--bd-text); font-weight: 600; }
.source-key { margin-top: 3px; color: var(--bd-muted); font-size: 11px; }
.mono { font-family: var(--bd-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.list-footer { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--bd-border); }
.list-summary { display: flex; min-width: 0; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--bd-muted); font-size: 12px; }
.summary-total { color: var(--bd-text); white-space: nowrap; }
.summary-total strong { font-variant-numeric: tabular-nums; }
.match-count { white-space: nowrap; }
.revision { margin-left: 4px; color: var(--bd-muted); font-size: 11px; white-space: nowrap; }
.connection-pagination { flex-shrink: 0; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.connection-form :deep(.el-form-item) { margin-bottom: 14px; }
.connection-form :deep(.el-form-item__label) { padding-bottom: 4px; color: var(--bd-muted); font-size: 12px; }
.connection-form :deep(.el-input__wrapper), .connection-form :deep(.el-select__wrapper) { background: var(--bd-panel); }
.field-note { display: block; margin-top: 5px; color: var(--bd-muted); font-size: 11px; line-height: 1.45; }
.readonly-item { align-self: end; }
.test-result { margin-top: 4px; }
.dialog-footer { display: flex; align-items: center; width: 100%; gap: 8px; }
.footer-spacer { flex: 1; }
@media (max-width: 1050px) {
  .list-footer { align-items: flex-start; flex-direction: column; }
  .connection-pagination { max-width: 100%; flex-wrap: wrap; justify-content: flex-start; }
}
@media (max-width: 700px) {
  .toolbar { align-items: flex-start; flex-direction: column; }
  .toolbar-copy { align-items: flex-start; flex-direction: column; gap: 4px; }
  .toolbar-actions { width: 100%; flex-wrap: wrap; }
  .keyword-search { width: 100%; }
  .form-grid { grid-template-columns: 1fr; }
}
</style>
