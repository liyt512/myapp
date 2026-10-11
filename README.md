# 留白（安卓）

黑白颜文字风格的日常分享应用原型。支持发布文字、选择照片或视频、挑选配乐，提供好友推荐、好友申请、好友列表和申请记录。

## 在 Android Studio 中运行

1. 使用 Android Studio 打开本目录。
2. 安装 Android SDK Platform 36 和 Build Tools 36.0.0。
3. 选择 Run 安装到安卓手机，或运行 `gradle assembleDebug` 生成 APK。

APK 默认输出到 `app/build/outputs/apk/debug/app-debug.apk`。

## GitHub Actions

推送到 GitHub 后，`.github/workflows/android.yml` 会自动构建 Debug APK，并把 APK 保存为工作流产物，供下载到安卓手机安装。

## 当前范围

好友申请、好友列表、点赞和评论保存在本机，仅用于原型演示；多用户账号、真实好友关系、动态同步和云端媒体存储仍需部署后端服务。配乐列表包含 28 首示例曲目，目前保存并显示曲名；实际播放与线上曲库需要接入有授权的音源。