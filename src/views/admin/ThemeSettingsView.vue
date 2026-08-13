<script setup lang="ts">
/** 管理端·主题设置:全局字体栈 + 浅/深双主题颜色(存 data/theme.json,注入 CSS 变量) */
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { applyThemeOverrides } from '@/utils/theme'

// 默认色值(与 src/styles/variables.scss 保持同步,仅作表单初始展示;留空=用默认)
const DEF = {
  light: { text: '#0d2433', muted: '#5d7a8c', primary: '#00849c', bg: '#eef3f8', panel: '#ffffff', border: '#0b4a68', sidebar: '#e6edf4' },
  dark: { text: '#cfe9f2', muted: '#5f7d8c', primary: '#00e5ff', bg: '#070b12', panel: '#0c1420', border: '#00e5ff', sidebar: '#0a1019' }
}
const KEYS: { k: keyof typeof DEF.light; label: string }[] = [
  { k: 'text', label: '文字色' },
  { k: 'muted', label: '次要文字' },
  { k: 'primary', label: '主色(青色)' },
  { k: 'bg', label: '页面背景' },
  { k: 'panel', label: '面板背景' },
  { k: 'border', label: '边框' },
  { k: 'sidebar', label: '侧栏背景' }
]

const fontFamily = ref('')
const light = ref<Record<string, string>>({ ...DEF.light })
const dark = ref<Record<string, string>>({ ...DEF.dark })
const saving = ref(false)

onMounted(async () => {
  try {
    const r = await fetch('/api/theme')
    if (!r.ok) return
    const d = await r.json()
    const data = d?.data
    if (!data) return
    fontFamily.value = data.fontFamily || ''
    for (const k of Object.keys(DEF.light) as (keyof typeof DEF.light)[]) {
      light.value[k] = data.light?.[k] || DEF.light[k]
      dark.value[k] = data.dark?.[k] || DEF.dark[k]
    }
  } catch {
    /* 保持默认 */
  }
})

async function save() {
  saving.value = true
  try {
    const body = {
      fontFamily: fontFamily.value.trim(),
      light: light.value,
      dark: dark.value
    }
    const r = await fetch('/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.code !== 0) throw new Error(d.msg || '保存失败')
    // 保存后立即在本地生效(管理端预览)
    applyThemeOverrides({
      fontFamily: d.data.fontFamily,
      light: d.data.light,
      dark: d.data.dark
    })
    ElMessage.success('主题设置已保存并全局生效')
  } catch (e: any) {
    ElMessage.error(String(e.message || e))
  } finally {
    saving.value = false
  }
}

async function reset() {
  fontFamily.value = ''
  light.value = { ...DEF.light }
  dark.value = { ...DEF.dark }
  await save()
}

function preview() {
  applyThemeOverrides({
    fontFamily: fontFamily.value.trim(),
    light: light.value,
    dark: dark.value
  })
}
</script>

<template>
  <div class="theme-settings">
    <div class="ts-head">
      <div>
        <div class="t">主题设置</div>
        <div class="d">全局字体与深浅双主题颜色 · 保存后对所有用户生效(存 data/theme.json)</div>
      </div>
      <div class="spacer"></div>
      <el-button @click="reset">重置为默认</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存并生效</el-button>
    </div>

    <div class="ts-panel">
      <div class="ts-panel-title">全局字体栈</div>
      <div class="ts-font-row">
        <el-input v-model="fontFamily" placeholder="如 'SFMono-Regular', Consolas, 'PingFang SC', monospace" clearable />
        <span class="ts-hint">留空 = 默认等宽字体(SFMono-Regular → JetBrains Mono → Consolas);中文字体请放栈尾部</span>
      </div>
    </div>

    <div class="ts-grid">
      <div class="ts-panel">
        <div class="ts-panel-title"><span class="dot light-dot"></span>浅色模式</div>
        <div class="ts-color-row" v-for="it in KEYS" :key="'l' + it.k">
          <span class="ts-label">{{ it.label }}</span>
          <el-color-picker :model-value="light[it.k]" size="small" show-alpha @update:model-value="(v: string) => { light[it.k] = v || DEF.light[it.k]; preview() }" />
          <code class="ts-code">{{ light[it.k] }}</code>
        </div>
      </div>
      <div class="ts-panel">
        <div class="ts-panel-title"><span class="dot dark-dot"></span>深色模式</div>
        <div class="ts-color-row" v-for="it in KEYS" :key="'d' + it.k">
          <span class="ts-label">{{ it.label }}</span>
          <el-color-picker :model-value="dark[it.k]" size="small" show-alpha @update:model-value="(v: string) => { dark[it.k] = v || DEF.dark[it.k]; preview() }" />
          <code class="ts-code">{{ dark[it.k] }}</code>
        </div>
      </div>
    </div>

    <div class="ts-note">提示:调整时实时预览;点「保存并生效」后写入配置,所有用户刷新即生效。颜色支持 hex / rgba。</div>
  </div>
</template>

<style scoped lang="scss">
.theme-settings {
  padding: 18px 20px;
  max-width: 1100px;
}
.ts-head {
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 16px;
  .t { font-size: 17px; font-weight: 700; letter-spacing: 2px; color: $text; }
  .d { color: $muted; font-size: 12px; margin-top: 4px; }
  .spacer { flex: 1; }
}
.ts-panel {
  background: $panel; border: 1px solid $border; border-radius: 8px;
  padding: 14px 16px; margin-bottom: 14px;
}
.ts-panel-title {
  font-size: 12px; letter-spacing: 2px; color: $muted;
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .light-dot { background: #ffffff; border: 1px solid $border; }
  .dark-dot { background: #0c1420; border: 1px solid rgba(0, 229, 255, 0.4); }
}
.ts-font-row { display: flex; flex-direction: column; gap: 6px; }
.ts-hint { color: $muted; font-size: 11px; }
.ts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ts-color-row {
  display: flex; align-items: center; gap: 10px; padding: 6px 0;
  .ts-label { width: 88px; color: $text; font-size: 12px; }
  .ts-code { color: $muted; font-size: 11px; font-family: var(--bd-font); }
}
.ts-note { color: $muted; font-size: 11px; margin-top: 8px; }
</style>
