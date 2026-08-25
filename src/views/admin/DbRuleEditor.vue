<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Delete } from '@element-plus/icons-vue'
import { listTables } from '@/api/db'

/** v2 规则对象(与 db-permissions.json 一致) */
export interface DbRuleV2 {
  engineRules: Array<{ engine: string; db: string; tables: string[] | null; read: boolean; write: boolean }>
  spark: { read: boolean; write: boolean } | null
  flink: { enabled: boolean } | null
}

interface EngRuleRow {
  engine: string
  db: string
  tables: string[]
  read: boolean
  write: boolean
  tableOptions: string[]
  tableLoading: boolean
}

const props = defineProps<{
  modelValue: boolean
  subject: string
  subjectKind: 'user' | 'role'
  initial: DbRuleV2 | null
  dbOptions: string[]
  /** 新增时可选主体(已配置规则的主体不再重复提供) */
  subjectOptions?: Array<{ value: string; label: string }>
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'save', subject: string, rule: DbRuleV2): void
}>()

const ENGINE_OPTIONS = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'oracle', label: 'Oracle' },
  { value: '*', label: '全部引擎' }
]

const form = reactive<{
  engineRules: EngRuleRow[]
  sparkOn: boolean
  sparkRead: boolean
  sparkWrite: boolean
  flinkOn: boolean
}>({
  engineRules: [],
  sparkOn: false,
  sparkRead: true,
  sparkWrite: false,
  flinkOn: false
})

const selectedSubject = ref(props.subject)

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      selectedSubject.value = props.subject
      init()
    }
  }
)

function init() {
  const r = props.initial
  form.engineRules = (r?.engineRules?.length
    ? r.engineRules
    : [{ engine: 'mysql', db: '', tables: [], read: true, write: false }]
  ).map((x) => ({
    engine: x.engine || 'mysql',
    db: x.db || '',
    tables: [...(x.tables || [])],
    read: x.read !== false,
    write: x.write === true,
    tableOptions: [] as string[],
    tableLoading: false
  }))
  form.sparkOn = !!r?.spark
  form.sparkRead = r?.spark?.read ?? true
  form.sparkWrite = r?.spark?.write ?? false
  form.flinkOn = !!r?.flink
}

function addEngRule() {
  form.engineRules.push({ engine: 'mysql', db: '', tables: [], read: true, write: false, tableOptions: [], tableLoading: false })
}

function removeEngRule(i: number) {
  form.engineRules.splice(i, 1)
}

/** 选中库后按需加载表列表(admin 编辑时可见全部表);「所有库」无表级概念 */
async function loadTablesFor(row: EngRuleRow) {
  if (!row.db || row.db === '*') {
    row.tableOptions = []
    return
  }
  row.tableLoading = true
  try {
    row.tableOptions = (await listTables(row.db)).map((t) => (typeof t === 'string' ? t : t.name))
  } catch {
    row.tableOptions = []
  } finally {
    row.tableLoading = false
  }
}

function save() {
  const subject = (selectedSubject.value || props.subject || '').trim()
  if (!subject) return ElMessage.warning(`请先选择${props.subjectKind === 'user' ? '用户' : '角色'}`)
  if (!form.engineRules.length && !form.sparkOn && !form.flinkOn) {
    return ElMessage.warning('至少配置一项权限(引擎规则 / Spark / Flink)')
  }
  for (const er of form.engineRules) {
    if (!er.db) return ElMessage.warning('引擎规则需选择数据库')
    if (!er.read && !er.write) return ElMessage.warning(`数据库「${er.db}」需至少勾选读或写`)
  }
  emit('save', subject, {
    engineRules: form.engineRules.map((er) => ({
      engine: er.engine,
      db: er.db,
      tables: er.tables.length ? [...er.tables] : null,
      read: er.read,
      write: er.write
    })),
    spark: form.sparkOn ? { read: form.sparkRead, write: form.sparkWrite } : null,
    flink: form.flinkOn ? { enabled: true } : null
  })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`${subjectKind === 'user' ? '用户' : '角色'}权限: ${selectedSubject || '(新增)'}`"
    width="720px"
    top="6vh"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="rule-editor">
      <!-- 新增时先选主体 -->
      <div v-if="!selectedSubject" class="rule-subject-row">
        <span class="rule-section-title">选择{{ subjectKind === 'user' ? '用户' : '角色' }}</span>
        <el-select v-model="selectedSubject" filterable style="width: 240px" :placeholder="`选择${subjectKind === 'user' ? '用户' : '角色'}`">
          <el-option v-for="o in subjectOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <!-- 引擎规则(mysql/oracle:库+表+读写) -->
      <div class="rule-section">
        <div class="rule-section-head">
          <span class="rule-section-title">引擎规则(MySQL / Oracle)</span>
          <el-button size="small" text type="primary" :icon="Plus" @click="addEngRule">加一条</el-button>
        </div>
        <div v-for="(er, i) in form.engineRules" :key="i" class="eng-rule-row">
          <el-select v-model="er.engine" size="small" style="width: 110px" placeholder="引擎">
            <el-option v-for="o in ENGINE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select
            v-model="er.db"
            size="small"
            filterable
            style="width: 200px"
            placeholder="数据库"
            @change="loadTablesFor(er)"
          >
            <el-option label="所有库" value="*" />
            <el-option v-for="d in dbOptions" :key="d" :label="d" :value="d" />
          </el-select>
          <el-select
            v-model="er.tables"
            size="small"
            multiple
            filterable
            collapse-tags
            :loading="er.tableLoading"
            style="width: 230px"
            placeholder="表(留空=全部)"
            :disabled="!er.db || er.db === '*'"
          >
            <el-option v-for="t in er.tableOptions" :key="t" :label="t" :value="t" />
          </el-select>
          <el-checkbox v-model="er.read" class="rw-cb">读</el-checkbox>
          <el-checkbox v-model="er.write" class="rw-cb">写</el-checkbox>
          <el-button size="small" text type="danger" :icon="Delete" :disabled="form.engineRules.length <= 1" @click="removeEngRule(i)" />
        </div>
        <div class="rule-tip">表留空 = 该库全部表;选「所有库」= 不限库(含后续新增库);勾「写」允许 INSERT/UPDATE/DELETE/DDL。</div>
      </div>

      <!-- Spark 权限 -->
      <div class="rule-section">
        <div class="rule-section-head">
          <span class="rule-section-title">Spark(SparkSQL / PySpark)</span>
          <el-switch v-model="form.sparkOn" size="small" />
        </div>
        <template v-if="form.sparkOn">
          <el-checkbox v-model="form.sparkRead" class="rw-cb">允许只读查询</el-checkbox>
          <el-checkbox v-model="form.sparkWrite" class="rw-cb">允许写操作 / PySpark 代码</el-checkbox>
        </template>
        <div v-else class="rule-tip">未启用:该用户不可使用 Spark 引擎(admin 不受限)。</div>
      </div>

      <!-- Flink 使用权限 -->
      <div class="rule-section">
        <div class="rule-section-head">
          <span class="rule-section-title">Flink(流/批任务)</span>
          <el-switch v-model="form.flinkOn" size="small" />
        </div>
        <div v-if="!form.flinkOn" class="rule-tip">未启用:该用户不可使用 Flink 引擎(admin 不受限)。</div>
      </div>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rule-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 60vh;
  overflow: auto;
  padding-right: 4px;
}
.rule-section {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 10px;
}
.rule-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.rule-section-title {
  font-size: 13px;
  font-weight: 600;
}
.eng-rule-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.eng-rule-row:last-child {
  margin-bottom: 0;
}
.rw-cb {
  margin-right: 8px;
  white-space: nowrap;
}
.rule-tip {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}
</style>
