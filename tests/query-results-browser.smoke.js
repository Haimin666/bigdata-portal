// Start Vite, then run:
// playwright-cli -s=query-results-smoke open http://127.0.0.1:3002
// playwright-cli -s=query-results-smoke run-code --filename tests/query-results-browser.smoke.js
async page => {
  await page.reload()
  await page.evaluate(async () => {
    const source = await (await fetch('/src/views/db/QueryResults.vue')).text()
    const vueUrl = source.match(/from "([^"]*\/vue\.js[^"]*)"/)[1]
    const { createApp, h, nextTick, ref } = await import(vueUrl)
    const mainSource = await (await fetch('/src/main.ts')).text()
    const elementPlusUrl = mainSource.match(/from "([^"]*element-plus\.js[^"]*)"/)[1]
    const { default: ElementPlus } = await import(elementPlusUrl)
    const { default: QueryResults } = await import('/src/views/db/QueryResults.vue')
    const results = ref([{
      sql: 'select value',
      columns: ['value'],
      rows: Array.from({ length: 45 }, (_, i) => ({ value: `row-${i + 1}` })),
      costMs: 1,
      truncated: false
    }])
    const activePane = ref(1)
    const root = document.createElement('div')
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white'
    document.body.appendChild(root)
    window.__resultsTest = { results, activePane, nextTick }
    createApp({
      render: () => h(QueryResults, {
        results: results.value,
        activePane: activePane.value,
        db: 'test',
        engineLabel: 'MySQL',
        loading: false
      })
    }).use(ElementPlus).mount(root)
  })

  await page.locator('.el-pager li').filter({ hasText: /^3$/ }).click()
  await page.locator('.result-table').getByText('row-31').waitFor()

  await page.evaluate(async () => {
    window.__resultsTest.results.value.push({
      sql: 'select few rows',
      columns: ['value'],
      rows: [{ value: 'new-result-1' }, { value: 'new-result-2' }],
      costMs: 1,
      truncated: false
    })
    window.__resultsTest.activePane.value = 2
    await window.__resultsTest.nextTick()
  })

  await page.locator('.result-table').getByText('new-result-1').waitFor()
  const visibleRows = await page.locator('.result-table .el-table__body tbody tr').count()
  if (visibleRows !== 2) throw new Error(`expected 2 rows on new result, got ${visibleRows}`)
  return { visibleRows }
}
