<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, User, Key } from '@element-plus/icons-vue'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/api/auth'

defineOptions({ name: 'LoginView' })

const router = useRouter()
const auth = useAuthStore()

const loading = ref(false)
const initialized = ref(true)
const username = ref('')
const password = ref('')
const confirmPwd = ref('')

const isInit = computed(() => !initialized.value)

onMounted(async () => {
  if (!auth.loaded) await auth.fetchMe()
  if (auth.authDisabled) {
    router.replace('/')
    return
  }
  initialized.value = auth.initialized
})

async function submit() {
  const name = username.value.trim()
  if (!name) return ElMessage.warning('请输入用户名')
  if (password.value.length < 6) return ElMessage.warning('密码至少 6 位')
  if (isInit.value && password.value !== confirmPwd.value) {
    return ElMessage.warning('两次输入的密码不一致')
  }
  loading.value = true
  try {
    if (isInit.value) {
      await authApi.init(name, password.value)
      ElMessage.success('管理员创建成功,已自动登录')
    } else {
      await auth.login(name, password.value)
      ElMessage.success('登录成功')
    }
    router.replace('/')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-mark">B</span>
        <span class="logo-title">大数据门户</span>
      </div>
      <div class="login-sub">{{ isInit ? '首次使用:创建管理员账号' : '统一数据开发与运维平台' }}</div>

      <el-form label-position="top" size="large" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input v-model="username" :prefix-icon="User" placeholder="用户名" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            :prefix-icon="Lock"
            placeholder="密码(至少 6 位)"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item v-if="isInit" label="确认密码">
          <el-input
            v-model="confirmPwd"
            type="password"
            :prefix-icon="Key"
            placeholder="再次输入密码"
            show-password
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button class="login-btn" type="primary" size="large" :loading="loading" @click="submit">
          {{ isInit ? '创建并登录' : '登 录' }}
        </el-button>
      </el-form>

      <div class="login-tip">登录后请及时在「用户管理」中创建其他成员账号</div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f2d3d 0%, #263445 60%, #2d3a4d 100%);
}
.login-card {
  width: 380px;
  padding: 36px 32px 24px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.login-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 6px;
}
.logo-mark {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary);
  color: #fff;
  font-weight: 700;
  border-radius: 8px;
}
.logo-title {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}
.login-sub {
  text-align: center;
  font-size: 13px;
  color: #909399;
  margin-bottom: 24px;
}
.login-btn {
  width: 100%;
  margin-top: 8px;
}
.login-tip {
  margin-top: 16px;
  font-size: 12px;
  color: #c0c4cc;
  text-align: center;
}
</style>
