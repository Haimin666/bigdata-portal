<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Delete, EditPen } from '@element-plus/icons-vue'
import { getDbPerms, saveDbPerms, listDataSources, type DbUserRule, type DbRoleRule } from '@/api/db'
import { userApi, type RolesDef } from '@/api/auth'

defineOptions({ name: 'DbPermView' })

// 库 tag 最多展示数,超出折叠为 +N(完整列表见 title 提示)
const MAX_SHOWN = 3

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

// ── 新增 / 编辑弹窗 ─────────────────────────────────────
const showDialog = ref(false)
const dialogKind = ref<RuleKind>('user')
const form = reactive<{ subject: string; dbs: string[]; all: boolean }>({ subject: '', dbs: [], all: false })

const dialogTitle = computed(() =>
  `${dialogKind.value === 'user' ? '用户' : '角色'}规则${form.subject ? '编辑' : '新增'}`
)

/** 主体下拉选项:已配置规则的主体不再重复提供(编辑中的当前主体除外) */
const subjectOptions = computed(() => {
  if (dialogKind.value === 'user') {
    const taken = new Set(userRules.value.map((r) => r.user))
    return users.value.filter((u) => u === form.subject || !taken.has(u)).map((u) => ({ value: u, label: u }))
  }
  const taken = new Set(roleRules.value.map((r) => r.role))
  return roleOptions.value
    .filter((r) => r.key === form.subject || !taken.has(r.key))
    .map((r) => ({ value: r.key, label: `${r.title}(${r.key})` }))
})

function openCreate(kind: RuleKind) {
  dialogKind.value = kind
  Object.assign(form, { subject: '', dbs: [], all: false })
  showDialog.value = true
}

function openEdit(kind: RuleKind, rule: DbUserRule | DbRoleRule) {
  dialogKind.value = kind
  const isAll = rule.dbs.length === 1 && rule.dbs[0] === '*'
  Object.assign(form, {
    subject: kind === 'user' ? (rule as DbUserRule).user : (rule as DbRoleRule).role,
    dbs: isAll ? [] : [...rule.dbs],
    all: isAll
  })
  showDialog.value = true
}

async function submit() {
  const subject = form.subject.trim()
  if (!subject) return ElMessage.warning(`请选择${dialogKind.value === 'user' ? '用户' : '角色'}`)
  const dbs = form.all ? ['*'] : [...form.dbs]
  if (!form.all && dbs.length === 0) return ElMessage.warning('请至少选择一个数据库,或开启「全部库」')
  if (dialogKind.value === 'user') {
    const rules = userRules.value
    const idx = rules.findIndex((r) => r.user === subject)
    const rule: DbUserRule = { user: subject, dbs }
    if (idx >= 0) rules[idx] = rule
    else rules.push(rule)
  } else {
    const rules = roleRules.value
    const idx = rules.findIndex((r) => r.role === subject)
    const rule: DbRoleRule = { role: subject, dbs }
    if (idx >= 0) rules[idx] = rule
    else rules.push(rule)
  }
  await persist(true)
}

// ── 全量保存 ─────────────────────────────────────────────
async function persist(closeDialog: boolean) {
  saving.value = true
  try {
    await saveDbPerms({ userRules: [...userRules.value], roleRules: [...roleRules.value] })
    ElMessage.success('已保存')
    if (closeDialog) showDialog.value = false
  } catch (e) {
    ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
  } finally {
    saving.value = false
  }
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
  await persist(false)
}

// ── 展示辅助 ─────────────────────────────────────────────
/** 提取规则主体(用户规则取 user,角色规则取 role) */
function subjectOf(rule: DbUserRule | DbRoleRule): string {
  return (rule as DbUserRule).user ?? (rule as DbRoleRule).role
}

function shownDbs(dbs: string[]): string[] {
  return dbs.slice(0, MAX_SHOWN)
}

function restCount(dbs: string[]): number {
  return Math.max(0, dbs.length - MAX_SHOWN)
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
          <el-table-column label="可访问库" min-width="260">
            <template #default="{ row }">
              <template v-if="row.dbs.includes('*')">
                <el-tag size="small" type="success">全部库</el-tag>
              </template>
              <template v-else-if="row.dbs.length">
                <el-tag
                  v-for="d in shownDbs(row.dbs)"
                  :key="d"
                  size="small"
                  class="db-tag"
                  :title="row.dbs.join(', ')"
                >
                  {{ d }}
                </el-tag>
                <el-tag v-if="restCount(row.dbs) > 0" size="small" type="info" :title="row.dbs.join(', ')">
                  +{{ restCount(row.dbs) }}
                </el-tag>
              </template>
              <span v-else class="muted">-</span>
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
          <el-table-column label="可访问库" min-width="260">
            <template #default="{ row }">
              <template v-if="row.dbs.includes('*')">
                <el-tag size="small" type="success">全部库</el-tag>
              </template>
              <template v-else-if="row.dbs.length">
                <el-tag
                  v-for="d in shownDbs(row.dbs)"
                  :key="d"
                  size="small"
                  class="db-tag"
                  :title="row.dbs.join(', ')"
                >
                  {{ d }}
                </el-tag>
                <el-tag v-if="restCount(row.dbs) > 0" size="small" type="info" :title="row.dbs.join(', ')">
                  +{{ restCount(row.dbs) }}
                </el-tag>
              </template>
              <span v-else class="muted">-</span>
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

    <!-- 新增 / 编辑规则 -->
    <el-dialog v-model="showDialog" :title="dialogTitle" width="520px">
      <el-form label-width="80px" size="default">
        <el-form-item :label="dialogKind === 'user' ? '用户' : '角色'">
          <el-select v-model="form.subject" filterable :placeholder="`选择${dialogKind === 'user' ? '用户' : '角色'}`" style="width: 100%">
            <el-option v-for="o in subjectOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="全部库">
          <el-switch v-model="form.all" />
          <span class="form-hint">开启后该主体对所有库放行(存储为 *),并禁用下方库多选</span>
        </el-form-item>
        <el-form-item label="可访问库">
          <el-select
            v-model="form.dbs"
            multiple
            filterable
            allow-create
            default-first-option
            :disabled="form.all"
            placeholder="选择或输入库名(可新建)"
            style="width: 100%"
          >
            <el-option v-for="d in dbOptions" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
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
