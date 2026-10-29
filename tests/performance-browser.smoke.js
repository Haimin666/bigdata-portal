// Start Vite on 3032; run using playwright-cli run-code --filename this file.
async page => {
  await page.unrouteAll({behavior:'ignoreErrors'});
  const counts = { apps: 0, disk: 0, db: 0 };
  await page.route('**/*', async route => {
    const u = {pathname: route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]};
    if (!/^\/(api|hadoopapi|static\/jmx|webhdfs)(\/|$)/.test(u.pathname)) return route.continue();
    let body = {};
    if(u.pathname === '/api/auth/me') body = {code:0,data:{username:'perf',role:'dev',modules:['yarn','hdfs','dbQuery'],initialized:true}};
    else if(u.pathname === '/api/config') body = {resourceManagers:['http://fixture'],enabledModules:['yarn','hdfs','dbQuery']};
    else if(u.pathname.endsWith('/apps')) { counts.apps++; body = {apps:{app:[]}}; }
    else if(u.pathname.includes('/static/jmx')) { counts.disk++; body = {beans:[]}; }
    else if(u.pathname.includes('/api/db')) { counts.db++; body = {code:0,data:[]}; }
    else if(u.pathname.includes('/webhdfs')) body = {FileStatuses:{FileStatus:[]}};
    await route.fulfill({json:body});
  });
  try {
    await page.addInitScript(() => {
      if (location.protocol !== 'http:') return;
      sessionStorage.setItem('portal-open-tabs:perf',JSON.stringify(['/yarn','/hdfs','/db-query']));
      localStorage.setItem('autoRefresh','false');
    });
    await page.goto('http://127.0.0.1:3032/yarn', {waitUntil:'domcontentloaded', timeout:10000});
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia?._s.has('yarn'), null, {timeout:10000});
    await page.waitForTimeout(1500);
    const initial = {...counts, mounted:await page.locator('.view-item').count()};
    const before = counts.apps;
    for(const user of ['a','ab','abc']) {
      await page.evaluate(user => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('yarn').filters.user=user,user);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
    const filterRequests = counts.apps-before;
    await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/hdfs'));
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/yarn'));
    await page.waitForTimeout(300);
    const diskBefore = counts.disk;
    await page.waitForTimeout(31000);
    await page.waitForTimeout(300);
    const hiddenDiskRequests = counts.disk-diskBefore;
    const metrics = {initial,filterRequests,hiddenDiskRequests};
    console.log(JSON.stringify(metrics));
    if (initial.mounted!==1 || initial.disk!==0 || filterRequests!==1 || hiddenDiskRequests!==0) throw new Error('Performance lifecycle regression: '+JSON.stringify(metrics));
    return metrics;
  } finally {
    await page.goto('about:blank');
    await page.unrouteAll({behavior:'wait'});
  }
}
