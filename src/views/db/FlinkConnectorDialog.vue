<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Refresh, MagicStick } from '@element-plus/icons-vue'
import { flinkConnectors, flinkProbeSchema, flinkGenerateDdl, type FlinkConnector, type FlinkField } from '@/api/db'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'insert', ddls: string[]): void
}>()

const connectors = ref<FlinkConnector[]>([])
const checked = ref<Record<string, boolean>>({})
const params = ref<Record<string, Record<string, string>>>({})
const fields = ref<Record<string, FlinkField[]>>({})
const tableNames = ref<Record<string, string>>({})
const probing = ref<Record<string, boolean>>({})
const generating = ref(false)

/** 无探测能力的连接器给默认字段模板 */
function defaultFields(c: FlinkConnector): FlinkField[] {
  switch (c.type) {
    case 'kafka':
      return [{ name: 'id', type: 'BIGINT', comment: '' }, { name: 'data', type: 'STRING', comment: 'JSON 数据体' }]
    case 'hbase-2.2':
    case 'hbase':
      return [
        { name: 'rowkey', type: 'STRING', primaryKey: true, comment: '' },
        { name: 'f', type: 'ROW<col1 STRING, col2 STRING>', comment: '列族,按需修改' },
      ]
    default:
      return [{ name: 'id', type: 'BIGINT', comment: '' }]
  }
}

async function load() {
  try {
    const list = await flinkConnectors()
    connectors.value = list
    for (const c of list) {
      tableNames.value[c.name] = tableNames.value[c.name] || `src_${c.name}`
      params.value[c.name] = params.value[c.name] || {}
      for (const d of c.dynamicFields) {
        if (!(d.key in params.value[c.name])) params.value[c.name][d.key] = ''
      }
      if (!fields.value[c.name]?.length) fields.value[c.name] = defaultFields(c)
    }
  } catch (e) {
    ElMessage.error(`加载连接器失败:${e instanceof Error ? e.message : e}`)
  }
}

watch(() => props.modelValue, (v) => { if (v) void load() })

async function probe(name: string) {
  probing.value[name] = true
  try {
    const res = await flinkProbeSchema(name, params.value[name])
    fields.value[name] = res.fields
    ElMessage.success(`探测到 ${res.fields.length} 个字段`)
  } catch (e) {
    ElMessage.error(`探测失败:${e instanceof Error ? e.message : e}`)
  } finally {
    probing.value[name] = false
  }
}

function addField(name: string) {
  fields.value[name].push({ name: '', type: 'STRING', comment: '' })
}

function removeField(name: string, idx: number) {
  fields.value[name].splice(idx, 1)
}

async function generate() {
  const ddls: string[] = []
  for (const c of connectors.value) {
    if (!checked.value[c.name]) continue
    const fs = (fields.value[c.name] || []).filter((f) => f.name?.trim() && f.type?.trim())
    if (!fs.length) {
      ElMessage.warning(`${c.label}:请至少填写一个字段`)
      return
    }
    const p: Record<string, string> = {}
    for (const [k, v] of Object.entries(params.value[c.name] || {})) {
      if (v) p[k] = v
    }
    try {
      const { ddl } = await flinkGenerateDdl(
        tableNames.value[c.name] || `src_${c.name}`,
        c.name,
        p,
        fs.map((f) => ({ ...f }))
      )
      ddls.push(ddl)
    } catch (e) {
      ElMessage.error(`${c.label} 生成失败:${e instanceof Error ? e.message : e}`)
      return
    }
  }
  if (!ddls.length) {
    ElMessage.warning('请至少勾选一个连接器')
    return
  }
  emit('insert', ddls)
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Flink 连接器 · 批量建表"
    width="720px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="conn-tip">
      <el-icon color="var(--bd-primary)"><MagicStick /></el-icon>
      <span>勾选多个连接器 → 填参数 → 自动生成 CREATE TABLE,插入编辑器。join 逻辑请自行编写(批模式即席查询 / 流模式提交常驻任务)。</span>
    </div>

    <div v-for="c in connectors" :key="c.name" class="conn-card" :class="{ active: checked[c.name] }">
      <div class="conn-head" @click="checked[c.name] = !checked[c.name]">
        <el-checkbox :model-value="!!checked[c.name]" @change="(v: boolean | string | number) => (checked[c.name] = !!v)">
          <span class="conn-label">{{ c.label }}</span>
          <span class="conn-type">{{ c.type }}</span>
        </el-checkbox>
      </div>

      <template v-if="checked[c.name]">
        <div class="conn-body">
          <div class="field-row">
            <label class="f-label">表名</label>
            <el-input v-model="tableNames[c.name]" size="small" class="f-input" placeholder="如 src_mysql_trade" />
          </div>
          <div v-for="d in c.dynamicFields" :key="d.key" class="field-row">
            <label class="f-label">{{ d.label }}</label>
            <el-input v-model="params[c.name][d.key]" size="small" class="f-input" :placeholder="d.placeholder || d.key" />
          </div>

          <div class="fields-head">
            <span class="fields-title">字段定义</span>
            <span class="fields-actions">
              <el-button v-if="c.probe" size="small" text type="primary" :loading="probing[c.name]" :icon="Refresh" @click="probe(c.name)">
                自动探测(mysql-cdc)
              </el-button>
              <el-button size="small" text type="primary" :icon="Plus" @click="addField(c.name)">加字段</el-button>
            </span>
          </div>
          <el-table :data="fields[c.name] || []" size="small" border class="fields-table">
            <el-table-column label="字段名" min-width="150">
              <template #default="{ row }">
                <el-input v-model="row.name" size="small" placeholder="col_name" />
              </template>
            </el-table-column>
            <el-table-column label="类型" min-width="180">
              <template #default="{ row }">
                <el-input v-model="row.type" size="small" placeholder="BIGINT / STRING / ROW<...>" />
              </template>
            </el-table-column>
            <el-table-column label="主键" width="70" align="center">
              <template #default="{ row }">
                <el-checkbox v-model="row.primaryKey" />
              </template>
            </el-table-column>
            <el-table-column label="" width="60" align="center">
              <template #default="{ $index }">
                <el-button text type="danger" size="small" @click="removeField(c.name, $index)">删</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </div>

    <div v-if="!connectors.length" class="conn-empty">
      <el-empty description="未配置连接器(datasources.json flink.connectors)" :image-size="60" />
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="generating" @click="generate">生成 DDL 并插入</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conn-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #909399;
  margin-bottom: 10px;
}
.conn-card {
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  margin-bottom: 8px;
  overflow: hidden;
}
.conn-card.active {
  border-color: var(--el-color-primary);
}
.conn-head {
  padding: 8px 12px;
  cursor: pointer;
  background: var(--el-fill-color-light);
}
.conn-label {
  font-weight: 600;
}
.conn-type {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
  font-family: monospace;
}
.conn-body {
  padding: 10px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.f-label {
  width: 90px;
  font-size: 13px;
  color: #606266;
  flex-shrink: 0;
  text-align: right;
}
.f-input {
  flex: 1;
}
.fields-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 0;
}
.fields-title {
  font-size: 13px;
  font-weight: 600;
}
.fields-table :deep(.el-input__wrapper) {
  box-shadow: none;
}
.conn-empty {
  padding: 10px 0;
}
</style>
