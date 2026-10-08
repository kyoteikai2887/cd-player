# CD 播放器 v0.2.0 冻结行为约定

冻结日期：2026-10-03。唯一正式契约：`src/contracts/player.ts`，`CONTRACT_VERSION = '0.2.0'`。本文件取代第二轮提案的行为说明。冻结的是 UI 与核心的边界；最初交付为模拟集成基线，目前 Codex 已在边界内接入本地导入、持久化和浏览器真实音频，进度与验证见 `CORE_M1_ZH.md`。WebView2 与原生窗口仍待接入，本文件的行为约定不变。

## 1. 单一状态、结果与时间边界

核心拥有播放、队列、已保存歌词和资料库。UI 只拥有导航、搜索、弹层、预览值和未保存草稿。UI 不做播放状态的乐观更新，不原地修改快照。

`getSnapshot()` 在两次发布之间返回同一个对象。发布创建新顶层对象；只有位置变化时，`player.queue`、当前 `lyrics`、`library`、`settings` 保持引用。换曲同时发布 `currentTrackId`、`currentEntryId` 和匹配的新曲歌词；真实核心尚未加载文档时允许 `lyrics=null`，UI 也检查 trackId。

`dispatch/onAction` 的每个 Promise 都必须结算。普通请求时限 5 秒；无响应返回 `unavailable`。长操作尽快建立任务并返回 `started + taskId`，不能把文件选择或网络等待塞进未结算的普通请求。模拟后台查询时限 30 秒、导入 120 秒，生产适配器可调整后台时限，须记入验证记录。超时或断开后，迟到响应不得继续提交；原生写入还需请求 ID、取消检查与事务边界，单靠 Promise 超时不能撤销已经持久化的写入。

结果规则：`applied` 表示完成，生产保存须已持久化；模拟基线只写内存。`started` 表示任务启动，后续成功/失败由关联快照、tasks 和后台通知表达。`cancelled` 是正常取消，UI 不提示。`ok:false` 由 UI 就地显示，核心不能为同一失败再发 Notice；Notice 用于后台失败、播放错误、文件丢失等被动事件。已返回 started 后取消任务，移除活动任务、丢弃迟到结果，安静结束。取消前已完成的安全提交保留。

UI 150ms 未收到结果时只在对应按钮显示进行中。保存/应用防重复提交，不阻塞播放控制。销毁 surface 的桥接连接只释放该连接，不停止独立播放服务。模拟入口由 `MockSession` 管理后台生命周期。

## 2. 显示时钟与歌词纯函数

位置默认 5Hz 推送，状态突变立即发布；`sampleSequence` 在引擎会话内递增，真实适配器丢弃旧样本。`positionSampledAt` 必须转换到接收 WebView 的单调时间基准，与 positionMs 对应同一采样时刻；两个原生窗口不可直接共用一个窗口的 performance 时间值。当前浏览器演示的两个 surface 在同一页面，使用同一时间域。

```text
age = clamp(localNow - positionSampledAt, 0, 750)
renderPos = clamp(positionMs + (status == playing ? age : 0), 0, durationMs)
```

只有 playing 外推，最多 750ms；暂停、buffering、idle、error 不外推。进度、数字和歌词共享 renderPos。收到样本、换曲、seek、文档或可见性变化时取消旧预约并重算。可见且播放时进度使用 rAF/WAAPI，数字约 4Hz，歌词预约下一边界；到外推上限停止。减少动效仍更新当前行。浏览器入口目前直接呈现样本，正式显示时钟与调度由 Claude 实现。

共享模块 `src/core/lyrics.ts` 的固定签名（类型都来自契约）：

```ts
parseLyrics(text: string, trackId: string, options?: LyricsParseOptions): LyricsDocument
attachTranslation(draftLines: readonly LyricLine[], translationLines: readonly LyricLine[], toleranceMs?: number): LyricsPairingResult
activeLyricIndex(lines: readonly LyricLine[], renderPos: number, offsetMs?: number): number
nextLyricBoundary(lines: readonly LyricLine[], renderPos: number, offsetMs?: number): number | null
validateLyricsEdit(edit: LyricsEdit): LyricsValidationIssue[]
serializeLyrics(edit: LyricsEdit, options?: LyricsSerializeOptions): string
```

均为纯函数，不依赖 Node/DOM 内建模块、没有导入副作用、不修改输入。UI 可导入这六个函数，不导入队列或桌面服务。新增行 ID 由 UI 生成并保证文档内唯一；保存后以核心快照为准。

`nextLyricBoundary` 返回**下一个边界在播放时间轴上的绝对毫秒值**，已加用户 offset；空白行也算边界，无下一边界或未同步时返回 null。预约延迟用 boundary−renderPos，并受外推上限约束。当前行先找最近边界，原文空白则 −1，不能继续高亮上一句。

文件 offset 与用户 offset 分开：`startMs = rawStartMs − fileOffsetMs`，`有效时间 = startMs + userOffsetMs`。文件 offset 在解析时折叠一次，用户 offset 初始 0；负时间保留。编辑器显示有效时间，保存时换回 startMs；打轴记录 renderPos−offsetMs。点击同步歌词 seek 到 clamp(有效时间,0,duration)，未同步文本不 seek。实际播放时间始终为权威，不保证真实解码器报告位置一定大于 seek 目标。

默认重复时间戳合并为同一原文组；显式 bilingual 模式将第一条视为原文，其余为译文，不猜语言。独立译文默认容差 100ms，双方归一化时间作双向唯一最近邻配对；等距、未配对、无时间内容给警告，不按行号强配。普通文本按行对齐必须是用户确认后的草稿操作。语言未知为 null，译文不自动繁简转换。

序列化合并用户偏移一次。有效时间集合 E，S=max(0,−min(E))，写 E+S 与 `[offset:+S]`，回读恢复 E，新的用户 offset 为 0。普通文本导出为文本。多行原文同时带译文的 LRC 有歧义，当前实现明确报错，可改为仅原文导出；不承诺所有外部播放器的 offset 解释与本项目相同。

验证器与 saveLyrics 调用同一份规则：整数有限时间/offset、同步时间升序且每个时间一个组、普通文本时间 null、文档内唯一非空 ID、文本字段正确、空原文不得单独带译文、语言标记或 null。清空用 `kind:'missing',lines:[]`。

## 3. 编辑、草稿导入、查找与冲突

Album、Track、LyricsDocument 各有 revision。内容、offset、锁定和分类写入递增；仅播放位置、查询进度不递增。updateAlbum/updateTrack/saveLyrics/setLyricsOffset/setNoLyrics/pickCoverImage 检查 baseRevision。文件选择返回后再检查，过期不提交。importLyrics 的 document 路线省略基准时，开始即捕获当前 revision。

`importLyrics.destination` 默认 document。`editorDraft` 只解析文件、折叠文件 offset，向已打开编辑器发布 `pendingImport`，不配对草稿、不保存、不递增 revision。UI 按 pendingImport.id 本地去重，无 ack 动作；译文由 UI 用 attachTranslation 与**当前草稿**配对。编辑器关闭后重开的旧导入结果必须丢弃。模拟实现以编辑会话编号校验，并防止同曲多个草稿导入同时运行。

冲突返回 conflict，编辑器快照带最新已保存文档；UI 保留草稿，提供载入最新、比较、明确用草稿覆盖（最新 revision 重提）。核心不会自动改写 UI 草稿。偏移快调本地预览、约 400ms 停止后串行提交；同曲编辑器打开时禁用快调，转到编辑器。

查找规则冻结为**只填缺失部分**：missing 可补原文；原文已有时不替换原文，只在时间和内容配对干净的前提下补缺失译文，已有译文保留。查询中和失败时保留旧内容。locked 的显式查找返回 locked，自动任务跳过；替换通过编辑/导入。生产匹配必须区分版本并校验时长；模拟候选门槛为时长差≤max(2秒,本曲时长1%)，这不代表真实提供商匹配已完成。候选选择后续扩展，不进入此次类型冻结。

setNoLyrics 的 instrumental/spoken 是用户明确标记，不从文件名、版本或空查询推断。保留可恢复内容，kind=null 撤销标记，恢复旧内容或 missing；含转录正文的念白仍用 plain/synced。清空歌词是 saveLyrics(missing,[])，与标记无歌词不同。人工更改的部分来源标为 manual，仅调整 offset 保留正文来源。

## 4. 元数据、封面与队列

credit 原样展示 CV、角色和多歌手署名，artists 是结构化数组；不从 credit 自动拆分，不重拼显示串。实际手动修改字段加入 userEditedFields；封面更换保护 cover。曲号/碟号更改更新专辑排序，不重启当前播放或改写既有队列上下文。

MetadataReview 持有 id 和 baseLibraryRevision；applyMetadataCandidate 校验审阅、候选、changeIds。confirmedProtectedChangeIds 是本次选择中需明确替换的受保护字段子集。过期整次 conflict，提交原子化，替换后继续受保护。cover 的 from/to 为 `CoverPreview | null`，CoverPreview 是 `{thumbUrl,width?,height?}`。URL 由桥接提供，UI 不自行拼文件路径。

队列项有唯一 ID，重复曲目用 currentEntryId 高亮。playAlbum 起点须属于专辑且可用；playTracks.startIndex 按原数组解释。shuffle 省略保留偏好，仅随机当前之后的队列。手动 next 不受 repeat-one 限制；自然结束受 repeat-one/all 控制。previous 超过 3 秒先回曲首。

enqueue 不自动播放，next 插当前之后；删除非当前项不断音，删除当前项走原下一项，无后续则停止清空当前；重排按最终 toIndex 并保持当前 entry 身份。显式插入/删除/重排使可见顺序成为新的关闭随机基准。空资料库返回结构化结果。不可用项须解释并提供重扫入口；真实跳过提示由原生接入阶段补齐。真正 gapless 由音频引擎实现，UI 不以定时 next 模拟。

抓轨 log/CUE 原样保留；hasLog/hasCue 只表示存在，AccurateRip 未核验保持 unknown。V1 不内置抓轨。

## 5. 两个窗口、未保存退出与能力降级

原生 main/mini 是两个独立窗口，共用后台核心。主窗口使用原生标题栏，迷你无边框。切换先显示目标成功，再隐藏旧窗口；主窗口**隐藏且保留 WebView**，不销毁页面、导航、滚动和草稿。浏览器基线同样保留两个 mounted surface，并以 hidden 控制显示。

迷你 × 和主窗口关闭均 hideToTray；迷你展开为 setWindowMode(full)。这是已有默认值，本轮不再新增用户阻塞项。托盘退出才真正终止进程。UI 在 dirty 状态变更时报告 reportUnsavedChanges；只要任一 surface dirty，原生退出确认，取消保留草稿。隐藏、切换和断开 surface 不清除 dirty。`exitGuard.ts` 已实现跨 surface 判定和确认期间版本变化防护，真实托盘/原生确认框尚待接入。编辑器自身关闭由 UI 先提醒。

透明能力由 host.capabilities.transparentWindow 决定：true 时 12px 透明边、CSS 阴影、24px 圆角；false 时铺满客户区、不预留透明边。实际原生圆角用 host.nativeCornerRadius=0|8，Win11 成功启用为 8，其他情况可为 0；不能假设所有系统都拥有 Win11 圆角。backdrop/native capability 均表示实际结果，不能以窗口尺寸猜测。

迷你内容参考 360×92/360×140 CSS px；有透明边时客户区再加 24。具体外观可以按设计调整，如涉及原生尺寸则通过变更记录同步 Codex。开启歌词增高时钳制到工作区，底部空间不足向上生长；DIP/DPI、工作区和失败回退由原生适配器验证。迷你 fontScale 显示上限 1.1，不改写全局字号；歌词条只对 synced 显示，开关默认关闭。

按主键且移动>4px 才 beginWindowDrag，适配器接受 pointerdown 后按键仍按住时的稍晚调用；按钮/进度条不作拖动区。原生拖动浏览器不支持。窗口仅在本 surfaceVisible false→true 时入场；隐藏/文档不可见停止无用动画与预约，音频继续。减少动效关闭位移、缩放和旋转，保留信息更新；高对比度/禁用透明/强度0回退实色。媒体键和系统控件只由 Codex 原生层处理。

## 6. 用户要求与 Claude 的设计自由

用户已确认：light 默认蓝白浅色；blue 为浅蓝底配深色文字；迷你当前歌词有开关、默认关闭；初期≤300首，不先做虚拟滚动。采用简体中文界面、译文原样保留、workTitle 简单分组。CD 转动默认关闭。字体与歌词字号独立，fontScale 0.85–1.3、lyricsScale 0.8–1.5、glassIntensity 0–1；accentColor 只接受 #RRGGBB。UI 派生足够对比度的强调文字色，不保证任意用户强调色直接作正文都可读。

**用户在本轮追加授权：给 Claude 更高的具体 UI 设计自由度，按她的审美做出她认为美观的方案，只要不偏离基础要求。** 布局、留白、字体层级、图标、材质、阴影、配色细节、信息呈现和动效由 Claude 主导。现有 starter UI 只是验证接点的外壳，无需照着复刻；提案中的纯视觉数值视为设计参考，可在基础主题、可读性、状态和窗口行为保持正确的前提下调整。调整纯视觉方案不需要逐项审批；涉及接口、共享模块或原生尺寸/行为的改动走变更记录协调。

语言优先可信元数据，明显假名可作 UI 显示提示，否则继承专辑，未知不硬补 ja；UI 推断从不写回数据。新的 CSS 功能先能力检测并提供回退。settings.ui 按 main/mini 的顶层键合并，内部对象/数组整项替换；不存播放时钟或编辑草稿。

## 7. 分工、预览和验收

Codex：contracts、core、DemoBridge、bridge、app/main 装配、真实导入/播放/持久化/资料查询/原生和系统集成。Claude：src/ui、fixtures 内容扩充、preview、UI hooks/调度与组件测试。`src/mock/fixtures.ts` 保留公共路径，改成 createDemoLibrary/createDemoLyrics/createDemoSettings/createDemoData 工厂；本基线已同步迁移全部引用。后续导出名变更先记录请求。

preview 用静态快照和只记日志、可选返回 applied/started/cancelled/conflict 的动作桩，不另造时钟/队列/持久化桥接；可交互演示使用 createMockBridge({surface,scenario})，两窗口演示用同一个 createMockSession 的两个连接。初始 scenario 与现有测试见 TESTING.md。场景内容全为原创虚构。

共享契约只编辑 src/contracts/player.ts，改动走 docs/CONTRACT_REQUESTS.md，升级版本并生成交付副本。一份 pnpm-lock.yaml；npm test 与 pnpm test 均指向同一个测试脚本（依赖安装使用 pnpm）。核心 Node，UI Vitest/Testing Library/jsdom。

Claude 先通读迁移后的 core/lyrics.ts、createMockBridge.ts、fixtures 模块，再开始 R1：主题、主要静态视图与全部状态预览供用户评审；R2 加歌词跟随/跳转、编辑、候选差异和迷你交互。Codex 同期推进真实导入与音频通路。

完整 V1 尚需真实 FLAC/MP3/WAV 播放、seek、连续专辑 gapless、窗口隐藏不断音、原生退出保护/媒体键、持久化和资料补全。视觉至少验证 1280×800、960×600、迷你两种高度/透明降级、100%/150% DPI、放大字号、键盘、减少动效与高对比度。TESTING 分开记录浏览器、WebView2、原生窗口和真实音频，模拟通过不能替代这些验收。
