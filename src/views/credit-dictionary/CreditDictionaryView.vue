<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search, CopyDocument, ArrowRight } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import TableToolbar from '@/components/TableToolbar.vue'
import dictionaryData from '@/data/credit-dictionary.json'

interface CreditField {
  label: string
  name: string
  type: string
  length: string
  status: string
  description: string
}

interface CreditTable {
  name: string
  title: string
  code: string
  group: string
  tableGroup: string
  segment: string
  status: string
  key: string
  fields: CreditField[]
}

interface CreditDictionary {
  name: string
  rows: string[][]
}

interface ReportIndexEntry {
  group: string
  tableGroup: string
  segment: string
  status: string
  code: string
}

interface SearchResult {
  table: CreditTable
  tableIndex: number
  segment: string
  code: string
  tableHit: boolean
  fields: CreditField[]
}

const DATA = dictionaryData as {
  tables: CreditTable[]
  dictionaries: CreditDictionary[]
  index: ReportIndexEntry[]
}

type Pane = 'search' | 'fields' | 'dict' | 'index' | 'mapping'
const panes: Array<{ id: Pane; label: string }> = [
  { id: 'search', label: '全文搜索' },
  { id: 'fields', label: '接口字段' },
  { id: 'dict', label: '代码字典' },
  { id: 'index', label: '接口全览' },
  { id: 'mapping', label: '字典映射' }
]
const activePane = ref<Pane>('search')
const query = ref('')
const selectedTableIndex = ref(0)
const selectedDictionaryIndex = ref(0)
const focusedField = ref('')
const dictionaryPage = ref(1)
const dictionaryPageSize = 100
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())

function normalized(value: unknown) {
  return String(value ?? '').toLocaleLowerCase()
}

function tableIndexForEntry(entry: ReportIndexEntry) {
  const byCode = DATA.tables.findIndex(
    (table) => !!entry.code && !!table.code && normalized(table.code) === normalized(entry.code)
  )
  if (byCode >= 0) return byCode
  const chineseName = entry.segment.replace(/[（(].*$/, '').trim()
  return DATA.tables.findIndex((table) => table.name === chineseName)
}

function reportEntryForTable(tableIndex: number) {
  return DATA.index.find((entry) => tableIndexForEntry(entry) === tableIndex)
}

function tableCode(table: CreditTable, tableIndex: number) {
  if (table.code) return table.code
  const segment = reportEntryForTable(tableIndex)?.segment || table.title
  return segment.match(/[（(]\s*([^）)]+)\s*[）)]/)?.[1] || ''
}

function includesQuery(values: unknown[]) {
  return normalized(values.join(' ')).includes(normalizedQuery.value)
}

const currentTable = computed(() => DATA.tables[selectedTableIndex.value] || DATA.tables[0])
const currentDictionary = computed(
  () => DATA.dictionaries[selectedDictionaryIndex.value] || DATA.dictionaries[0]
)

const filteredTables = computed(() =>
  DATA.tables
    .map((table, tableIndex) => ({ table, tableIndex }))
    .filter(({ table }) => {
      if (!normalizedQuery.value) return true
      return includesQuery([
        table.name,
        table.title,
        table.code,
        table.group,
        table.tableGroup,
        table.key,
        ...table.fields.flatMap((field) => [
          field.label,
          field.name,
          field.type,
          field.length,
          field.status,
          field.description
        ])
      ])
    })
)

const tableNameHit = computed(() => {
  if (!normalizedQuery.value || !currentTable.value) return false
  const entry = reportEntryForTable(selectedTableIndex.value)
  return includesQuery([
    currentTable.value.name,
    currentTable.value.title,
    currentTable.value.code,
    entry?.segment,
    currentTable.value.key
  ])
})

const visibleFields = computed(() => {
  if (!normalizedQuery.value || tableNameHit.value) return currentTable.value?.fields || []
  return (currentTable.value?.fields || []).filter((field) =>
    includesQuery([field.label, field.name, field.type, field.length, field.status, field.description])
  )
})

const filteredDictionaries = computed(() =>
  DATA.dictionaries
    .map((dictionary, dictionaryIndex) => ({ dictionary, dictionaryIndex }))
    .filter(({ dictionary }) =>
      !normalizedQuery.value ||
      includesQuery([dictionary.name, ...dictionary.rows.flat()])
    )
)

const dictionaryRows = computed(() => {
  const rows = currentDictionary.value?.rows.slice(1) || []
  if (!normalizedQuery.value || includesQuery([currentDictionary.value?.name])) return rows
  return rows.filter((row, index) => index === 0 || includesQuery(row))
})

const visibleDictionaryRows = computed(() => {
  const start = (dictionaryPage.value - 1) * dictionaryPageSize
  return dictionaryRows.value.slice(start, start + dictionaryPageSize)
})
const dictionaryPageCount = computed(() =>
  Math.max(1, Math.ceil(dictionaryRows.value.length / dictionaryPageSize))
)

const tableOverview = computed(() =>
  DATA.tables
    .map((table, tableIndex) => ({ table, tableIndex, segment: reportEntryForTable(tableIndex)?.segment || '' }))
    .filter(({ table, segment, tableIndex }) =>
      !normalizedQuery.value ||
      includesQuery([table.name, table.title, tableCode(table, tableIndex), segment])
    )
)

const searchResults = computed<SearchResult[]>(() => {
  if (!normalizedQuery.value) return []
  return DATA.tables
    .map((table, tableIndex) => {
      const segment = reportEntryForTable(tableIndex)?.segment || ''
      const code = tableCode(table, tableIndex)
      const tableHit = includesQuery([
        table.name,
        table.title,
        code,
        segment,
        table.group,
        table.tableGroup,
        table.key
      ])
      const fields = table.fields.filter((field) =>
        includesQuery([field.label, field.name, field.type, field.length, field.status, field.description])
      )
      return { table, tableIndex, segment, code, tableHit, fields }
    })
    .filter((result) => result.tableHit || result.fields.length > 0)
})

function dictionaryFor(field: CreditField) {
  const label = normalized(field.label)
  if (label.includes('通讯地址')) return '通讯地址行政区划'
  if (label.includes('户籍所在地')) return '户籍所在地行政区划'
  if (label.includes('行政区划')) return '行政区划'
  return (
    DATA.dictionaries.find((dictionary) => normalized(dictionary.name) === label)?.name ||
    DATA.dictionaries.find((dictionary) => label.includes(normalized(dictionary.name)))?.name ||
    ''
  )
}

const currentDictionaryReferences = computed(() => {
  const references: Array<{ table: string; tableIndex: number; label: string; name: string }> = []
  DATA.tables.forEach((table, tableIndex) => {
    table.fields.forEach((field) => {
      if (dictionaryFor(field) === currentDictionary.value?.name) {
        references.push({ table: table.name, tableIndex, label: field.label, name: field.name })
      }
    })
  })
  return references
})

function setPane(pane: Pane) {
  if (pane === 'index') {
    query.value = ''
    focusedField.value = ''
  }
  activePane.value = pane
}

function openTable(tableIndex: number) {
  selectedTableIndex.value = tableIndex
  focusedField.value = ''
  query.value = ''
  activePane.value = 'fields'
}

async function openReferencedField(reference: { tableIndex: number; name: string }) {
  selectedTableIndex.value = reference.tableIndex
  query.value = ''
  activePane.value = 'fields'
  await nextTick()
  focusedField.value = reference.name
  await nextTick()
  document.querySelector('.field-focus')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function openFieldDictionary(field: CreditField) {
  const dictionaryName = dictionaryFor(field)
  const dictionaryIndex = DATA.dictionaries.findIndex((dictionary) => dictionary.name === dictionaryName)
  if (dictionaryIndex < 0) return
  selectedDictionaryIndex.value = dictionaryIndex
  dictionaryPage.value = 1
  activePane.value = 'dict'
}

function selectTable(tableIndex: number) {
  selectedTableIndex.value = tableIndex
  focusedField.value = ''
}

function selectDictionary(dictionaryIndex: number) {
  selectedDictionaryIndex.value = dictionaryIndex
  dictionaryPage.value = 1
}

function setDictionaryPage(page: number) {
  dictionaryPage.value = Math.max(1, Math.min(dictionaryPageCount.value, page))
}

async function copyField(name: string) {
  try {
    await navigator.clipboard.writeText(name)
    ElMessage.success('字段名已复制')
  } catch {
    ElMessage.warning(`无法访问剪贴板，请手动复制：${name}`)
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
    event.preventDefault()
    document.querySelector<HTMLInputElement>('.dictionary-search input')?.focus()
  }
  if (event.key === 'Escape' && document.activeElement?.matches('.dictionary-search input')) {
    query.value = ''
  }
}

watch(query, () => {
  focusedField.value = ''
  dictionaryPage.value = 1
  if (activePane.value === 'fields' && filteredTables.value.length) {
    if (!filteredTables.value.some((item) => item.tableIndex === selectedTableIndex.value)) {
      selectedTableIndex.value = filteredTables.value[0].tableIndex
    }
  }
  if (activePane.value === 'dict' && filteredDictionaries.value.length) {
    if (!filteredDictionaries.value.some((item) => item.dictionaryIndex === selectedDictionaryIndex.value)) {
      selectedDictionaryIndex.value = filteredDictionaries.value[0].dictionaryIndex
    }
  }
})

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))
</script>

<template>
  <div class="credit-dictionary-view">
    <TableToolbar :show-density="false" :show-refresh="false">
      <el-input
        v-model="query"
        class="dictionary-search"
        clearable
        :prefix-icon="Search"
        placeholder="搜索接口、字段名、类型、说明或代码值…"
      />
      <span class="search-hint">/ 搜索 · Esc 清空</span>
    </TableToolbar>

    <nav class="dictionary-tabs" aria-label="征信数据字典导航">
      <button
        v-for="pane in panes"
        :key="pane.id"
        type="button"
        class="dictionary-tab"
        :class="{ active: activePane === pane.id }"
        @click="setPane(pane.id)"
      >
        {{ pane.label }}
      </button>
    </nav>

    <section v-if="activePane === 'search'" class="panel search-panel">
      <header class="panel-head">
        <div>
          <h2>全文搜索</h2>
          <p>接口名、报文标识、字段名、类型、长度、状态、说明与业务主键</p>
        </div>
        <el-tag v-if="normalizedQuery" effect="plain">{{ searchResults.length }} 个接口</el-tag>
        <span v-else class="panel-hint">30 张接口表 · 421 个字段</span>
      </header>
      <div class="content-scroll search-results">
        <div v-if="!normalizedQuery" class="empty-state">
          <el-icon><Search /></el-icon>
          <strong>输入关键词开始查找</strong>
          <span>结果按接口归组，点击接口即可进入字段模型。</span>
        </div>
        <div v-else-if="searchResults.length === 0" class="empty-state">
          <strong>没有找到匹配接口</strong>
          <span>试试字段中文名、系统字段名或说明中的关键词。</span>
        </div>
        <article v-for="result in searchResults" :key="result.tableIndex" class="search-result">
          <header class="search-result-head">
            <div class="search-result-title">
              <strong>{{ result.table.name }}</strong>
              <span>{{ result.code || result.segment }}</span>
            </div>
            <el-button type="primary" plain size="small" @click="openTable(result.tableIndex)">
              打开接口模型 <el-icon><ArrowRight /></el-icon>
            </el-button>
          </header>
          <div v-if="result.fields.length" class="search-hit-list">
            <div v-for="field in result.fields.slice(0, 5)" :key="field.name" class="search-hit">
              <div class="search-hit-name">
                <strong>{{ field.label }}</strong>
                <code>{{ field.name }}</code>
                <el-tag size="small" effect="plain">{{ field.type }}</el-tag>
              </div>
              <p v-if="field.description">{{ field.description }}</p>
            </div>
            <span v-if="result.fields.length > 5" class="more-hits">
              另有 {{ result.fields.length - 5 }} 个字段命中
            </span>
          </div>
          <p v-else class="table-match-hint">接口名称、标识或主键信息匹配</p>
        </article>
      </div>
    </section>

    <section v-else-if="activePane === 'fields'" class="split-view">
      <aside class="panel side-panel">
        <div class="side-head"><strong>接口表</strong><span>{{ filteredTables.length }} / {{ DATA.tables.length }}</span></div>
        <div class="side-scroll">
          <button
            v-for="item in filteredTables"
            :key="item.tableIndex"
            type="button"
            class="side-item"
            :class="{ active: selectedTableIndex === item.tableIndex }"
            @click="selectTable(item.tableIndex)"
          >
            <span>{{ item.table.name }}</span>
            <small>{{ item.table.fields.length }} 个字段</small>
          </button>
          <div v-if="!filteredTables.length" class="side-empty">没有匹配的接口表</div>
        </div>
      </aside>

      <main v-if="currentTable" class="panel model-panel">
        <header class="panel-head">
          <div>
            <h2>{{ currentTable.name }}</h2>
            <p>{{ tableCode(currentTable, selectedTableIndex) }}<span v-if="currentTable.group"> · {{ currentTable.group }}</span></p>
          </div>
          <el-tag effect="plain">{{ visibleFields.length }} / {{ currentTable.fields.length }} 字段</el-tag>
        </header>
        <div v-if="currentTable.key" class="business-key"><strong>业务主键</strong><code>{{ currentTable.key }}</code></div>
        <div class="content-scroll field-table-scroll">
          <table class="field-table">
            <thead>
              <tr><th>数据项名称</th><th>本系统字段名</th><th>数据类型</th><th>长度</th><th>状态</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="field in visibleFields"
                :key="field.name"
                :class="{ 'field-focus': focusedField === field.name }"
              >
                <td class="field-label">{{ field.label }}</td>
                <td class="field-name">
                  <code>{{ field.name }}</code>
                  <el-button link type="primary" :icon="CopyDocument" aria-label="复制字段名" @click="copyField(field.name)" />
                </td>
                <td>{{ field.type }}</td>
                <td>{{ field.length }}</td>
                <td><el-tag v-if="field.status === 'M'" size="small" type="success" effect="plain">必填</el-tag><span v-else>{{ field.status }}</span></td>
                <td class="field-description">
                  <span>{{ field.description }}</span>
                  <el-button v-if="dictionaryFor(field)" link type="primary" @click="openFieldDictionary(field)">
                    查看代码字典 <el-icon><ArrowRight /></el-icon>
                  </el-button>
                </td>
              </tr>
              <tr v-if="!visibleFields.length"><td colspan="6" class="table-empty">当前接口没有匹配字段</td></tr>
            </tbody>
          </table>
        </div>
      </main>
    </section>

    <section v-else-if="activePane === 'dict'" class="split-view">
      <aside class="panel side-panel">
        <div class="side-head"><strong>代码字典</strong><span>{{ filteredDictionaries.length }} / {{ DATA.dictionaries.length }}</span></div>
        <div class="side-scroll">
          <button
            v-for="item in filteredDictionaries"
            :key="item.dictionaryIndex"
            type="button"
            class="side-item"
            :class="{ active: selectedDictionaryIndex === item.dictionaryIndex }"
            @click="selectDictionary(item.dictionaryIndex)"
          >
            <span>{{ item.dictionary.name }}</span>
            <small>{{ Math.max(0, item.dictionary.rows.length - 1) }} 条</small>
          </button>
          <div v-if="!filteredDictionaries.length" class="side-empty">没有匹配的字典</div>
        </div>
      </aside>

      <main v-if="currentDictionary" class="panel model-panel">
        <header class="panel-head">
          <div><h2>{{ currentDictionary.name }}</h2><p>{{ dictionaryRows.length }} 条内容</p></div>
          <el-tag effect="plain">{{ currentDictionary.rows.length }} 行</el-tag>
        </header>
        <div v-if="currentDictionaryReferences.length" class="reference-strip">
          <strong>引用字段</strong>
          <el-button
            v-for="reference in currentDictionaryReferences"
            :key="`${reference.tableIndex}-${reference.name}`"
            link
            type="primary"
            @click="openReferencedField(reference)"
          >
            {{ reference.table }} · {{ reference.label }}
          </el-button>
        </div>
        <div class="dictionary-pagination">
          <span>第 {{ dictionaryPage }} / {{ dictionaryPageCount }} 页</span>
          <div>
            <el-button size="small" :disabled="dictionaryPage <= 1" @click="setDictionaryPage(dictionaryPage - 1)">上一页</el-button>
            <el-button size="small" :disabled="dictionaryPage >= dictionaryPageCount" @click="setDictionaryPage(dictionaryPage + 1)">下一页</el-button>
          </div>
        </div>
        <div class="content-scroll dictionary-rows">
          <article v-for="(row, index) in visibleDictionaryRows" :key="`${dictionaryPage}-${index}`" class="dictionary-row">
            <template v-for="(value, cellIndex) in row" :key="cellIndex">
              <div v-if="value" class="dictionary-cell">{{ value }}</div>
            </template>
          </article>
          <div v-if="!visibleDictionaryRows.length" class="table-empty">没有匹配的字典内容</div>
        </div>
      </main>
    </section>

    <section v-else-if="activePane === 'index'" class="panel overview-panel">
      <header class="panel-head">
        <div><h2>接口模型全览</h2><p>点击接口表名，查看字段结构与代码字典</p></div>
        <el-tag effect="plain">{{ tableOverview.length }} / {{ DATA.tables.length }} 张接口表</el-tag>
      </header>
      <div class="content-scroll overview-grid">
        <button
          v-for="item in tableOverview"
          :key="item.tableIndex"
          type="button"
          class="overview-card"
          @click="openTable(item.tableIndex)"
        >
          <span class="overview-name">{{ item.table.name }}</span>
          <span class="overview-code">{{ tableCode(item.table, item.tableIndex) || '报文标识未提供' }}</span>
          <span class="overview-count">{{ item.table.fields.length }} 个字段 <el-icon><ArrowRight /></el-icon></span>
        </button>
        <div v-if="!tableOverview.length" class="table-empty">没有匹配的接口表</div>
      </div>
    </section>

    <section v-else class="panel mapping-panel">
      <el-empty description="源工作簿的“数据字典映射关系”页目前只有表头，补充映射内容后可在此查询" />
    </section>
  </div>
</template>

<style scoped lang="scss">
.credit-dictionary-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  color: $text;
}

.dictionary-search {
  width: min(620px, 100%);
}

.search-hint,
.panel-hint {
  color: $muted;
  font-size: 12px;
  white-space: nowrap;
}

.dictionary-tabs {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
  overflow-x: auto;
  border-bottom: 1px solid $border;
}

.dictionary-tab {
  position: relative;
  padding: 9px 13px;
  border: 0;
  background: transparent;
  color: $muted;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.dictionary-tab:hover,
.dictionary-tab.active {
  color: $primary;
}

.dictionary-tab.active {
  font-weight: 650;
}

.dictionary-tab.active::after {
  position: absolute;
  right: 10px;
  bottom: -1px;
  left: 10px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: $primary;
  content: '';
}

.panel,
.side-panel {
  min-height: 0;
  border: 1px solid $border;
  border-radius: 10px;
  background: $panel;
  box-shadow: 0 2px 8px color-mix(in srgb, $primary 4%, transparent);
  overflow: hidden;
}

.search-panel,
.model-panel,
.overview-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex: 0 0 auto;
  padding: 14px 17px;
  border-bottom: 1px solid $border;
}

.panel-head h2 {
  margin: 0;
  color: $text;
  font-size: 17px;
  font-weight: 650;
}

.panel-head p {
  margin: 4px 0 0;
  color: $muted;
  font-size: 12px;
}

.content-scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
}

.empty-state {
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: $muted;
  text-align: center;
}

.empty-state .el-icon {
  color: $primary;
  font-size: 25px;
}

.empty-state strong {
  color: $text;
  font-size: 14px;
}

.empty-state span {
  font-size: 12px;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.search-result {
  flex: 0 0 auto;
  padding: 12px 14px;
  border: 1px solid $border;
  border-radius: 9px;
}

.search-result-head,
.search-result-title,
.search-hit-name {
  display: flex;
  align-items: center;
  gap: 9px;
}

.search-result-head {
  justify-content: space-between;
}

.search-result-title {
  flex-wrap: wrap;
}

.search-result-title strong {
  font-size: 14px;
}

.search-result-title span,
.search-hit-name code,
.field-name code,
.business-key code {
  color: $primary;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}

.search-hit-list {
  display: grid;
  gap: 5px;
  margin-top: 10px;
}

.search-hit {
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--bd-panel-sub);
  font-size: 12px;
}

.search-hit-name strong {
  font-weight: 650;
}

.search-hit p {
  margin: 4px 0 0;
  color: $muted;
  white-space: pre-wrap;
}

.more-hits,
.table-match-hint {
  color: $muted;
  font-size: 11px;
}

.table-match-hint {
  margin: 8px 0 0;
}

.split-view {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: minmax(210px, 250px) minmax(0, 1fr);
  gap: 12px;
  overflow: hidden;
}

.side-panel {
  display: flex;
  flex-direction: column;
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  padding: 12px 14px;
  border-bottom: 1px solid $border;
  font-size: 13px;
}

.side-head span {
  color: $muted;
  font-size: 11px;
}

.side-scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 6px;
}

.side-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text;
  text-align: left;
  cursor: pointer;
}

.side-item:hover {
  background: var(--bd-panel-sub);
}

.side-item.active {
  background: var(--bd-primary-soft);
  color: $primary;
  font-weight: 600;
}

.side-item small {
  color: $muted;
  font-size: 10px;
  font-weight: 400;
}

.side-empty,
.table-empty {
  padding: 30px 14px;
  color: $muted;
  text-align: center;
  font-size: 12px;
}

.model-panel {
  overflow: hidden;
}

.business-key {
  display: flex;
  flex: 0 0 auto;
  align-items: baseline;
  gap: 12px;
  margin: 10px 14px 0;
  padding: 9px 11px;
  border-radius: 7px;
  background: var(--bd-panel-sub);
  font-size: 12px;
}

.business-key strong {
  color: $muted;
  white-space: nowrap;
}

.field-table-scroll {
  margin-top: 9px;
}

.field-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.field-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bd-table-header);
  color: $muted;
  font-weight: 650;
  text-align: left;
}

.field-table th,
.field-table td {
  padding: 9px 11px;
  border-bottom: 1px solid $border;
  vertical-align: top;
}

.field-table tr:hover td {
  background: var(--bd-table-hover);
}

.field-table tr.field-focus td {
  background: color-mix(in srgb, var(--bd-primary) 12%, var(--bd-panel));
}

.field-label {
  min-width: 130px;
  font-weight: 600;
}

.field-name {
  min-width: 145px;
  white-space: nowrap;
}

.field-name .el-button {
  margin-left: 4px;
}

.field-description {
  min-width: 220px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.field-description .el-button {
  display: flex;
  height: auto;
  margin-top: 4px;
  padding: 0;
  font-size: 11px;
}

.reference-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  padding: 8px 14px;
  border-bottom: 1px solid $border;
  color: $muted;
  font-size: 11px;
}

.reference-strip strong {
  color: $text;
}

.dictionary-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 0 0 auto;
  padding: 7px 13px;
  color: $muted;
  font-size: 11px;
}

.dictionary-rows {
  padding: 0 12px 12px;
}

.dictionary-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 6px;
  padding: 9px 0;
  border-bottom: 1px solid $border;
}

.dictionary-cell {
  padding: 6px 8px;
  border-radius: 5px;
  background: var(--bd-panel-sub);
  color: $text;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.overview-panel {
  flex: 1;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  align-content: start;
  gap: 10px;
  padding: 14px;
}

.overview-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 13px 14px;
  border: 1px solid $border;
  border-radius: 9px;
  background: $panel;
  color: $text;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease, transform 0.16s ease;
}

.overview-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, $primary 44%, $border);
  background: var(--bd-primary-soft);
}

.overview-name {
  font-size: 13px;
  font-weight: 650;
}

.overview-code {
  color: $muted;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  overflow-wrap: anywhere;
}

.overview-count {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  color: $primary;
  font-size: 11px;
}

.mapping-panel {
  flex: 1;
  display: grid;
  place-items: center;
}

@media (max-width: 760px) {
  .credit-dictionary-view {
    padding: 10px;
  }

  .split-view {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(120px, 28%) minmax(0, 1fr);
  }

  .side-scroll {
    display: flex;
    gap: 4px;
  }

  .side-item {
    width: max-content;
    min-width: 130px;
  }

  .search-hint {
    display: none;
  }

  .overview-grid {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}

@media (max-width: 480px) {
  .panel-head {
    padding: 11px 12px;
  }

  .overview-grid {
    grid-template-columns: 1fr;
  }

  .field-table {
    min-width: 760px;
  }
}
</style>
