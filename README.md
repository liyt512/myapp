# 留白（安卓）

黑白风格的日常分享应用原型，使用原生 Android 外壳打开本地页面。照片和视频通过安卓系统文件选择器添加，页面数据目前以演示为主。

## 在 Android Studio 中运行

1. 使用 Android Studio 打开本目录。
2. 安装 Android SDK Platform 36 和 Build Tools 36.0.0。
3. 选择 Run 安装到安卓手机，或运行 `gradle assembleDebug` 生成 APK。

APK 默认输出到 `app/build/outputs/apk/debug/app-debug.apk`。

## GitHub Actions

推送到 GitHub 后，`.github/workflows/android.yml` 会自动构建 Debug APK，并把 APK 保存为工作流产物，供下载到安卓手机安装。

## 当前范围

当前版本是可继续开发的安卓 MVP 原型。好友推荐、点赞和评论是本地演示交互；多用户账号、跨设备好友关系、动态同步、消息推送和云端媒体存储需要后端服务。阿里云服务器可以用于部署这些后端功能。
