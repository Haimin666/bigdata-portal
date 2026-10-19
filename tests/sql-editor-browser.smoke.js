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

  await page.evaluate(() => {
    window.__sqlTest.setValue('select foobar, foo, FOO;', { silent: true })
    window.__sqlTest.setSelection({ line: 1, ch: 15 }, { line: 1, ch: 18 })
  })
  await page.waitForFunction(() => {
    const editor = window.__sqlMonaco.editor.getEditors()[0]
    return editor.getModel().getAllDecorations().some((d) => d.options.className === 'portal-selection-match')
  })
  const highlightRanges = await page.evaluate(() => {
    const editor = window.__sqlMonaco.editor.getEditors()[0]
    return editor.getModel().getAllDecorations()
      .filter((d) => d.options.className === 'portal-selection-match')
      .map((d) => [d.range.startColumn, d.range.endColumn])
  })
  if (highlightRanges.length !== 1 || highlightRanges[0][0] !== 8) {
    throw new Error(`same-substring highlight mismatch: ${JSON.stringify(highlightRanges)}`)
  }
  results.push({ name: 'same-substring-highlight', highlightRanges, pass: true })

  await page.evaluate(() => {
    window.__sqlTest.setValue('SELECT customer_name FROM orders WHERE customer_name = \'alice\';\nSELECT customer_name FROM orders;', { silent: true })
    const editor = window.__sqlMonaco.editor.getEditors()[0]
    editor.focus()
  })
  await page.keyboard.press('Control+f')
  await page.locator('.find-widget.visible').waitFor()
  const findInput = page.locator('.find-widget textarea[aria-label="Find"]')
  await findInput.fill('customer_name')
  await page.locator('.find-widget .matchesCount').waitFor()
  const findCount = await page.locator('.find-widget .matchesCount').innerText()
  if (!findCount.includes('1 of 3')) throw new Error(`find match count mismatch: ${findCount}`)
  results.push({ name: 'canvas-keyword-search', findCount, pass: true })
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__sqlMonaco.editor.getEditors()[0].focus())
  await page.keyboard.press('Meta+f')
  await page.locator('.find-widget.visible').waitFor()
  results.push({ name: 'canvas-keyword-search-cmd-f', pass: true })
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    window.__sqlTest.setValue('', { silent: true })
    const editor = window.__sqlMonaco.editor.getEditors()[0]
    editor.setPosition({ lineNumber: 1, column: 1 })
    editor.focus()
  })
  await page.keyboard.press('Control+Tab')
  const singleLineIndent = await page.evaluate(() => window.__sqlTest.getValue())
  if (singleLineIndent !== '  ') throw new Error(`Ctrl+Tab cursor indent failed: ${JSON.stringify(singleLineIndent)}`)
  results.push({ name: 'ctrl-tab-cursor-indent', value: singleLineIndent, pass: true })

  await page.evaluate(() => {
    window.__sqlTest.setValue('SELECT 1;\nSELECT 2;', { silent: true })
    const editor = window.__sqlMonaco.editor.getEditors()[0]
    editor.setSelection(new window.__sqlMonaco.Range(1, 1, 2, 10))
    editor.focus()
  })
  await page.keyboard.press('Control+Tab')
  const multiLineIndent = await page.evaluate(() => window.__sqlTest.getValue())
  if (!multiLineIndent.startsWith('  SELECT 1;\n  SELECT 2;')) {
    throw new Error(`Ctrl+Tab multiline indent failed: ${JSON.stringify(multiLineIndent)}`)
  }
  results.push({ name: 'ctrl-tab-multiline-indent', value: multiLineIndent, pass: true })
  return results
}
