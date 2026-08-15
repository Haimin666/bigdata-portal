<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Delete, EditPen } from '@element-plus/icons-vue'
import { getDbPerms, saveDbPerms, listDataSources, type DbUserRule, type DbRoleRule } from '@/api/db'
import { userApi, type RolesDef } from '@/api/auth'
import DbRuleEditor, { type DbRuleV2 } from './DbRuleEditor.vue'

defineOptions({ name: 'DbPermView' })

type RuleKind = 'user' | 'role'

const activeTab = ref<RuleKind>('user')
const userRules = ref<DbUserRule[]>([])
const roleRules = ref<DbRoleRule[]>([])
const users = ref<string[]>([])
const roleOptions = ref<{ key: string; title: string }[]>([])
const dbOptions = ref<string[]>([])

const loading = ref(false)
const saving = ref(false)
const loadFailed = ref(false)

// ── 加载 ─────────────────────────────────────────────────
async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const [perms, sources] = await Promise.all([
      getDbPerms(),
      listDataSources().catch(() => [])
    ])
    userRules.value = perms.userRules
    roleRules.value = perms.roleRules
    dbOptions.value = sources.map((s) => s.name).filter(Boolean)
    await loadUsersAndRoles()
  } catch (e) {
    loadFailed.value = true
    ElMessage.error(`加载权限规则失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

async function loadUsersAndRoles() {
  try {
    const data = await userApi.list()
    users.value = data.users.map((u) => u.username)
    // 角色下拉:动态取用户体系角色定义(admin 不受限,不参与规则配置)
    const defs: RolesDef = data.roles || {}
    roleOptions.value = Object.entries(defs)
      .filter(([k]) => k !== 'admin')
      .map(([k, v]) => ({ key: k, title: v.title || k }))
  } catch {
    // 用户/角色列表不可用:保持空选项,弹窗 allow-create 仍可手动输入
  }
}

onMounted(load)

// ── 规则编辑(DbRuleEditor:引擎/库/表/读写 + Spark + Flink)──────
const showEditor = ref(false)
const editingKind = ref<RuleKind>('user')
const editingSubject = ref('')
const editingInitial = ref<DbRuleV2 | null>(null)

function openCreate(kind: RuleKind) {
  editingKind.value = kind
  editingSubject.value = ''
  editingInitial.value = null
  showEditor.value = true
}

/** 新增时可选择主体:已配置规则的主体不再重复提供 */
const subjectOptions = computed(() => {
  if (editingKind.value === 'user') {
    const taken = new Set(userRules.value.map((r) => r.user))
    return users.value.filter((u) => !taken.has(u)).map((u) => ({ value: u, label: u }))
  }
  const taken = new Set(roleRules.value.map((r) => r.role))
  return roleOptions.value
    .filter((r) => !taken.has(r.key))
    .map((r) => ({ value: r.key, label: `${r.title}(${r.key})` }))
})

function openEdit(kind: RuleKind, rule: DbUserRule | DbRoleRule) {
  editingKind.value = kind
  editingSubject.value = kind === 'user' ? (rule as DbUserRule).user : (rule as DbRoleRule).role
  editingInitial.value = {
    engineRules: (rule.engineRules || []).map((er) => ({ ...er, tables: er.tables ? [...er.tables] : null })),
    spark: rule.spark ? { read: rule.spark.read === true, write: rule.spark.write === true } : null,
    flink: rule.flink ? { enabled: rule.flink.enabled === true } : null
  }
  showEditor.value = true
}

function onSaveRule(subject: string, rule: DbRuleV2) {
  if (editingKind.value === 'user') {
    const idx = userRules.value.findIndex((r) => r.user === subject)
    if (idx >= 0) userRules.value[idx] = { user: subject, ...rule }
    else userRules.value.push({ user: subject, ...rule })
  } else {
    const idx = roleRules.value.findIndex((r) => r.role === subject)
    if (idx >= 0) roleRules.value[idx] = { role: subject, ...rule }
    else roleRules.value.push({ role: subject, ...rule })
  }
  showEditor.value = false
  void persist()
}

/** 全量保存(规则编辑器保存后调用) */
async function persist() {
  saving.value = true
  try {
    await saveDbPerms({ userRules: [...userRules.value], roleRules: [...roleRules.value] })
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
  } finally {
    saving.value = false
  }
}

/** 引擎规则摘要(展示用) */
function engDesc(rule: DbUserRule | DbRoleRule): string {
  const ers = rule.engineRules || []
  if (!ers.length) return '未配置'
  return ers
    .map((er) => {
      const eng = er.engine === '*' ? '全部引擎' : er.engine
      const tbl = er.tables && er.tables.length ? `(${er.tables.length}表)` : ''
      return `${eng}:${er.db}${tbl} ${er.read ? '读' : ''}${er.write ? '写' : ''}`
    })
    .join('; ')
}

function sparkDesc(rule: DbUserRule | DbRoleRule): string {
  if (!rule.spark) return '未启用'
  return `读${rule.spark.read ? '✓' : '✗'} 写${rule.spark.write ? '✓' : '✗'}`
}

function flinkDesc(rule: DbUserRule | DbRoleRule): string {
  return rule.flink?.enabled ? '已启用' : '未启用'
}

// ── 删除 ─────────────────────────────────────────────────
async function removeRule(kind: RuleKind, rule: DbUserRule | DbRoleRule) {
  const label = subjectOf(rule)
  try {
    await ElMessageBox.confirm(`确定删除「${label}」的数据库访问规则?`, '删除规则', { type: 'warning' })
  } catch {
    return
  }
  if (kind === 'user') {
    const idx = userRules.value.findIndex((r) => r.user === label)
    if (idx >= 0) userRules.value.splice(idx, 1)
  } else {
    const idx = roleRules.value.findIndex((r) => r.role === label)
    if (idx >= 0) roleRules.value.splice(idx, 1)
  }
  await persist()
}

// ── 展示辅助 ─────────────────────────────────────────────
/** 提取规则主体(用户规则取 user,角色规则取 role) */
function subjectOf(rule: DbUserRule | DbRoleRule): string {
  return (rule as DbUserRule).user ?? (rule as DbRoleRule).role
}
</script>

<template>
  <div class="db-perm">
    <div class="head">
      <span class="title">数据权限矩阵</span>
      <el-button type="primary" size="small" :icon="Plus" @click="openCreate(activeTab)">
        新增{{ activeTab === 'user' ? '用户' : '角色' }}规则
      </el-button>
      <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-alert type="info" :closable="false" show-icon class="hint">
      未配置规则的用户/角色按 db-proxy 全局白名单放行;admin 不受限。规则仅约束 dev/viewer 等非管理员。
    </el-alert>
    <el-alert v-if="loadFailed" type="error" :closable="false" show-icon class="hint">
      权限规则加载失败,请确认网关服务可用后重试。
    </el-alert>

    <el-tabs v-model="activeTab">
      <!-- 用户规则 -->
      <el-tab-pane label="用户规则" name="user">
        <el-table v-loading="loading" :data="userRules" size="small" border empty-text="暂无用户规则,点击「新增用户规则」配置">
          <el-table-column prop="user" label="用户名" min-width="140" />
          <el-table-column label="引擎规则" min-width="280">
            <template #default="{ row }">
              <span class="rule-summary" :title="engDesc(row)">{{ engDesc(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Spark" width="130" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.spark ? (row.spark.write ? 'warning' : 'primary') : 'info'">{{ sparkDesc(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="Flink" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.flink?.enabled ? 'success' : 'info'">{{ flinkDesc(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :icon="EditPen" @click="openEdit('user', row)">编辑</el-button>
              <el-button size="small" text type="danger" :icon="Delete" @click="removeRule('user', row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 角色规则 -->
      <el-tab-pane label="角色规则" name="role">
        <el-table v-loading="loading" :data="roleRules" size="small" border empty-text="暂无角色规则,点击「新增角色规则」配置">
          <el-table-column prop="role" label="角色名" min-width="140" />
          <el-table-column label="引擎规则" min-width="280">
            <template #default="{ row }">
              <span class="rule-summary" :title="engDesc(row)">{{ engDesc(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Spark" width="130" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.spark ? (row.spark.write ? 'warning' : 'primary') : 'info'">{{ sparkDesc(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="Flink" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.flink?.enabled ? 'success' : 'info'">{{ flinkDesc(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="200" align="center">
            <template #default="{ row }">
              <el-button size="small" text type="primary" :icon="EditPen" @click="openEdit('role', row)">编辑</el-button>
              <el-button size="small" text type="danger" :icon="Delete" @click="removeRule('role', row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 规则编辑器(引擎/库/表/读写 + Spark + Flink) -->
    <DbRuleEditor
      v-model="showEditor"
      :subject="editingSubject"
      :subject-kind="editingKind"
      :initial="editingInitial"
      :db-options="dbOptions"
      :subject-options="subjectOptions"
      @save="onSaveRule"
    />
  </div>
</template>

<style scoped>
.db-perm {
  padding: 16px;
  height: 100%;
  overflow: auto;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.title {
  font-size: 16px;
  font-weight: 600;
  margin-right: auto;
}
.hint {
  margin-bottom: 12px;
}
.db-tag {
  margin-right: 4px;
}
.form-hint {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}
.muted {
  color: #c0c4cc;
}
</style>
