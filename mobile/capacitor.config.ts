import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.shiqiao.bigdataportal',
  appName: '大数据门户',
  webDir: 'dist',
  server: {
    url: 'https://bigdata-portal.corp.shiqiao.com/mobile/',
    androidScheme: 'https',
    cleartext: false
  },
  android: { allowMixedContent: false }
}

export default config
