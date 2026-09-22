# bigdata-portal mobile

Android 移动端子模块，技术栈为 Vue 3、Ionic Vue 和 Capacitor。

## 本地开发

先在仓库根目录启动网关，再启动移动端：

```bash
cp .env.example .env.local
npm install
npm run dev
```

默认访问 `http://127.0.0.1:3010/mobile/`，Vite 将 API 和子应用路径代理到 `http://127.0.0.1:3000`。

## 校验与 Android 同步

```bash
npm run type-check
npm run build
npm run android:sync
npm run android:open
```

命令行构建 APK 还要求本机安装 Android SDK，并设置 `ANDROID_HOME` 或在 `android/local.properties` 中配置 `sdk.dir`。

## 认证限制

当前门户认证是同源 httpOnly Cookie。生产 Android 固定加载：

```text
https://bigdata-portal.corp.shiqiao.com/mobile/
```

用户必须先连接企业 VPN/零信任。移动页面由门户网关的 `/mobile/` 路径托管，与 API 共用域名和 Cookie；Web 端根地址不变。VPN 未连接、域名不可达或 HTTPS 证书无效时，App 不会降级到明文连接。
