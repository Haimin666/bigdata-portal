export interface MenuItem {
  path: string
  title: string
  name: string
  icon: string
  kind: 'native' | 'subapp'
  url?: string
  login?: 'ds' | 'omd' | 'stingray'
  /** 原生 iframe 直连(同源代理或跨源直连) */
  iframe?: boolean
}

export const menus: MenuItem[] = [
  { path: '/yarn', title: 'YARN 应用', name: 'yarn', icon: 'Monitor', kind: 'native' },
  {
    path: '/ds-task',
    title: '任务监控',
    name: 'dsTask',
    icon: 'Timer',
    kind: 'native'
  },
  {
    path: '/hdfs',
    title: 'HDFS',
    name: 'hdfs',
    icon: 'Folder',
    kind: 'native'
  },
  {
    path: '/ds',
    title: '海豚调度',
    name: 'ds',
    icon: 'Odometer',
    kind: 'subapp',
    url: '/apps/dsweb/ui/#/home',
    login: 'ds',
    // 原生 iframe 同源代理:海豚前端依赖 JS 读 cookie,沙箱不兼容 → 直接 iframe
    iframe: true
  },
  {
    path: '/query',
    title: '即时查询',
    name: 'stingray',
    icon: 'Search',
    kind: 'subapp',
    // 同源代理路径 + 原生 iframe:网关注入脚本修正 React basename 路由,
    // 会话 cookie 种在门户域(避免跨源 iframe 第三方 cookie 被 Chrome 阻止导致登录失败)
    url: '/apps/stingray/login',
    login: 'stingray',
    iframe: true
  },
  {
    path: '/omd',
    title: '我的数据',
    name: 'omd',
    icon: 'DataLine',
    kind: 'subapp',
    // 跨源 iframe 直连(OpenMetadata 无 X-Frame-Options 限制,认证为 localStorage token 非 cookie)
    url: 'https://omd.corp.shiqiao.com/',
    iframe: true
  },
  {
    path: '/streamx',
    title: '实时开发',
    name: 'streamx',
    icon: 'Cpu',
    kind: 'subapp',
    // 跨源 iframe 直连(StreamX hash 路由,无 X-Frame-Options 限制)
    url: 'https://streamx.corp.shiqiao.com/#/login?redirect=/flink/app',
    iframe: true
  }
]
