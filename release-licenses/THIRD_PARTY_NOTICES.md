# 第三方依赖与许可证

原创项目代码使用 MIT；下列依赖与字体继续使用各自许可证，不能据项目 MIT 声明重新授权。准确版本以 pnpm-lock.yaml 与 src-tauri/Cargo.lock 为准。

Windows 便携包随附 licenses/：完整 Node.js 24.19.0 LICENSE、npm / Rust 组件声明、字体 OFL 和美术声明。源码对应集合在 release-licenses/。INDEX.json 有 1218 条记录，保守覆盖开发与其他平台依赖，不表示都编入当前程序。

| 组件 | 用途 | 许可 |
|---|---|---|
| React / React DOM | 界面 | MIT |
| music-metadata 11.16.1 | 音乐标签、时长、封面 | MIT |
| Tauri 2.12.1 / windows-sys 0.61.2 | Windows 原生壳与系统接口 | MIT OR Apache-2.0 |
| Node.js 24.19.0 | 随附的本地服务运行时 | 完整 Node LICENSE，含上游声明 |
| @breezystack/lamejs 1.2.7 | 仅测试生成合成 MP3，不用于产品播放 | LGPL-3.0 |
| Noto Sans CJK / Noto Serif CJK | 中文与日文子集 | SIL OFL 1.1 |
| Instrument Serif / Crimson Pro | 拉丁字母衬线字体 | SIL OFL 1.1 |

字体子集与完整 OFL 位于 src/ui/fonts/，生成工具位于同目录 tools/。组件没有为本项目修改。MPL-2.0 的 cssparser 0.37.0、cssparser-macros 0.7.1、dtoa-short 0.3.5、option-ext 0.2.0 的对应未修改源码随 licenses/sources/（源码树中 release-licenses/sources/）提供。其他组件可按锁文件版本从官方仓库或包注册表获取。

Node.js 对应源码：https://github.com/nodejs/node/tree/v24.19.0 。Tauri：https://github.com/tauri-apps/tauri 。music-metadata：https://github.com/Borewit/music-metadata 。

本项目独立适配歌词提供方的普通响应，没有嵌入 LDDC 的 Python/Qt 引擎、解密或登录代码；在线内容不随程序、演示或源码分发。原始音乐及商业封面不包含在公开材料中。美术范围另见根目录 ARTWORK_NOTICE.md。

候选修复版补齐 webview2-com 0.39.1、webview2-com-sys 0.39.1 和 webview2-com-macros 0.8.1 的 MIT 正文；这些版本原已在 Cargo.lock 中，通过缓存包的来源提交获取同一上游仓库的完整许可。windows-core 0.62.2 的 MIT / Apache-2.0 正文已随原集合提供。
