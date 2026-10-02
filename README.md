# 大肥鱼 QQ Agent 插件备份


| 文件夹 | 版本 | 内容 |
| --- | --- | --- |
| `qq-whale-extensions` | 1.0.2 | 隐藏关系与性格、创建者 `/ds` 命令、关系调整与恶作剧 |
| `qq-whale-social` | 1.1.1 | B站搜索、资料与字幕、视频画面；空间与好友动态；自主发说说、回复一级评论 |
| `qq-whale-signature` | 1.0.0 | 读取及自主修改机器人自己的个性签名 |
| `qq-whale-video-frames` | 1.0.0 | FFmpeg 本地视频抽帧能力，供 B站技能与 QQ Agent 视频读取使用 |

合计六项扩展：三个插件、三个技能。每个包保留源码、设置清单、测试及原有说明；前三包还含服务器/本地安装器。原始项目和安装 ZIP 另保留在 `D:\project`。

## 恢复安装包

下载此仓库并解压，在根目录打开 PowerShell，运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1
```

安装 ZIP 生成在 `dist`。脚本会下载固定版本 FFmpeg 9.0.2，核验 SHA256，再放入视频插件；不需要 npm 安装。已有依赖 ZIP 时可避免重复下载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-packages.ps1 -ArchivePath 'D:\project\qq-whale-video-dependencies\ffmpeg-9.0.2-essentials_build.zip'
```

也可只恢复视频插件的两个程序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-ffmpeg.ps1
```

FFmpeg 二进制体积超过普通 GitHub 单文件上限，仓库保留固定下载信息、校验值、构建说明及 GPL 许可证，二进制由恢复脚本取得。源码校验清单在 `backup-manifest.json`；可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-backup.ps1` 核验。安装 ZIP 的校验值在 `dist\SHA256SUMS.txt`。

## 在服务器安装

1. 把生成的 ZIP 传到服务器，解压到 QQ Agent 安装目录之外。
2. **完全退出 QQ Agent，包括托盘图标。**
3. 基础扩展、B站与空间、个性签名：分别运行包内的 `install-server.bat`。它使用当前 Windows 用户的 `%LOCALAPPDATA%\Programs\QQ Agent`。其他安装位置使用 `install.bat` 并填写实际路径。
4. 视频抽帧：把 `qq-whale-video-frames\plugins\whale-video-frames` 整个文件夹（含 `bin`）复制到服务器的 `QQ Agent\resources\app\plugins\whale-video-frames`。
5. 重新启动 QQ Agent，先在「隐藏关系与性格」插件设置中填写自己的创建者 QQ，再在「插件」页确认三个插件启用，在「技能」页确认三个技能启用。B站与空间、个性签名若采用创建者请求模式，也需填写各自的创建者 QQ。视觉模型应支持图片输入，视频读取方式选择「自动」或「抽帧」。

升级后只点击刷新可能仍使用旧的依赖模块缓存；需要退出托盘并重新启动。QQ Agent 更新安装版时可能移除自行添加的扩展，届时按以上方式重新安装。

## 自主行为与登录状态

当前默认允许机器人自主发说说、回复评论及修改个性签名，均受持久化限频控制：发说说每天最多 3 次、间隔至少 4 小时；回复一级评论每天最多 10 次、间隔至少 10 分钟；改签名每天最多 2 次、间隔至少 12 小时。限频并非定时任务，模型仍需在聊天或主动机会中选择调用工具。

公开变体的创建者 QQ 默认留空，不绑定任何个人账号。关系扩展、恶作剧和创建者专属命令在没有有效创建者 QQ 时不执行；B站与空间、个性签名的请求模式也会拒绝未配置创建者的请求。自主模式及限频保持不变。已经保存的有效设置仍会使用。

B站 Cookie 默认留空，需登录的字幕可在技能设置中填写。视频抽帧本身不依赖字幕，也不提供完整音频转录。空间读取与写入仍需机器人登录账号已有权限及对应协议接口。

此备份不包含实际 Cookie、API 密钥、QQ Agent 配置、关系数据、限频记录、聊天存档、诊断配置或视频图片。恢复插件后，运行状态继续使用服务器现有数据目录；这些个人运行数据如需迁移，应另行保存。

## 验证和来源

既有测试与验证记录保留在各包 `test` 和 `VALIDATION.md`。开发测试需 Node.js 20 或以上；真实加载器测试可通过环境变量 `QQ_WHALE_UPSTREAM` 指向 QQ Agent 源码。视频测试还需先恢复 FFmpeg。部分验证记录引用历史本机诊断文件，这些抓取结果没有收入仓库。

上游：[K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)。FFmpeg 固定构建：[Gyan 9.0.2 essentials](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip)，SHA256 为 `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`；构建来源和许可随视频插件保存。此备份未为自有插件另行声明开放源码许可证。
