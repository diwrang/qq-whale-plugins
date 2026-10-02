# 小鲸鱼 · 视频抽帧插件

为现有 B站工具和 QQ Agent 自带视频读取提供 `video.frames` 与 `video.frames.available`。不新增聊天工具，不修改 QQ Agent 核心。

## 安装

将本包 `plugins\whale-video-frames` 文件夹复制到服务器：

`%LOCALAPPDATA%\Programs\QQ Agent\resources\app\plugins\whale-video-frames`

该文件夹的 `bin` 下应有配套 `ffmpeg.exe`、`ffprobe.exe`。打开 QQ Agent 的插件页并刷新，确认“小鲸鱼 · 视频抽帧”生效。视频理解方式使用“自动”或“抽帧”；视觉模型需要支持图片输入。若已有其他提供 `video.frames` 的插件，只保留其中一个开启。

程序路径留空时使用插件内部 `bin`，也可在本插件设置中填写本地程序绝对路径。无需把程序放在系统 PATH；QQ Agent 核心的辅助元信息探测可能仍提示 PATH 没有 ffprobe，但本插件会用自带 ffprobe 读取实际时长再抽帧。

默认4张，最多8张，最长边640像素，每张JPEG最多1MB。关闭插件或改变其设置会终止正在抽帧的任务。输入仅接受普通本地视频文件，上限200MB；不直接让 ffmpeg 访问网络。所有输出在独占临时文件夹中，返回后清理。

抽帧能看到取样时间点的画面，不能代表完整视频、连续动作或声音。B站没有可访问字幕时，本插件不会自动转录语音。

## 验证

在本包目录运行 `node --test test/*.test.mjs`。测试真实生成短视频、抽取JPEG并检查类型、时间点、停用中止和临时文件清理。配置 `QQ_WHALE_UPSTREAM` 为 QQ Agent 源码根目录后，还会用真实加载器、能力管理器和 VideoReader 验证。
