export interface MenuItem {
  path: string
  title: string
  name: string
  icon: string
  kind: 'native' | 'subapp'
  url?: string
  // 多用户体系上线后已移除子应用自动登录字段(原 login?: 'ds' | 'omd' | 'stingray')
  /** 原生 iframe 直连(同源代理或跨源直连) */
  iframe?: boolean
  /** 仅开发态展示的试验性功能(如 demo) */
  dev?: boolean
}

export const menus: MenuItem[] = [
  {
    path: '/users',
    title: '用户管理',
    name: 'userManage',
    icon: 'User',
    kind: 'native'
  },
  {
    path: '/dataleap',
    title: 'DataLeap 实验',
    name: 'dataleap',
    icon: 'Connection',
    kind: 'native'
  },
  {
    path: '/yarn', title: 'YARN 应用', name: 'yarn', icon: 'Monitor', kind: 'native' },
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
    path: '/db-query',
    title: '数据库查询',
    name: 'dbQuery',
    icon: 'Coin',
    kind: 'native'
  },
  {
    path: '/query',
    title: '即时查询',
    name: 'stingray',
    icon: 'Search',
    kind: 'subapp',
    // 同源代理路径 + 原生 iframe:网关注入脚本修正 React basename 路由,
    // 会话 cookie 种在门户域(避免跨源 iframe 第三方 cookie 被 Chrome 阻止导致登录失败);
    // 多用户体系上线后不再自动登录,由用户在页面内自行登录
    url: '/apps/stingray/login',
    iframe: true
  },
  {
    path: '/ds',
    title: '离线开发',
    name: 'ds',
    icon: 'Odometer',
    kind: 'subapp',
    url: '/apps/dsweb/ui/#/home',
    // 原生 iframe 同源代理:海豚前端依赖 JS 读 cookie,沙箱不兼容 → 直接 iframe
    // 不再自动登录,由用户在页面内自行登录
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
  },
  {
    path: '/jupyter',
    title: 'Jupyter开发',
    name: 'jupyter',
    icon: 'Notebook',
    kind: 'subapp',
    // 同源代理路径 + 原生 iframe:网关把 /apps/jupyter 反代到宿主机 jupyter(host 网络 8888),
    // base_url=/apps/jupyter 使其页面/API/ws 路径自带前缀;认证沿用 jupyter 自身密码,
    // 首次打开手动登录一次,cookie 种在门户域,切 tab 后 kernel 状态保留
    url: '/apps/jupyter/lab',
    iframe: true
  },
  {
    path: '/omd',
    title: '数据血缘',
    name: 'omd',
    icon: 'DataLine',
    kind: 'subapp',
    // 跨源 iframe 直连(OpenMetadata 无 X-Frame-Options 限制,认证为 localStorage token 非 cookie)
    url: 'https://omd.corp.shiqiao.com/',
    iframe: true
  },
  {
    path: '/mail',
    title: '邮件系统',
    name: 'mail',
    icon: 'Message',
    kind: 'subapp',
    // 同源代理 iframe:门户 /apps/mail 反代 → Windows 节点 portproxy → 内网邮件 Web(9.32.47.24)
    // cookie 种在门户域(跨源 iframe 第三方 cookie 会被 Chrome 拒),首次打开手动登录
    url: '/apps/mail/creditreference/mail/tmw/75/login.jsp',
    iframe: true
  },
  {
    path: '/assistant',
    title: '开发助手',
    name: 'devAssistant',
    icon: 'Robot',
    kind: 'native'
  },
  {
    path: '/sync',
    title: '数据同步',
    name: 'sync',
    icon: 'Refresh',
    kind: 'native'
  }
]
