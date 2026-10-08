// Start Vite, then run:
// playwright-cli -s=sql-smoke open http://127.0.0.1:3002
// playwright-cli -s=sql-smoke run-code --filename tests/sql-editor-browser.smoke.js
// Mount the real editor independently of gateway authentication and database connectivity.
async page => {
  await page.reload()
  await page.evaluate(async () => {
    const source = await (await fetch('/src/views/db/SqlEditor.vue')).text()
    // Use the component's exact Vue dependency URL to avoid duplicate runtimes after Vite optimization.
    const vueUrl = source.match(/from "([^"]*\/vue\.js[^"]*)"/)[1]
    const { createApp } = await import(vueUrl)
    const { default: SqlEditor } = await import('/src/views/db/SqlEditor.vue')
    const { monaco } = await import('/src/utils/monaco-setup.ts')
    const root = document.createElement('div')
    root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white'
    document.body.appendChild(root)
    window.__sqlMonaco = monaco
    window.__sqlTest = createApp(SqlEditor, {
      modelId: 'completion-smoke',
      themeMode: 'light',
      currentDb: 'test',
      schemaLoader: async () => ({
        tables: [{ name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT' }] }]
      })
    }).mount(root)
  })

  const results = []
  for (const [name, seed, typed, expected] of [
    ['keyword', '', 'sele', 'SELECT'],
    ['identifier', 'select customer_name from orders;\n', 'cus', 'customer_name'],
    ['literal', "select 'success';\nwhere state = '", 'suc', 'success'],
    ['comment', '-- ', 'sele', null],
    ['snippet', '', 'cte', 'cte'],
    ['table-field', 'orders', '.', 'order_id'],
    ['function', '', 'coa', 'COALESCE']
  ]) {
    await page.keyboard.press('Escape')
    await page.evaluate(seed => {
      window.__sqlTest.setValue(seed, { silent: true })
      const editor = window.__sqlMonaco.editor.getEditors()[0]
      const model = editor.getModel()
      editor.setPosition({
        lineNumber: model.getLineCount(),
        column: model.getLineMaxColumn(model.getLineCount())
      })
      editor.focus()
    }, seed)
    await page.keyboard.type(typed, { delay: 50 })
    if (expected) {
      await page.locator('.suggest-widget.visible .label-name').filter({ hasText: expected }).first().waitFor()
    } else {
      await page.waitForTimeout(250)
    }
    const labels = await page.locator('.suggest-widget.visible .monaco-list-row .label-name').allTextContents()
    if (expected ? !labels.includes(expected) : labels.length > 0) {
      throw new Error(`${name} failed: ${JSON.stringify(labels)}`)
    }
    results.push({ name, labels, pass: true })
    if (name === 'keyword' || name === 'snippet') {
      await page.keyboard.press('Tab')
      const value = await page.evaluate(() => window.__sqlTest.getValue())
      if ((name === 'keyword' && value !== 'SELECT') || (name === 'snippet' && !value.startsWith('WITH '))) {
        throw new Error(`Tab accept ${name} failed: ${value}`)
      }
      results.push({ name: `accept-${name}`, value, pass: true })
    }
  }
  return results
}
