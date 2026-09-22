<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/api/auth'
import { getTheme, toggleTheme } from '@/utils/theme'

defineOptions({ name: 'LoginView' })

const router = useRouter()
const auth = useAuthStore()

const loading = ref(false)
const initialized = ref(true)
const username = ref('')
const password = ref('')
const confirmPwd = ref('')

const isInit = computed(() => !initialized.value)
const isDark = computed(() => getTheme() === 'dark')

onMounted(async () => {
  if (!auth.loaded) await auth.fetchMe()
  if (auth.authDisabled) {
    router.replace('/')
    return
  }
  initialized.value = auth.initialized
  // 打字机标题动画
  typeTitle()
})

/** 标题打字机(深空控制台风格) */
let typeTimer: ReturnType<typeof setTimeout> | null = null
function typeTitle() {
  const el = document.getElementById('loginTitle')
  if (!el) return
  const full = 'BIGDATA 门户'
  let i = 0
  el.textContent = ''
  el.classList.add('blink')
  const step = () => {
    if (i <= full.length) {
      el.textContent = full.slice(0, i++)
      typeTimer = setTimeout(step, 90)
    } else {
      el.classList.remove('blink')
    }
  }
  step()
}
onUnmounted(() => {
  if (typeTimer) clearTimeout(typeTimer)
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
      // S4:init 成功先拉取当前用户,否则路由守卫判定未登录踢回初始化页,导致重复提交
      await auth.fetchMe()
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
    <div class="grid-bg"></div>
    <!-- 顶部状态条 -->
    <div class="status-bar">
      <span class="status-left">
        <span class="status-dot"></span>BIGDATA-PORTAL // NODE-AUTH-01 ONLINE
      </span>
      <button class="theme-toggle" @click="toggleTheme()">
        {{ isDark ? '☀ 浅色' : '☾ 深色' }}
      </button>
    </div>

    <div class="login-wrap">
      <!-- 左侧:品牌 + 控制台日志 -->
      <div class="brand">
        <h1 id="loginTitle" class="blink">BIGDATA 门户</h1>
        <div class="sub">UNIFIED DATA &nbsp;//&nbsp; <b>大数据统一门户</b></div>
        <div class="console">
          <div><span class="ln">$</span> <span class="dim">init auth-gateway --env prod</span></div>
          <div><span class="ln">$</span> <span class="dim">handshake &nbsp;→&nbsp;</span> <span class="ok">OK (2.3ms)</span></div>
          <div><span class="ln">$</span> <span class="dim">load modules &nbsp;→&nbsp;</span> <span class="ok">yarn / hdfs / ds / flink</span></div>
          <div v-if="!isInit">
            <span class="ln">$</span> <span class="dim">await credential</span><span class="blink"></span>
          </div>
          <div v-else>
            <span class="ln">$</span> <span class="dim">first-run detected &nbsp;→&nbsp;</span> <span class="ok">INIT ADMIN</span>
          </div>
        </div>
      </div>

      <!-- 右侧:登录卡 -->
      <form class="login-card" @submit.prevent="submit">
        <div class="card-title">{{ isInit ? 'INIT / 初始化' : 'AUTH / LOGIN' }}</div>
        <div class="card-tip">{{ isInit ? '创建管理员账号以接入集群控制面' : '输入凭证以接入集群控制面' }}</div>

        <div class="field">
          <label for="loginU">USERNAME // 用户名</label>
          <input id="loginU" v-model="username" placeholder="admin" autocomplete="username" />
        </div>
        <div class="field">
          <label for="loginP">PASSWORD // 密码</label>
          <input id="loginP" v-model="password" type="password" placeholder="••••••••" autocomplete="current-password" />
        </div>
        <div v-if="isInit" class="field">
          <label for="loginP2">CONFIRM // 确认密码</label>
          <input id="loginP2" v-model="confirmPwd" type="password" placeholder="••••••••" autocomplete="new-password" />
        </div>

        <button class="btn-primary" type="submit" :disabled="loading">
          {{ loading ? '验证中…' : '登 录' }}
        </button>
        <div class="login-foot">{{ isInit ? '管理员创建后自动登录' : '首次使用:创建管理员账号后接入' }}</div>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
.login-page {
  position: relative;
  height: 100%;
  background: $bg;
  color: $text;
  font-family: 'SFMono-Regular', Consolas, Menlo, monospace;
  overflow: hidden;
}

/* 网格背景 */
.grid-bg {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(var(--bd-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--bd-grid-line) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 90% 80% at 30% 40%, #000 20%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 90% 80% at 30% 40%, #000 20%, transparent 75%);
}

/* 顶部状态条 */
.status-bar {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 26px;
  font-size: 11px;
  letter-spacing: 2px;
  color: $muted;
  border-bottom: 1px solid var(--bd-border);
  background: color-mix(in srgb, $bg 80%, transparent);
  backdrop-filter: blur(8px);
}
.status-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 8px #34d399;
  animation: pulse 1.6s infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
.theme-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--bd-border);
  background: transparent;
  color: $text;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 2px;
  padding: 5px 12px;
  cursor: pointer;
  transition: background 0.25s, color 0.25s;
  &:hover {
    background: $primary;
    color: $bg;
  }
}

/* 主体 */
.login-wrap {
  height: calc(100% - 54px);
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  align-items: center;
  padding: 0 7vw;
}

.brand h1 {
  font-size: clamp(30px, 4.6vw, 58px);
  font-weight: 700;
  letter-spacing: 6px;
  color: $text;
  text-shadow: 0 0 24px color-mix(in srgb, $primary 35%, transparent);
  min-height: 1.2em;
}
.brand .sub {
  margin-top: 18px;
  font-size: 13px;
  letter-spacing: 4px;
  color: $muted;
  b {
    color: $primary;
    font-weight: 400;
  }
}
.console {
  margin-top: 44px;
  border: 1px solid var(--bd-border);
  background: color-mix(in srgb, $panel 55%, transparent);
  padding: 18px 20px;
  font-size: 12px;
  line-height: 2.1;
  max-width: 460px;
  box-shadow: 0 0 40px color-mix(in srgb, $primary 5%, transparent) inset;
  .ln {
    color: $muted;
  }
  .ok {
    color: $primary;
  }
  .dim {
    color: $muted;
    opacity: 0.8;
  }
}
.blink::after {
  content: '▌';
  color: $primary;
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* 登录卡 */
.login-card {
  position: relative;
  border: 1px solid var(--bd-border);
  background: linear-gradient(160deg, color-mix(in srgb, $panel 95%, transparent), color-mix(in srgb, $bg 90%, transparent));
  padding: 44px 40px 36px;
  max-width: 400px;
  width: 100%;
  margin-left: auto;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.4);
  animation: rise 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.login-card::before {
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  right: -1px;
  height: 2px;
  background: linear-gradient(90deg, transparent, $primary, transparent);
  animation: scanline 3s linear infinite;
}
@keyframes scanline {
  0% {
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
  85% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.card-title {
  font-size: 15px;
  letter-spacing: 5px;
  color: $primary;
  display: flex;
  align-items: center;
  gap: 10px;
  &::before {
    content: '▸';
  }
}
.card-tip {
  margin: 10px 0 30px;
  font-size: 11px;
  color: $muted;
  letter-spacing: 1px;
}
.field {
  margin-bottom: 20px;
  label {
    display: block;
    font-size: 11px;
    letter-spacing: 2px;
    color: $muted;
    margin-bottom: 8px;
  }
  input {
    width: 100%;
    background: color-mix(in srgb, $bg 60%, transparent);
    border: 1px solid color-mix(in srgb, $primary 30%, transparent);
    color: $text;
    font-family: inherit;
    font-size: 14px;
    letter-spacing: 1px;
    padding: 12px 14px;
    outline: none;
    transition: border-color 0.25s, box-shadow 0.25s;
    &:focus {
      border-color: $primary;
      box-shadow: 0 0 0 1px $primary, 0 0 18px color-mix(in srgb, $primary 18%, transparent);
    }
    &::placeholder {
      color: $muted;
      opacity: 0.6;
    }
  }
}
.btn-primary {
  width: 100%;
  margin-top: 10px;
  padding: 14px;
  background: transparent;
  border: 1px solid $primary;
  color: $primary;
  font-family: inherit;
  font-size: 13px;
  letter-spacing: 6px;
  cursor: pointer;
  transition: background 0.3s, color 0.3s;
  &:hover:not(:disabled) {
    background: $primary;
    color: $bg;
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}
.login-foot {
  margin-top: 24px;
  font-size: 10px;
  letter-spacing: 1px;
  color: $muted;
  text-align: center;
}

@media (max-width: 960px) {
  .login-wrap {
    grid-template-columns: 1fr;
    padding: 60px 20px 20px;
  }
  .console {
    display: none;
  }
  .login-card {
    margin: auto;
  }
}
</style>
