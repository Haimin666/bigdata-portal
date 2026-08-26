<script setup lang="ts">
/**
 * EChart —— echarts 薄封装(2026-08,Phase E):
 * 按需引echarts(core + 用到的图/组件),props 传 option 自动 setOption(notMerge=false 增量更新),
 * 容器尺寸变化自动 resize(useResizeObserver),主题跟随全局明暗。卸载自动 dispose。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, PieChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useResizeObserver } from '@vueuse/core'
import { getTheme } from '@/utils/theme'

// 按需注册(体积最小化;后续需要新图型在此追加)
echarts.use([BarChart, PieChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

import type { EChartsOption } from 'echarts'

const props = defineProps<{
  option: EChartsOption
  /** 高度 css 值(默认撑满父容器) */
  height?: string
}>()

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, getTheme() === 'dark' ? 'dark' : undefined, { renderer: 'canvas' })
  chart.setOption(props.option)
})

watch(
  () => props.option,
  (opt) => {
    chart?.setOption(opt, { notMerge: false }) // 增量更新:series 数据变化平滑过渡
  },
  { deep: true }
)

// 容器尺寸自适应
useResizeObserver(el, () => chart?.resize())

onBeforeUnmount(() => {
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" class="echart-box" :style="{ height: height || '100%' }"></div>
</template>

<style scoped>
.echart-box {
  min-height: 0;
  width: 100%;
}
</style>
