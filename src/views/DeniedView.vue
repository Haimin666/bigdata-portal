<script setup lang="ts">
// 403 提示页:用户模块白名单内没有任何可访问的原生页面时,
// 路由守卫兜底落地到此页(不渲染任何业务视图、不发起数据请求)。
// 注意:本页路径 /denied 不在 src/config/menu.ts 中 —— MainLayout 的
// watch 只为菜单路径开 tab,因此这里只会得到空白 stage + 本提示。
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'

defineOptions({ name: 'DeniedView' })

const router = useRouter()
const auth = useAuthStore()

function backToLogin() {
  void auth.logout()
  router.replace('/login')
}
</script>

<template>
  <div class="denied-view">
    <div class="denied-card">
      <div class="code">403</div>
      <div class="msg">当前账号未分配任何可访问的功能模块</div>
      <div class="hint">请联系管理员在「用户管理」中配置可访问模块</div>
      <el-button size="small" type="primary" plain @click="backToLogin">重新登录</el-button>
    </div>
  </div>
</template>

<style scoped>
.denied-view {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.denied-card {
  text-align: center;
  color: var(--bd-text-secondary, #909399);
}
.code {
  font-size: 56px;
  font-weight: 700;
  letter-spacing: 6px;
  font-family: var(--bd-font, monospace);
  color: var(--bd-warning, #e6a23c);
}
.msg {
  margin-top: 12px;
  font-size: 15px;
}
.hint {
  margin-top: 6px;
  margin-bottom: 18px;
  font-size: 12px;
}
</style>
