# CD 播放器

一个为本地 CD 收藏做的 Windows 播放器。用 EAC 等工具抓好轨，把音乐目录导入，就能按专辑浏览、播放和整理歌词与资料。

这个项目也留作一次合作的纪念：kyoteikai2887 提出构想、决定方向并试用验收，Claude 负责界面设计与实现，Codex 负责播放核心、原生整合、在线适配和测试。灰黑与陶土橙 #DB7A3D，是为这次合作选定的配色。

当前正式版本 **V1.2.1**（2026-10-13），已通过用户最终试用验收。包含 MKV MV／PotPlayer 联动、随真实音乐变化的点阵与注意力连线、星轨玻璃蚀刻、连续长尾与头部辉光，以及迷你音量。星轨补齐边缘与同环分段，取消小碎片例外，隐藏行程加速通过；流光恢复适量混白。

使用说明见 [V1.2 说明](docs/V1_2_USER_GUIDE_ZH.md)，Windows 检查见 [正式验证记录](docs/V1_2_1_TESTING_ZH.md)。

## 能做什么

- 播放逐曲 FLAC、WAV、MP3，管理收藏和队列，支持迷你窗口、托盘与后台快捷键。
- 主舞台音乐点阵、注意力连线与星轨流光；迷你窗口按需展开音量控件，支持主／迷你双向同步。
- 专辑关联本地 MKV MV，通过 PotPlayer 观看；只保存文件位置，不复制或删除视频。
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

## V1.2 的验证

正式版通过 529 项正式测试（核心 249、界面 280）、21 项 Rust 测试和 17 项隔离原生回归；WebView2 缓冲／流式音频分别通过 19／18 项集成检查。Windows Edge 的 54 个布局场景和 25 张流星关键帧检查通过。用户已确认前轮效果，最后两项流光调整完成后按授权本地冻结。检查范围与验证边界见 [V1.2 检查记录](docs/V1_2_TESTING_ZH.md)，[V1.1 历史记录](docs/history/V1_1_TESTING_ZH.md)保留原版本归属。

当前交付 Windows x64 便携版，未签名、无自动更新；Windows 10、全部物理显示条件及缺 WebView2 的干净环境未全覆盖。流式播放不承诺逐采样无缝。测试说明会区分当前执行、历史验证和人工试用。

## 合作纪念与许可

原创代码采用 [MIT](LICENSE)，第三方依赖和字体保留各自许可证，见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。纪念素材单独说明，见 [美术素材声明](ARTWORK_NOTICE.md)。

这是一份个人项目和人机协作记录，不代表 OpenAI、Anthropic 或其他公司的官方产品、联名或背书。

问题与建议请通过本仓库的 [Issues](https://github.com/kyoteikai2887/cd-player/issues) 提交，避免附上音乐文件或未经清理的私人日志。

![Codex 与 Claude 的合作纪念合影](docs/images/codex-claude-memorial.png)

朋友临时喊了一声“来，拍一张！”——这张合影留给第一次把脑子里的播放器构想做出来的我们。人物是用户选用的二创形象，图片由 AI 生成。
