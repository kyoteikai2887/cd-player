# 契约 0.4.0：歌词候选增量

统一基线 0.4.0-r2.2-core.16。0.3.0 的动作及行为保留；UISnapshot 新增必需的 `lyricsReview: LyricsReview | null`。这次只扩展歌词候选，歌词解析、有效时间、offset、文档 revision 和保存规则不变。

## 搜索与预览

`searchLyricsCandidates({ trackId, query?: { title, artist } })` 尽快返回 started，快照先发布 status=searching，再发布 ready、noResults 或 failed。query 省略时，核心用完整署名、抓轨标签合并署名的片段、曲目的独立歌手及专辑歌手查询，最多三种署名；拆分片段仅用作搜索提示，从不写回歌手资料。不以专辑名称限制候选，以便找到同曲的其他收录。UI 可修改搜索词，但这不会修改本地曲名或署名。用户搜索词 title 必须非空，artist 可为空。

LyricsReview 有 id、trackId、baseRevision（歌词）、baseTrackRevision、baseAlbumRevision、query、status、candidates、error。每个候选有不透明 id、provider、recordId、title、artistCredit、albumTitle、durationMs、durationDeltaMs、match、warnings、document。durationDeltaMs 是来源时长减本地时长；缺失时长为 null。document 为使用共享解析器处理后的预览副本，不能把前端改过的副本提交为候选原文。

最多 12 个候选，按曲名/版本/时长接近程度、同步歌词、同专辑、时长差排序。match=close 仅代表曲名及版本标记吻合、时长差 ≤2 秒，不是“已验证正确”；署名及专辑差异仍会出现在 warnings 中。match=check 要人工核对。库内时间轴、演唱版本、原创与翻译质量没有获得自动保证。所有候选都需用户明确采纳，搜索和预览不保存。

## 采纳与草稿

`applyLyricsCandidate({ trackId, reviewId, candidateId, destination?: 'document' | 'editorDraft' })` 只提交三个标识及目标；核心采用私有保存的候选原文。

- document 为默认值，只能补 kind=missing 的歌词，保留用户 offset，经同一事务和备份机制落库，并递增 revision。已有原文、纯音乐/念白不能直接替换。
- editorDraft 要求此曲目的歌词编辑器仍打开，通过已有 pendingImport 发布 content=original 的解析行、language、warnings；不写库、不递增 revision。UI 复用现有导入草稿流程，用户之后明确保存。候选不凭空补译文。
- 两种路径都检查歌词/曲目/专辑的 revision、锁定、曲目是否仍存在及候选有效期（30 分钟）。过期或查询期间发生相关修改返回 conflict，拒绝写入；移除返回 notFound，锁定返回 locked。UI 保留草稿并提示重新搜索，不自动重试或偷偷覆盖。
- 成功采纳后消费候选并关闭 review，不能重复使用。草稿导入返回时编辑器已关闭或换曲，不把迟到结果塞进另一个编辑器。

`closeLyricsReview` 关闭并取消进行中的候选查询；cancelTask 也可取消该任务。关闭后迟到成功或失败都不能重新打开候选或发通知。搜索失败展示在 review.error，采纳失败由 ActionResult 就地展示，不重复 Notice。不做乐观写入。

## 与原查找的关系

原 lookupLyrics 保留严格补缺行为：曲名、完整署名、专辑、时长差 ≤2 秒都吻合才采用。扩大查询只发生在用户明确搜索候选时，不把候选搜索变成后台模糊替换。已有歌词及锁定状态保持原语义。

本轮来源仍是 LRCLIB；多来源接入另行对齐，不假称有全覆盖数据库。HTTPS、请求限速、超时、取消、缓存与响应校验复用原在线层。候选任务预算 45 秒，失败不缓存成成功。音乐、文件路径、草稿和完整收藏不上传。生产服务和 DemoBridge 都支持本增量，静态预览底座已补 lyricsReview=null。
