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

## 一键构建 APK

在仓库根目录执行：

```bash
./scripts/build-android-apk.sh
```

脚本会检查 Node.js 22+、JDK 17+ 和 Android SDK，构建移动端资源并同步到 Capacitor，然后生成可直接安装的 debug APK：

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

如果 `mobile/node_modules` 不存在，脚本会先根据 `mobile/package-lock.json` 执行 `npm ci`。Android SDK 优先读取 `ANDROID_HOME` / `ANDROID_SDK_ROOT`，其次读取 `mobile/android/local.properties` 的 `sdk.dir`。默认 `JAVA_HOME` 低于 17 时，macOS 会尝试自动选择已安装的 JDK 21 或 17；其他环境请先设置 `JAVA_HOME`。

当前 Capacitor 配置让 APK 加载门户正式 HTTPS 地址，因此 APK 是移动端容器安装包；移动 Web 功能更新仍需将对应门户代码部署到服务器。

## 认证限制

当前门户认证是同源 httpOnly Cookie。生产 Android 固定加载：

```text
https://bigdata-portal.corp.shiqiao.com/mobile/
```

用户必须先连接企业 VPN/零信任。移动页面由门户网关的 `/mobile/` 路径托管，与 API 共用域名和 Cookie；Web 端根地址不变。VPN 未连接、域名不可达或 HTTPS 证书无效时，App 不会降级到明文连接。
