<template>
  <ion-page class="login-page">
    <ion-content :fullscreen="true">
      <div class="login-shell">
        <div class="signal-mark" aria-hidden="true"><i /><i /><i /></div>
        <p class="eyebrow">DATA OPERATIONS / MOBILE</p>
        <h1>把集群状态<br />带在身边</h1>
        <p class="login-lead">查看 YARN 与离线任务，在故障发生时快速响应。</p>
        <form class="login-panel" @submit.prevent="submit">
          <p v-if="auth.authDisabled" class="auth-disabled-note">当前环境未启用登录认证，可直接进入控制台。</p>
          <template v-else>
            <label>账号<ion-input v-model="username" autocomplete="username" placeholder="请输入门户账号" /></label>
            <label>密码<ion-input v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" /></label>
          </template>
          <p v-if="error" class="form-error">{{ error }}</p>
          <ion-button expand="block" type="submit" :disabled="submitting">
            <ion-spinner v-if="submitting" name="crescent" />
            <span v-else>{{ auth.authDisabled ? '直接进入控制台' : '进入控制台' }}</span>
          </ion-button>
        </form>
        <p class="security-note">连接由企业门户网关保护，App 不保存集群凭证。</p>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { IonButton, IonContent, IonInput, IonPage, IonSpinner } from '@ionic/vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

async function enterConsole() {
  await router.replace('/app/home')
}

async function submit() {
  if (auth.authDisabled) {
    await enterConsole()
    return
  }
  if (!username.value.trim() || !password.value) return
  submitting.value = true
  error.value = ''
  try {
    await auth.login(username.value.trim(), password.value)
    await enterConsole()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '登录失败'
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  if (!auth.loaded) await auth.loadSession()
  if (auth.loggedIn || auth.authDisabled) await enterConsole()
})
</script>
