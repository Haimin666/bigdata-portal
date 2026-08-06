const CRED_KEYS: Record<string, [string, string]> = {
  ds: ['dswebUser', 'dswebPass'],
  omd: ['omdUser', 'omdPass'],
  stingray: ['stingrayUser', 'stingrayPass']
}

/**
 * 调用网关自动登录端点,把原系统登录态种到门户域 cookie。
 * 凭证优先级:localStorage > 后端环境变量(网关侧兜底)。
 * localStorage 未配置时发送空凭证,由网关环境变量(DSWEB_USER 等)兜底。
 */
export async function loginToService(service: 'ds' | 'omd' | 'stingray'): Promise<void> {
  const [userKey, passKey] = CRED_KEYS[service]
  const user = localStorage.getItem(userKey) ?? ''
  const password = localStorage.getItem(passKey) ?? ''
  const res = await fetch(`/api/login/${service}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password })
  })
  const data = await res.json().catch(() => ({ ok: false, msg: '登录响应解析失败' }))
  if (!data.ok) {
    throw new Error(data.msg || '登录失败')
  }
}
