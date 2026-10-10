# 源码构建与打包

Windows 原生构建需要 Windows x64、Microsoft Edge WebView2 Runtime、Visual Studio C++ / Windows SDK、Rust MSVC（最低版本见 Cargo.toml，目前为 1.99），以及 Node / pnpm。验证使用 Node 24.19.0、pnpm 11.19.0。源码不包含工具链或已安装依赖。

在仓库根目录执行：

~~~text
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run native:prepare
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo build --release --locked --manifest-path src-tauri/Cargo.toml
node --experimental-strip-types scripts/package-portable.ts --output ../CD_Player_V1.1.0_Windows_x64_Portable --licenses release-licenses
~~~

打包目录必须不存在；脚本拒绝覆盖，并检查原生 exe 的真实版本资源。runtime 与 web 同 exe 一起分发，根目录许可文件也会带入。native:prepare 随包复制运行它的 Node.exe，使用其它 Node 版本时应重新核对对应完整 LICENSE，不要沿用 24.19.0 的声明。

release-licenses/ 对应当前锁文件，其中有 Node 完整声明、字体和依赖许可，以及四项 MPL 依赖未修改源码。更新任何依赖后都需重新核对许可证集合与源码提供范围。默认关闭 Tauri 安装器构建，V1.1 交付的是便携版。

预览：pnpm run dev，打开 /preview/#/live 或 /preview/#/states。演示内容为原创虚构资料，不输出声音。可用 node scripts/native-smoke.mjs --stale-lock --relocated 运行隔离原生冒烟；需先有 debug 原生构建并允许其打开测试窗口。不会读取默认收藏。额外联网或真实设备检查应单独执行并记录，正式单元测试本身不访问真实歌词服务。

私人的角色参考、铭牌加工原稿与交接记录不在公开源码中；运行图、字体、图标和合影已保留。工具中如有作者用的出图脚本，需自行准备其输入素材；这些脚本不参与应用构建。

公开二进制构建时，为避免 Rust 诊断字符串带入维护者的本地用户名，发布者可在 PowerShell 中设置以下环境变量后执行 release 构建（依赖也会重新编译）：

~~~powershell
$env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE=C:\build-user"
cargo build --release --locked --manifest-path src-tauri/Cargo.toml
~~~

这只重映射编译时路径，不改变收藏目录或运行功能。正式便携包不包含 PDB 或调试程序。

Tauri 的生成代码还可能记录工程目录。公开构建应在不含个人用户名的临时目录中进行，并对最终 exe、服务文件与 ZIP 做隐私扫描；本次发布使用 C:\Temp 下的独立目录。


V1.1 保留可选的铭牌加工代码，以便核对背靠背排列的生成顺序。人物原图和刻字蒙版没有公开；如需重新出图，请自行准备 source/codex.png、source/claude.png 和 text/line.png。应用构建只使用已经生成的六张 WebP，不依赖这些私人输入。公开美术回归以最终运行素材的 SHA256 核对已验收版本。
