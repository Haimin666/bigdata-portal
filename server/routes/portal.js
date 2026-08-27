// 门户配置下发路由(从 index.js 拆出):
// 仅暴露白名单配置(模块列表 / 子应用地址),不泄露账号密码等敏感字段。
import config from '../config.js'

export function setupPortal(app) {
  // 模块显隐(前端菜单根据 enabledModules 渲染)
  app.get('/api/config/modules', (req, res) => {
    res.json({
      code: 0,
      data: {
        // 空数组 = 全部展示;非空 = 仅展示名单内模块(菜单 name)
        enabledModules: config.enabledModules
      }
    })
  })

  // 子应用地址配置(前端 iframe 代理目标渲染用)
  app.get('/api/config', (req, res) =>
    res.json({
      resourceManagers: config.resourceManagers,
      hdfsUrl: config.hdfsUrl,
      dsWebUrl: config.dsWebUrl,
      omdUrl: config.omdUrl,
      stingrayUrl: config.stingrayUrl
    })
  )
}