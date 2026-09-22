<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <main class="forbidden">
    <h1>暂无可访问模块</h1>
    <p>请联系管理员配置平台模块权限。</p>
    <el-button type="primary" @click="router.replace('/login')">返回登录</el-button>
  </main>
</template>

<style scoped lang="scss">
.forbidden {
  min-height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  color: $text;
  background: $bg;
}
.forbidden h1 { margin: 0; }
.forbidden p { margin: 0 0 8px; color: $muted; }
</style>
