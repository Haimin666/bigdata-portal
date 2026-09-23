#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/mobile"
ANDROID_DIR="$MOBILE_DIR/android"

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请安装 Node.js 22 或更高版本。"
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || fail "当前 Node.js 版本为 $(node --version)，Capacitor 8 要求 Node.js 22+。"

java_major() {
  local java_bin="$1/bin/java"
  [[ -x "$java_bin" ]] || return 1
  "$java_bin" -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -n 1
}

selected_java_home=""
if [[ -n "${JAVA_HOME:-}" ]]; then
  detected_java_major="$(java_major "$JAVA_HOME" || true)"
  if [[ "$detected_java_major" =~ ^[0-9]+$ ]] && (( detected_java_major >= 17 )); then
    selected_java_home="$JAVA_HOME"
  fi
fi

if [[ -z "$selected_java_home" ]] && [[ "$(uname -s)" == "Darwin" ]] && [[ -x /usr/libexec/java_home ]]; then
  for java_version in 21 17; do
    candidate_java_home="$(/usr/libexec/java_home -v "$java_version" 2>/dev/null || true)"
    detected_java_major="$(java_major "$candidate_java_home" || true)"
    if [[ "$detected_java_major" =~ ^[0-9]+$ ]] && (( detected_java_major >= 17 )); then
      selected_java_home="$candidate_java_home"
      break
    fi
  done
fi

if [[ -z "$selected_java_home" ]] && command -v java >/dev/null 2>&1; then
  candidate_java_bin="$(command -v java)"
  candidate_java_home="$(cd "$(dirname "$candidate_java_bin")/.." && pwd)"
  detected_java_major="$(java_major "$candidate_java_home" || true)"
  if [[ "$detected_java_major" =~ ^[0-9]+$ ]] && (( detected_java_major >= 17 )); then
    selected_java_home="$candidate_java_home"
  fi
fi

[[ -n "$selected_java_home" ]] || fail "未找到 JDK 17+。请安装 JDK 17/21 并设置 JAVA_HOME。"
export JAVA_HOME="$selected_java_home"
export PATH="$JAVA_HOME/bin:$PATH"
printf '使用 JDK %s：%s\n' "$(java_major "$JAVA_HOME")" "$JAVA_HOME"

sdk_dir="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk_dir" && -f "$ANDROID_DIR/local.properties" ]]; then
  sdk_dir="$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" | head -n 1 | sed 's/\\ / /g')"
fi
[[ -n "$sdk_dir" && -d "$sdk_dir" ]] || fail "未找到 Android SDK。请设置 ANDROID_HOME/ANDROID_SDK_ROOT，或在 mobile/android/local.properties 中配置 sdk.dir。"
compile_sdk="$(awk '/compileSdkVersion[[:space:]]*=/ {gsub(/[^0-9]/, "", $3); print $3; exit}' "$ANDROID_DIR/variables.gradle")"
[[ -d "$sdk_dir/platforms/android-$compile_sdk" ]] || fail "Android SDK 缺少平台 android-$compile_sdk：$sdk_dir/platforms/android-$compile_sdk"
export ANDROID_HOME="$sdk_dir"
export ANDROID_SDK_ROOT="$sdk_dir"
printf '使用 Android SDK：%s（API %s）\n' "$sdk_dir" "$compile_sdk"

if [[ ! -d "$MOBILE_DIR/node_modules" ]]; then
  printf '未发现 mobile/node_modules，按 lockfile 安装依赖……\n'
  (cd "$MOBILE_DIR" && npm ci)
fi

printf '\n[1/2] 构建移动端并同步 Android 工程……\n'
(cd "$MOBILE_DIR" && npm run android:sync)

printf '\n[2/2] 构建 Android debug APK……\n'
(cd "$ANDROID_DIR" && ./gradlew assembleDebug)

apk_path="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$apk_path" ]] || fail "Gradle 已结束，但没有找到 APK：$apk_path"
printf '\nAPK 构建完成：%s\n' "$apk_path"
ls -lh "$apk_path"
