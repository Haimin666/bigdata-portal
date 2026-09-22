<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Delete, EditPen, Grid } from '@element-plus/icons-vue'
import { userApi, type UserInfo, type RolesDef } from '@/api/auth'
import { menus } from '@/config/menu'
import DbPermView from './DbPermView.vue'
import DbRuleEditor, { type DbRuleV2 } from './DbRuleEditor.vue'
import { getDbPerms, saveDbPerms, listDataSources, type DbUserRule, type DbRoleRule } from '@/api/db'

defineOptions({ name: 'UserManageView' })

// 可选模块清单(菜单 name 白名单;userManage 仅管理员可见,默认包含在 admin)
const MODULE_OPTIONS = [...new Set([...menus.map((m) => m.name), 'userManage'])]

const users = ref<UserInfo[]>([])
const roles = ref<RolesDef>({})
const loading = ref(false)

// ── 数据库权限(集成自数据权限矩阵,存 data/db-permissions.json)──
const tab = ref('users')
const userRules = ref<DbUserRule[]>([])
const roleRules = ref<DbRoleRule[]>([])
const dbOptions = ref<string[]>([])
// 规则编辑器(引擎/库/表/读写 + Spark + Flink)
const showEditor = ref(false)
const editingSubject = ref('')
const editingInitial = ref<DbRuleV2 | null>(null)

const roleLabels = computed(() => {
  const map: Record<string, string> = {}
  for (const [k, v] of Object.entries(roles.value)) map[k] = v.title
  return map
})

async function load() {
  loading.value = true
  try {
    const data = await userApi.list()
    users.value = data.users
    roles.value = data.roles
  } catch (e) {
    ElMessage.error(`加载用户失败:${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
  void loadPerms()
}

/** 并行加载数据权限矩阵(用户规则 + 角色规则 + 可选库列表) */
async function loadPerms() {
  try {
    const [perms, sources] = await Promise.all([getDbPerms(), listDataSources().catch(() => [])])
    userRules.value = perms.userRules
    roleRules.value = perms.roleRules
    dbOptions.value = sources.map((s) => s.name).filter(Boolean)
  } catch {
    /* 权限矩阵/数据源不可用不影响用户管理 */
  }
}

/** 用户已配置的库规则(未配置返回 null = 放行) */
function ruleOf(username: string): DbUserRule | null {
  return userRules.value.find((x) => x.user === username) || null
}

/** 用户管理页摘要展示(规则列) */
function engDesc(rule: DbUserRule): string {
  const ers = rule.engineRules || []
  if (!ers.length) return '未配置'
  return ers
    .map((er) => {
      const eng = er.engine === '*' ? '全部' : er.engine
      const tbl = er.tables && er.tables.length ? `(${er.tables.length}表)` : ''
      return `${eng}:${er.db}${tbl} ${er.read ? '读' : ''}${er.write ? '写' : ''}`
    })
    .join('; ')
}
function sparkTag(rule: DbUserRule): string {
  return rule.spark?.write ? '可写' : '只读'
}

function openDbPerm(u: UserInfo) {
  const rule = ruleOf(u.username)
  editingSubject.value = u.username
  editingInitial.value = rule
    ? {
        engineRules: (rule.engineRules || []).map((er) => ({ ...er, tables: er.tables ? [...er.tables] : null })),
        spark: rule.spark ? { read: rule.spark.read === true, write: rule.spark.write === true } : null,
        flink: rule.flink ? { enabled: rule.flink.enabled === true } : null
      }
    : null
  showEditor.value = true
}

function onSaveRule(subject: string, rule: DbRuleV2) {
  const idx = userRules.value.findIndex((r) => r.user === subject)
  if (idx >= 0) userRules.value[idx] = { user: subject, ...rule }
  else userRules.value.push({ user: subject, ...rule })
  showEditor.value = false
  void persistDbPerms()
}

/** 移除某用户的库规则(= 无规则,按 db-proxy 全局白名单放行) */
async function clearDbPerm(u: UserInfo) {
  try {
    await ElMessageBox.confirm(`清除「${u.username}」的库权限规则?清除后按全局白名单放行。`, '清除库权限', { type: 'warning' })
  } catch {
    return
  }
  userRules.value = userRules.value.filter((r) => r.user !== u.username)
  await persistDbPerms()
}

/** 保存时保留角色规则,只更新用户规则部分 */
async function persistDbPerms(): Promise<boolean> {
  try {
    await saveDbPerms({ userRules: [...userRules.value], roleRules: roleRules.value })
    ElMessage.success('已保存')
    return true
  } catch (e) {
    ElMessage.error(`保存失败:${e instanceof Error ? e.message : e}`)
    return false
  }
}

onMounted(load)

// ── 新建 ─────────────────────────────────────────────────
const showCreate = ref(false)
const createForm = reactive({ username: '', password: '', role: 'dev', status: 'active', modules: [] as string[] })

function openCreate() {
  Object.assign(createForm, { username: '', password: '', role: 'dev', status: 'active', modules: [] })
  showCreate.value = true
}

async function submitCreate() {
  if (!createForm.username.trim()) return ElMessage.warning('请输入用户名')
  if (createForm.password.length < 6) return ElMessage.warning('密码至少 6 位')
  try {
    await userApi.create({
      username: createForm.username.trim(),
      password: createForm.password,
      role: createForm.role,
      status: createForm.status,
      modules: createForm.modules.length ? createForm.modules : null
    })
    ElMessage.success('用户已创建')
    showCreate.value = false
    void load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

// ── 编辑 ─────────────────────────────────────────────────
const showEdit = ref(false)
const editForm = reactive({
  username: '',
  role: 'dev',
  status: 'active',
  modules: [] as string[],
  inheritModules: true,
  password: ''
})

function openEdit(u: UserInfo) {
  Object.assign(editForm, {
    username: u.username,
    role: u.role,
    status: u.status,
    modules: u.modules && u.modules.length ? [...u.modules] : [],
    inheritModules: !u.modules || u.modules.length === 0,
    password: ''
  })
  showEdit.value = true
}

async function submitEdit() {
  try {
    await userApi.update(editForm.username, {
      role: editForm.role,
      status: editForm.status,
      modules: editForm.inheritModules ? null : editForm.modules,
      ...(editForm.password ? { password: editForm.password } : {})
    })
    ElMessage.success('已保存')
    showEdit.value = false
    void load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

// ── 删除 / 重置密码 ────────────────────────────────────
async function removeUser(u: UserInfo) {
  try {
    await ElMessageBox.confirm(`确定删除用户「${u.username}」?`, '删除用户', { type: 'warning' })
  } catch {
    return
  }
  try {
    await userApi.remove(u.username)
    ElMessage.success('已删除')
    void load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  }
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  active: { label: '启用', cls: 'success' },
  disabled: { label: '停用', cls: 'danger' }
}

function statusInfo(s: string) {
  return STATUS_MAP[s] || { label: s, cls: 'info' }
}
</script>

<template>
  <div class="user-manage">
    <el-tabs v-model="tab" class="um-tabs">
      <el-tab-pane label="用户管理" name="users">
        <div class="head">
          <span class="tip">用户管理:自建账号,控制可访问模块与可访问数据库(admin 不受限)。首个管理员在登录页初始化。</span>
          <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新建用户</el-button>
          <el-button size="small" :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        </div>

    <el-table :data="users" size="small" border>
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column label="角色" width="110" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="row.role === 'admin' ? 'danger' : 'primary'">
            {{ roleLabels[row.role] || row.role }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="statusInfo(row.status).cls as any">{{ statusInfo(row.status).label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="可访问模块" min-width="200">
        <template #default="{ row }">
          <template v-if="row.effectiveModules">
            <el-tag v-for="m in row.effectiveModules" :key="m" size="small" class="mod-tag">{{ m }}</el-tag>
          </template>
          <span v-else class="muted">全部模块</span>
        </template>
      </el-table-column>
      <el-table-column label="可访问数据库" min-width="260">
        <template #default="{ row }">
          <template v-if="row.role === 'admin'">
            <el-tag size="small" type="danger">不受限</el-tag>
          </template>
          <template v-else>
            <template v-if="ruleOf(row.username)">
              <span class="rule-summary" :title="engDesc(ruleOf(row.username)!)">{{ engDesc(ruleOf(row.username)!) }}</span>
              <el-tag v-if="ruleOf(row.username)!.spark" size="small" class="spark-tag" :type="(ruleOf(row.username)!.spark?.write ? 'warning' : 'primary')">Spark {{ sparkTag(ruleOf(row.username)!) }}</el-tag>
              <el-tag v-if="ruleOf(row.username)!.flink?.enabled" size="small" class="spark-tag" type="success">Flink</el-tag>
            </template>
            <span v-else class="muted">默认(全局白名单)</span>
          </template>
        </template>
      </el-table-column>
      <el-table-column prop="lastLoginAt" label="最近登录" width="150">
        <template #default="{ row }">
          <span v-if="row.lastLoginAt">{{ row.lastLoginAt.replace('T', ' ').slice(0, 19) }}</span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" align="center">
        <template #default="{ row }">
          <el-button size="small" text type="primary" :icon="EditPen" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="row.role !== 'admin'" size="small" text type="warning" :icon="Grid" @click="openDbPerm(row)">库权限</el-button>
          <el-button v-if="row.role !== 'admin' && ruleOf(row.username)" size="small" text type="danger" @click="clearDbPerm(row)">清除</el-button>
          <el-button size="small" text type="danger" :icon="Delete" @click="removeUser(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建用户 -->
    <el-dialog v-model="showCreate" title="新建用户" width="480px">
      <el-form label-width="90px" size="default">
        <el-form-item label="用户名">
          <el-input v-model="createForm.username" placeholder="2-32 位字母/数字/_.-" />
        </el-form-item>
        <el-form-item label="初始密码">
          <el-input v-model="createForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="createForm.role" style="width: 100%">
            <el-option v-for="(r, k) in roles" :key="k" :label="`${r.title}(${k})`" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="createForm.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="disabled">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="模块覆盖">
          <el-select v-model="createForm.modules" multiple collapse-tags placeholder="留空 = 继承角色" style="width: 100%">
            <el-option v-for="m in MODULE_OPTIONS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 编辑用户 -->
    <el-dialog v-model="showEdit" title="编辑用户" width="480px">
      <el-form label-width="90px" size="default">
        <el-form-item label="用户名">
          <span>{{ editForm.username }}</span>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="editForm.role" style="width: 100%">
            <el-option v-for="(r, k) in roles" :key="k" :label="`${r.title}(${k})`" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="editForm.status">
            <el-radio value="active">启用</el-radio>
            <el-radio value="disabled">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="模块">
          <el-checkbox v-model="editForm.inheritModules">继承角色模块</el-checkbox>
          <el-select
            v-if="!editForm.inheritModules"
            v-model="editForm.modules"
            multiple
            collapse-tags
            placeholder="选择可访问模块"
            style="width: 100%; margin-top: 6px"
          >
            <el-option v-for="m in MODULE_OPTIONS" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="重置密码">
          <el-input v-model="editForm.password" type="password" show-password placeholder="留空 = 不修改密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEdit = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 库权限编辑(v2 规则:引擎/库/表/读写 + Spark + Flink) -->
    <DbRuleEditor
      v-model="showEditor"
      :subject="editingSubject"
      subject-kind="user"
      :initial="editingInitial"
      :db-options="dbOptions"
      @save="onSaveRule"
    />
      </el-tab-pane>

      <el-tab-pane label="数据权限" name="dbperm">
        <DbPermView />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.user-manage {
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
.tip {
  font-size: 12px;
  color: #909399;
  margin-right: auto;
}
.mod-tag {
  margin-right: 4px;
}
.muted {
  color: #c0c4cc;
}
.um-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.um-tabs :deep(.el-tabs__content) {
  flex: 1;
  overflow: auto;
}
.db-perm-tip {
  font-size: 12px;
  margin-top: 8px;
  line-height: 1.5;
}
</style>
