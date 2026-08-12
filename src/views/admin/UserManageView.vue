<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Delete, EditPen } from '@element-plus/icons-vue'
import { userApi, type UserInfo, type RolesDef } from '@/api/auth'
import { menus } from '@/config/menu'

defineOptions({ name: 'UserManageView' })

// 可选模块清单(菜单 name 白名单;userManage 仅管理员可见,默认包含在 admin)
const MODULE_OPTIONS = [...new Set([...menus.map((m) => m.name), 'userManage'])]

const users = ref<UserInfo[]>([])
const roles = ref<RolesDef>({})
const loading = ref(false)

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
    <div class="head">
      <span class="tip">用户管理:自建账号,控制可访问模块(模块级权限)。首个管理员在登录页初始化。</span>
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
      <el-table-column label="可访问模块" min-width="260">
        <template #default="{ row }">
          <template v-if="row.effectiveModules">
            <el-tag v-for="m in row.effectiveModules" :key="m" size="small" class="mod-tag">{{ m }}</el-tag>
          </template>
          <span v-else class="muted">全部模块</span>
        </template>
      </el-table-column>
      <el-table-column prop="lastLoginAt" label="最近登录" width="160">
        <template #default="{ row }">
          <span v-if="row.lastLoginAt">{{ row.lastLoginAt.replace('T', ' ').slice(0, 19) }}</span>
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" align="center">
        <template #default="{ row }">
          <el-button size="small" text type="primary" :icon="EditPen" @click="openEdit(row)">编辑</el-button>
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
</style>
