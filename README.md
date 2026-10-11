# 留白（安卓）

黑白颜文字风格的好友日常应用。安卓客户端连接留白 API 后，可以注册账号、搜索好友并发送/处理好友申请；好友之间可同步文字、照片、视频、配乐、点赞和评论，也可以删除自己发布的日常。

## 在 Android Studio 中运行

使用 Android Studio 打开本目录。项目需要 Android SDK Platform 36 和 Build Tools 36.0.0。运行 `gradle assembleDebug` 可构建 Debug APK。

APK 输出到 `app/build/outputs/apk/debug/app-debug.apk`。客户端可以在注册页填写 HTTPS 服务器地址。构建者也可以通过 Gradle 属性 `LIUBAI_API_URL` 预填地址；不要把真实服务器地址、令牌或密码提交到公开仓库。

## 后端服务

`server/` 目录包含 Node.js API 服务，使用 SQLite 保存用户、好友关系、动态、点赞和评论；上传的媒体文件保存在服务器持久目录。部署前需要设置随机 `JWT_SECRET`，并由 Nginx 提供 HTTPS。

```sh
cd server
npm ci
JWT_SECRET="替换为至少 32 字节的随机值" npm start
```

建议将 API 仅绑定本机地址，并放在配置好 HTTPS 的反向代理之后。数据库和媒体目录应放在仓库目录之外并做好备份。媒体支持常见 JPEG/PNG/WebP/GIF 图片、MP4/WebM/MOV 视频和 MP3/M4A/AAC/WAV/OGG 音频；单个照片或视频最多 50 MB，音频最多 20 MB。

## 好友使用方法

每位使用者先创建自己的账号，再把账号名告诉朋友。好友页搜索账号名或昵称并发送申请；对方接受后，双方的好友日常会出现在动态列表。

## 配乐

曲目名称用于标记日常；想让好友试听，请上传自己有权分享的音频文件。应用不附带或托管未经授权的商业歌曲。

## GitHub Actions

推送到 `main` 或 `master` 后，GitHub Actions 会构建 Debug APK，并将其保存为工作流产物。若要让工作流预填服务器地址，应通过私有构建配置注入，不要写进公开源码。
