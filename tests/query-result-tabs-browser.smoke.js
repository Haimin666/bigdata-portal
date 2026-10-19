// Start Vite, then run:
// playwright-cli -s=query-result-tabs-smoke open http://127.0.0.1:3002
// playwright-cli -s=query-result-tabs-smoke run-code --filename tests/query-result-tabs-browser.smoke.js
async page => {
  await page.reload()
  await page.evaluate(async () => {
    const source = await (await fetch('/src/views/db/QueryResults.vue')).text()
    const vueUrl = source.match(/from "([^"]*\/vue\.js[^"]*)"/)[1]
    const { createApp, h, ref, nextTick } = await import(vueUrl)
    const mainSource = await (await fetch('/src/main.ts')).text()
    const elementPlusUrl = mainSource.match(/from "([^"]*element-plus\.js[^"]*)"/)[1]
    const { default: ElementPlus } = await import(elementPlusUrl)
    const { default: QueryResults } = await import('/src/views/db/QueryResults.vue')
    const results = ref(['A', 'B', 'C', 'D'].map((id) => ({
      sql: `select '${id}'`,
      columns: ['value'],
      rows: [{ value: `result-${id}` }],
      costMs: 1,
      truncated: false
    })))
    const activePane = ref(1)
    const root = document.createElement('div')
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white'
    document.body.appendChild(root)
    const menuLayer = document.createElement('style')
    menuLayer.textContent = '.result-tab-context-menu { z-index: 100000 !important; }'
    document.head.appendChild(menuLayer)
    window.__resultTabsTest = { results, activePane, nextTick }
    createApp({
      render: () => h(QueryResults, {
        results: results.value,
        activePane: activePane.value,
        db: 'test',
        engineLabel: 'MySQL',
        loading: false,
        onSelect: (pane) => { activePane.value = pane },
        onClose: (idx) => {
          results.value.splice(idx, 1)
          if (activePane.value === idx + 1) activePane.value = results.value.length ? Math.min(idx + 1, results.value.length) : 0
          else if (activePane.value > idx + 1) activePane.value -= 1
        }
      })
    }).use(ElementPlus).mount(root)
  })

  const tab = (index) => page.locator('.result-tab').nth(index + 1)
  await tab(2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭左侧' }).click()
  if (await page.locator('.result-tab:not(.log-tab)').count() !== 2) {
    throw new Error('close-left should keep the target and all tabs to its right')
  }
  await page.locator('.result-table').getByText('result-C').waitFor()

  await tab(0).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭右侧' }).click()
  if (await page.locator('.result-tab:not(.log-tab)').count() !== 1) {
    throw new Error('close-right should remove all tabs to the target right')
  }
  await page.evaluate(async () => {
    window.__resultTabsTest.results.value = ['E', 'F', 'G'].map((id) => ({
      sql: `select '${id}'`, columns: ['value'], rows: [{ value: `result-${id}` }], costMs: 1, truncated: false
    }))
    window.__resultTabsTest.activePane.value = 2
    await window.__resultTabsTest.nextTick()
  })

  await tab(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭其他' }).click()
  if (await page.locator('.result-tab:not(.log-tab)').count() !== 1) {
    throw new Error('close-others should keep only the context target')
  }
  await tab(0).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭当前' }).click()
  if (await page.locator('.result-tab:not(.log-tab)').count() !== 0) {
    throw new Error('close-current should remove the context target')
  }
  return { remainingTabs: await page.locator('.result-tab:not(.log-tab)').count() }
}
