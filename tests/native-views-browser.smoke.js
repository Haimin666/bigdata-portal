// Start Vite dev server, then run:
// playwright-cli -s=native-smoke open http://127.0.0.1:3002
// playwright-cli -s=native-smoke run-code --filename tests/native-views-browser.smoke.js
// Mount TabStage directly to verify async native views, the 200ms skeleton fallback and
// menu-hover prefetch, independently of gateway authentication.
async page => {
  const pageErrors = []
  const onPageError = err => pageErrors.push(String(err.message))
  const hdfsChunkPattern = '**/src/views/hdfs/HdfsView.vue*'
  const hdfsApiPattern = '**/webhdfs/v1/**'
  const jmxApiPattern = '**/static/jmx*'

  try {
    // Mock cluster traffic from the real HDFS component used in the isolated test app.
    await page.route(hdfsApiPattern, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ FileStatuses: { FileStatus: [] } })
    }))
    await page.route(jmxApiPattern, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ beans: [] })
    }))
    // Delay the HDFS chunk so the 200ms delay + ViewLoading skeleton actually shows.
    await page.route(hdfsChunkPattern, async route => {
      await page.waitForTimeout(800)
      await route.continue()
    })
    await page.reload()
    page.on('pageerror', onPageError)

    await page.evaluate(async () => {
      const stageSource = await (await fetch('/src/layouts/components/TabStage.vue')).text()
      // Reuse the exact dependency URLs Vite rewrote in the component, avoiding duplicate runtimes.
      const vueUrl = stageSource.match(/from "([^"]*\/vue\.js[^"]*)"/)[1]
      const routerUrl = stageSource.match(/from "([^"]*vue-router\.js[^"]*)"/)[1]
      const mainSource = await (await fetch('/src/main.ts')).text()
      const elementPlusUrl = mainSource.match(/from "([^"]*element-plus\.js[^"]*)"/)[1]
      const piniaUrl = mainSource.match(/from "([^"]*pinia\.js[^"]*)"/)[1]
      const { createApp } = await import(vueUrl)
      const { createRouter, createMemoryHistory } = await import(routerUrl)
      const { default: ElementPlus } = await import(elementPlusUrl)
      const { createPinia } = await import(piniaUrl)
      const { default: TabStage } = await import('/src/layouts/components/TabStage.vue')

      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }]
      })
      // HDFS 故意延迟加载;征信字典作为不访问集群的快速视图对照。
      await router.push('/hdfs')
      await router.isReady()

      const nativeTab = name => ({ path: `/${name}`, menu: { name, kind: 'native' }, refreshKey: 0 })
      const root = document.createElement('div')
      root.id = 'native-smoke-root'
      root.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff'
      document.body.appendChild(root)

      const app = createApp(TabStage, { tabs: [nativeTab('creditDictionary'), nativeTab('hdfs')], collapsed: false })
      app.use(createPinia())
      app.use(ElementPlus)
      app.use(router)
      app.mount(root)
      window.__nativeSmokeApp = app
    })

    const results = []

    // Slow chunk must show the skeleton fallback.
    const slowView = page.locator('#native-smoke-root .view-item').nth(1)
    await slowView.locator('.view-loading').waitFor({ timeout: 3000 })
    results.push({ name: 'slow-view-shows-skeleton', pass: true })

    // Skeleton detaches once the chunk lands and the real view renders.
    await slowView.locator('.view-loading').waitFor({ state: 'detached', timeout: 5000 })
    const renderedItems = await page.locator('#native-smoke-root .view-item').count()
    if (renderedItems !== 2) throw new Error(`view-item 数量不符: ${renderedItems}`)
    results.push({ name: 'slow-view-resolves', renderedItems, pass: true })

    // The fast view resolves without leaving a loading skeleton.
    const leftoverFastSkeleton = await page.locator('#native-smoke-root .view-item').first().locator('.view-loading').count()
    if (leftoverFastSkeleton !== 0) throw new Error(`快视图残留骨架: ${leftoverFastSkeleton}`)
    results.push({ name: 'fast-view-no-skeleton', pass: true })

    // Prefetch must issue a request for a not-yet-mounted view chunk.
    const prefetchRequest = page.waitForRequest(
      req => req.url().includes('/src/views/db/QueryView.vue'),
      { timeout: 5000 }
    )
    await page.evaluate(async () => {
      const { prefetchNativeView } = await import('/src/layouts/components/nativeViews.ts')
      prefetchNativeView('dbQuery')
    })
    await prefetchRequest
    results.push({ name: 'prefetch-issues-view-request', pass: true })

    if (pageErrors.length) throw new Error(`页面运行时错误: ${JSON.stringify(pageErrors)}`)
    results.push({ name: 'no-page-errors', pass: true })
    return results
  } finally {
    await page.evaluate(() => {
      window.__nativeSmokeApp?.unmount()
      delete window.__nativeSmokeApp
      document.querySelector('#native-smoke-root')?.remove()
    }).catch(() => {})
    await page.unroute(hdfsChunkPattern).catch(() => {})
    await page.unroute(hdfsApiPattern).catch(() => {})
    await page.unroute(jmxApiPattern).catch(() => {})
    page.off('pageerror', onPageError)
  }
}
