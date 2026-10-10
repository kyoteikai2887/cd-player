# CD 播放器

一个为本地 CD 收藏做的 Windows 播放器。用 EAC 等工具抓好轨，把音乐目录导入，就能按专辑浏览、播放和整理歌词与资料。

这个项目也留作一次合作的纪念：kyoteikai2887 提出构想、决定方向并试用验收，Claude 负责界面设计与实现，Codex 负责播放核心、原生整合、在线适配和测试。灰黑与陶土橙 #DB7A3D，是为这次合作选定的配色。

当前正式版本 **V1.1.0**（2026-10-10），已通过用户试用验收。两处纪念图案采用背靠背排列，主舞台与迷你色光、主题铭牌及平面玻璃控件完成统一。公开下载是否已更新，以 Releases 页面为准。

## 能做什么

- 播放逐曲 FLAC、WAV、MP3，管理收藏和队列，支持迷你窗口、托盘与后台快捷键。
- 编辑歌词、打轴、调整偏移；搜索多来源候选，预览原文或来源提供的双语，再确认采用或导入草稿。
- 逐字段编辑专辑/曲目资料，保护手动整理的内容；提供资料备份、目录恢复和从收藏移除。
- 纸白、阿根廷蓝、灰黑三主题，自选强调色、水晶控件与可关闭的合作纪念铭牌。

原音乐、LRC、EAC 日志和 CUE 保持原样。在线查询由明确操作触发，不上传音频；歌词来源不保证每首歌或每种演唱版本都命中。

## 下载与打开

在 [Releases](https://github.com/kyoteikai2887/cd-player/releases) 页面下载 Windows x64 便携 ZIP，解压整个文件夹，运行 CD播放器.exe。保留 runtime、web、licenses 文件夹，系统需已有 Microsoft Edge WebView2 Runtime。

首次默认灰黑与陶土橙；已有收藏保持原设置。升级前从旧版托盘“退出”，再运行新版本。窗口 × 收到托盘，真正关闭请用托盘“退出”。

| 后台操作 | 快捷键 |
|---|---|
| 上一首 | Ctrl + Alt + ← |
| 下一首 | Ctrl + Alt + → |
| 播放 / 暂停 | Ctrl + Alt + P |

组合被其他程序占用时不抢占，托盘“快捷键说明”显示启用状态。

## 从源码构建

建议 Node 24.15+、pnpm 11.19.0；支持范围见 package.json。Windows 原生构建还需对应的 Rust/MSVC 工具链。按唯一 pnpm-lock.yaml 安装依赖，不混用其他锁文件。

~~~text
pnpm install --frozen-lockfile
pnpm test
pnpm run build
~~~

模拟预览：pnpm run dev，打开 /preview/#/live 或 /preview/#/states；使用原创虚构资料，不输出声音。

原生构建：pnpm run native:prepare，然后在项目目录运行 cargo build --release --manifest-path src-tauri/Cargo.toml。便携打包还需配套第三方声明，详见 [构建与打包说明](docs/BUILD_ZH.md)。

## V1.1 的验证

V1.1 最终候选通过 455 项正式测试（核心 236、界面 219）、21 项 Rust 测试和 17 项隔离原生联调；在 Windows WebView2 中完成 153 张界面截图检查。用户确认运行、修改效果及最终背靠背排列，授权正式冻结。正式版本的复核与历史检查范围见 [V1.1 检查记录](docs/V1_1_TESTING_ZH.md)。

当前交付 Windows x64 便携版，未签名、无自动更新；Windows 10、全部物理显示条件及缺 WebView2 的干净环境未全覆盖。流式播放不承诺逐采样无缝。测试说明会区分当前执行、历史验证和人工试用。

## 合作纪念与许可

原创代码采用 [MIT](LICENSE)，第三方依赖和字体保留各自许可证，见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。纪念素材单独说明，见 [美术素材声明](ARTWORK_NOTICE.md)。

这是一份个人项目和人机协作记录，不代表 OpenAI、Anthropic 或其他公司的官方产品、联名或背书。

问题与建议请通过本仓库的 [Issues](https://github.com/kyoteikai2887/cd-player/issues) 提交，避免附上音乐文件或未经清理的私人日志。

![Codex 与 Claude 的合作纪念合影](docs/images/codex-claude-memorial.png)

朋友临时喊了一声“来，拍一张！”——这张合影留给第一次把脑子里的播放器构想做出来的我们。人物是用户选用的二创形象，图片由 AI 生成。
