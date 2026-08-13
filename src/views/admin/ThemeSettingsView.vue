<script setup lang="ts">
/** 管理端·主题设置(深空控制台调色台)
 *  默认值 = 真实运行时 CSS 变量(variables.scss),不再硬编码;
 *  「恢复默认」= 清空覆盖 → 完全回退 scss 默认。
 *  右侧实时预览卡:浅/深双模式所见即所得。 */
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { applyThemeOverrides, readCssVarSet } from '@/utils/theme'

const KEYS: { k: 'text' | 'muted' | 'primary' | 'bg' | 'panel' | 'border' | 'sidebar'; label: string }[] = [
  { k: 'text', label: '文字色' },
  { k: 'muted', label: '次要文字' },
  { k: 'primary', label: '主色' },
  { k: 'bg', label: '页面背景' },
  { k: 'panel', label: '面板背景' },
  { k: 'border', label: '边框' },
  { k: 'sidebar', label: '侧栏背景' }
]

const fontFamily = ref('')
const light = ref<Record<string, string>>({})
const dark = ref<Record<string, string>>({})
const saving = ref(false)
const pvMode = ref<'light' | 'dark'>('light')

/** 读取真实默认(scss 变量),未设置过主题时表单显示的就是系统真实默认 */
function loadDefaults() {
  light.value = { ...(readCssVarSet('light') as Record<string, string>) }
  dark.value = { ...(readCssVarSet('dark') as Record<string, string>) }
}

onMounted(async () => {
  loadDefaults()
  try {
    const r = await fetch('/api/theme')
    if (!r.ok) return
    const d = await r.json()
    const data = d?.data
    if (!data) return
    fontFamily.value = data.fontFamily || ''
    for (const it of KEYS) {
      if (data.light?.[it.k]) light.value[it.k] = data.light[it.k]
      if (data.dark?.[it.k]) dark.value[it.k] = data.dark[it.k]
    }
  } catch {
    /* 保持默认 */
  }
})

/** 预览:把当前表单值注入全局(未保存,仅供本页预览) */
function preview() {
  applyThemeOverrides({
    fontFamily: fontFamily.value.trim(),
    light: { ...light.value },
    dark: { ...dark.value }
  })
}

/** 预览卡容器变量:按预览模式取对应套色 */
const pvStyle = computed(() => {
  const set = pvMode.value === 'dark' ? dark.value : light.value
  return {
    '--pv-bg': set.bg || 'transparent',
    '--pv-panel': set.panel || 'transparent',
    '--pv-text': set.text || 'inherit',
    '--pv-muted': set.muted || 'inherit',
    '--pv-primary': set.primary || 'inherit',
    '--pv-border': set.border || 'transparent',
    '--pv-sidebar': set.sidebar || 'transparent'
  }
})

async function save() {
  saving.value = true
  try {
    const body = {
      fontFamily: fontFamily.value.trim(),
      light: { ...light.value },
      dark: { ...dark.value }
    }
    const r = await fetch('/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await r.json()
    if (d.code !== 0) throw new Error(d.msg || '保存失败')
    applyThemeOverrides({ fontFamily: d.data.fontFamily, light: d.data.light, dark: d.data.dark })
    ElMessage.success('主题设置已保存,对所有用户生效')
  } catch (e: any) {
    ElMessage.error(String(e.message || e))
  } finally {
    saving.value = false
  }
}

/** 重置单套为系统真实默认(浅/深各自独立);保存后生效 */
function resetTone(mode: 'light' | 'dark') {
  if (mode === 'light') light.value = { ...(readCssVarSet('light') as Record<string, string>) }
  else dark.value = { ...(readCssVarSet('dark') as Record<string, string>) }
  preview()
  ElMessage.success(mode === 'light' ? '浅色模式已恢复默认(保存后生效)' : '深色模式已恢复默认(保存后生效)')
}

function setColor(mode: 'light' | 'dark', k: string, v: string) {
  const target = mode === 'light' ? light : dark
  target.value[k] = v
  preview()
}
</script>

<template>
  <div class="theme-settings">
    <div class="ts-head">
      <div>
        <div class="t"><span class="ts-dot" />主题设置<span class="ts-tag">ADMIN</span></div>
        <div class="d">深空控制台调色台 · 全局字体与深浅双主题 · 存 data/theme.json,对所有用户生效</div>
      </div>
      <div class="spacer"></div>
      <el-button type="primary" :loading="saving" @click="save">保存并生效</el-button>
    </div>

    <div class="ts-grid">
      <!-- ── 左:编辑区 ── -->
      <div class="ts-col">
        <div class="ts-panel">
          <div class="ts-panel-title"><span class="title-dot font-dot" />全局字体栈</div>
          <div class="ts-font-row">
            <el-input v-model="fontFamily" placeholder="'SFMono-Regular', Consolas, 'PingFang SC', monospace" clearable @input="preview" />
            <span class="ts-hint">留空 = 默认等宽字体;中文字体放栈尾部(苹方/雅黑)</span>
          </div>
          <div class="ts-font-sample" :style="{ fontFamily: fontFamily || 'var(--bd-font)' }">
            ABCdef123 数据开发控制台 The quick brown fox
          </div>
        </div>

        <div class="ts-mode-block">
          <div class="ts-mode-head">
            <span class="ts-mode-name"><span class="sw sw-light" />浅色模式</span>
            <div class="ts-mode-actions">
              <button class="ts-mode-btn" @click="resetTone('light')">重置浅色</button>
              <button class="ts-mode-btn" :class="{ active: pvMode === 'light' }" @click="pvMode = 'light'">预览</button>
            </div>
          </div>
          <div class="ts-color-row" v-for="it in KEYS" :key="'l' + it.k">
            <span class="ts-label">{{ it.label }}</span>
            <el-color-picker :model-value="light[it.k]" size="small" show-alpha @update:model-value="(v: string) => setColor('light', it.k, v || '')" />
            <code class="ts-code">{{ light[it.k] }}</code>
          </div>
        </div>

        <div class="ts-mode-block dark">
          <div class="ts-mode-head">
            <span class="ts-mode-name"><span class="sw sw-dark" />深色模式</span>
            <div class="ts-mode-actions">
              <button class="ts-mode-btn" @click="resetTone('dark')">重置深色</button>
              <button class="ts-mode-btn" :class="{ active: pvMode === 'dark' }" @click="pvMode = 'dark'">预览</button>
            </div>
          </div>
          <div class="ts-color-row" v-for="it in KEYS" :key="'d' + it.k">
            <span class="ts-label">{{ it.label }}</span>
            <el-color-picker :model-value="dark[it.k]" size="small" show-alpha @update:model-value="(v: string) => setColor('dark', it.k, v || '')" />
            <code class="ts-code">{{ dark[it.k] }}</code>
          </div>
        </div>
      </div>

      <!-- ── 右:实时预览 ── -->
      <div class="ts-col">
        <div class="ts-panel pv-panel">
          <div class="ts-panel-title">
            <span class="title-dot pv-dot" />实时预览
            <span class="spacer" />
            <div class="pv-mode-switch">
              <button :class="{ active: pvMode === 'light' }" @click="pvMode = 'light'">浅</button>
              <button :class="{ active: pvMode === 'dark' }" @click="pvMode = 'dark'">深</button>
            </div>
          </div>

          <div class="pv-shell" :style="pvStyle">
            <div class="pv-sidebar">
              <div class="pv-logo"><i />DATA OPS</div>
              <div class="pv-menu"><span class="pv-menu-active">▸ YARN 应用</span><span>任务监控</span><span>HDFS</span><span>数据库查询</span></div>
            </div>
            <div class="pv-main">
              <div class="pv-card">
                <div class="pv-card-head">作业运行概览</div>
                <div class="pv-badges">
                  <span class="pv-badge pv-badge-run">RUNNING</span>
                  <span class="pv-badge pv-badge-ok">FINISHED</span>
                </div>
                <div class="pv-bar"><i style="width: 72%"></i></div>
                <div class="pv-lines">
                  <span>dwd_csh_loan_mcr_bill_d_df</span>
                  <span class="pv-muted">2026-08-13 09:35 · 3 天 4 小时 · dolphinscheduler</span>
                </div>
                <div class="pv-btn"><span>执行查询</span></div>
              </div>
              <div class="pv-table">
                <div class="pv-tr pv-th"><span>Job ID</span><span>状态</span><span>耗时</span></div>
                <div class="pv-tr"><span>c1411a26…c4a670</span><span class="pv-ok">运行中</span><span>9d 23h</span></div>
                <div class="pv-tr"><span>application_…168507</span><span class="pv-ok">成功</span><span>3d 4h</span></div>
              </div>
            </div>
          </div>
          <div class="ts-note">编辑左侧颜色即实时刷新预览;浅/深按钮可分别查看两套配色。</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.theme-settings {
  padding: 20px 22px;
  max-width: 1240px;
}
.ts-head {
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 18px;
  .t {
    font-size: 18px; font-weight: 700; letter-spacing: 2px; color: $text;
    display: flex; align-items: center; gap: 10px;
  }
  .ts-dot {
    width: 9px; height: 9px; border-radius: 2px;
    background: $primary; box-shadow: 0 0 10px $primary;
    display: inline-block;
  }
  .ts-tag {
    font-size: 10px; letter-spacing: 2px; color: $primary;
    border: 1px solid $border; border-radius: 3px; padding: 1px 6px;
  }
  .d { color: $muted; font-size: 12px; margin-top: 5px; }
  .spacer { flex: 1; }
}
.ts-grid {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px; align-items: start;
}
.ts-col { display: flex; flex-direction: column; gap: 14px; }
.ts-panel {
  background: $panel; border: 1px solid $border; border-radius: 10px;
  padding: 14px 16px;
}
.ts-panel-title {
  font-size: 12px; letter-spacing: 2px; color: $muted;
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  .spacer { flex: 1; }
}
.title-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: $primary; }
.font-dot { background: $primary; }
.pv-dot { background: #f59e0b; }
.ts-font-row { display: flex; flex-direction: column; gap: 6px; }
.ts-hint { color: $muted; font-size: 11px; }
.ts-font-sample {
  margin-top: 10px; padding: 10px 12px;
  border: 1px dashed $border; border-radius: 6px;
  font-size: 13px; color: $text; background: $bg;
}
.ts-mode-block {
  border: 1px solid $border; border-radius: 10px;
  background: $panel; padding: 12px 16px 6px;
  &.dark { background: $panel; }
}
.ts-mode-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.ts-mode-name {
  font-size: 12px; letter-spacing: 2px; color: $muted;
  display: flex; align-items: center; gap: 8px;
}
.sw { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.sw-light { background: #fff; border: 1px solid $border; box-shadow: 0 0 0 2px color-mix(in srgb, $primary 15%, transparent); }
.sw-dark { background: #0c1420; border: 1px solid rgba(0, 229, 255, 0.4); box-shadow: 0 0 0 2px color-mix(in srgb, $primary 15%, transparent); }
.ts-mode-actions { display: flex; gap: 6px; }
.ts-mode-btn {
  background: transparent; border: 1px solid $border; color: $muted;
  font-family: inherit; font-size: 11px; border-radius: 4px;
  padding: 2px 10px; cursor: pointer;
  &.active { color: $primary; border-color: $primary; }
}
.ts-color-row {
  display: flex; align-items: center; gap: 10px; padding: 5px 0;
  .ts-label { width: 76px; color: $text; font-size: 12px; }
  .ts-code { color: $muted; font-size: 11px; font-family: var(--bd-font); flex: 1; }
}
.ts-note { color: $muted; font-size: 11px; margin-top: 10px; }

/* ── 实时预览(模拟门户界面) ── */
.pv-shell {
  border-radius: 8px; overflow: hidden;
  display: flex; min-height: 380px;
  font-family: var(--bd-font);
  background: var(--pv-bg);
}
.pv-sidebar {
  width: 132px; flex-shrink: 0; padding: 14px 10px;
  background: var(--pv-sidebar);
  border-right: 1px solid var(--pv-border);
  .pv-logo {
    display: flex; align-items: center; gap: 6px;
    font-size: 10px; letter-spacing: 1px; color: var(--pv-text);
    font-weight: 700; margin-bottom: 14px;
    i { width: 6px; height: 6px; background: var(--pv-primary); border-radius: 50%; box-shadow: 0 0 6px var(--pv-primary); }
  }
  .pv-menu {
    display: flex; flex-direction: column; gap: 8px;
    font-size: 11px; color: var(--pv-muted);
    span { padding: 3px 6px; border-radius: 4px; }
    .pv-menu-active { color: var(--pv-primary); background: color-mix(in srgb, var(--pv-primary) 8%, transparent); }
  }
}
.pv-main {
  flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px;
}
.pv-card {
  border: 1px solid var(--pv-border); border-radius: 8px;
  background: var(--pv-panel); padding: 12px;
}
.pv-card-head {
  font-size: 11px; letter-spacing: 2px; color: var(--pv-muted);
  margin-bottom: 10px;
}
.pv-badges { display: flex; gap: 6px; margin-bottom: 10px; }
.pv-badge {
  font-size: 10px; padding: 1px 8px; border-radius: 9px;
  &.pv-badge-run { color: #3b82f6; background: color-mix(in srgb, #3b82f6 14%, transparent); }
  &.pv-badge-ok { color: #10b981; background: color-mix(in srgb, #10b981 14%, transparent); }
}
.pv-bar {
  height: 5px; border-radius: 3px; background: var(--pv-bg);
  margin-bottom: 10px; overflow: hidden;
  i { display: block; height: 100%; background: var(--pv-primary); border-radius: 3px; }
}
.pv-lines {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 12px; color: var(--pv-text);
  .pv-muted { color: var(--pv-muted); font-size: 11px; }
}
.pv-btn {
  margin-top: 12px; display: inline-block;
  font-size: 11px; padding: 5px 14px; border-radius: 4px;
  color: var(--pv-bg); background: var(--pv-primary); font-weight: 600;
}
.pv-table {
  border: 1px solid var(--pv-border); border-radius: 8px; overflow: hidden;
  background: var(--pv-panel);
  .pv-tr {
    display: grid; grid-template-columns: 1fr 90px 70px; gap: 8px;
    padding: 7px 12px; font-size: 11px; color: var(--pv-text);
    border-bottom: 1px solid var(--pv-border);
    &:last-child { border-bottom: none; }
  }
  .pv-th { color: var(--pv-muted); font-size: 10px; background: var(--pv-bg); letter-spacing: 1px; }
  .pv-ok { color: var(--pv-primary); }
}
.pv-mode-switch {
  display: flex; border: 1px solid var(--bd-border); border-radius: 4px; overflow: hidden;
  button {
    background: transparent; border: none; color: var(--bd-muted);
    font-family: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer;
    &.active { background: var(--bd-primary); color: var(--bd-bg); font-weight: 600; }
  }
}
</style>
