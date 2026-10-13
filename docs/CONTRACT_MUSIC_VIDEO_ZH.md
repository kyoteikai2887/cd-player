# 本地 MV 关联接口 v0.5.0

日期：2026-10-11。这是 V1.1 冻结后的开发接口，不是已发布版本。

## 产品范围

用户只需要把已经导出的 MKV MV 关联到对应专辑，再用 PotPlayer 观看。
不复制或移动视频，不保留 ISO，不读取 DVD，不做提取、转码、缩略图生成、内置视频播放。
MV 不属于音乐曲目，不参与音乐队列、随机播放、曲目数和专辑音频时长。
关闭 PotPlayer 不会自动恢复音乐；用户可以自行继续播放。

## 数据

`snapshot.library.albums[i].musicVideos?: MusicVideo[]`：旧库可缺省，按空数组处理。

```ts
interface MusicVideo {
  id: string;
  revision: number;
  title: string;
  fileName: string;
}
```

名称初始来自文件名，支持改名（去除首尾空白后 1–200 字符，无控制字符）。
fileName 仅用于识别关联文件，不是完整路径，也不能拼接成 URL。
本轮不提供时长、文件大小、缩略图、自动缺失扫描。不要虚构这些信息，也不要显示未实际检测的“文件可用”。

`snapshot.settings.potPlayerConfigured?: boolean` 是只读状态：true 表示已有播放器路径，
不代表刚刚验证过文件仍存在。false/undefined 表示未指定，首次播放会尝试查找常见安装位置。
此字段不属于 SettingsPatch，禁止用 updateSettings 设置它。

全部绝对路径只在本地核心持有，不进入 UI 快照、调试提示或公共演示数据。
关联与设置通过现有原子写入、备份和旧库读取机制保存。

## 操作

UI 必须使用既有 onAction / PlayerBridge；不直接调用 fetch、invoke、文件系统或 shell。

| 操作 | 参数 | 行为 |
| --- | --- | --- |
| addMusicVideo | albumId | 打开单选 MKV 文件选择器，记录位置；同专辑相同路径不重复添加 |
| relinkMusicVideo | albumId, videoId, baseRevision | 重新选择 MKV，保留原名称与 ID，revision +1 |
| renameMusicVideo | albumId, videoId, baseRevision, title | 修改显示名称，不改磁盘文件名，revision +1 |
| removeMusicVideo | albumId, videoId, baseRevision | 仅移除关联，绝不删除视频 |
| playMusicVideo | albumId, videoId | 检查文件和播放器后，交给 PotPlayer |
| pickPotPlayer | 无 | 手动选择 PotPlayer 程序，可用于便携版 |
| detectPotPlayer | 无 | 查找 Program Files、Program Files (x86)、LocalAppData/Programs 下常见安装目录 |

addMusicVideo、relinkMusicVideo、pickPotPlayer、detectPotPlayer 返回 started/taskId，
使用现有 snapshot.tasks / notices 接收完成、取消、失败。不要把 started 当成已经成功保存。
文件选择器取消不产生新关联，不应弹成功提示。
其它操作返回 applied 或错误；不能先乐观移除/暂停/改名再忽略错误。
所有界面应以随后收到的快照为准，不在 UI 私存第二份资料库。

baseRevision 是当前 MusicVideo.revision，不是 Album.revision 或 library.revision。
同一 MV 的陈旧改名、移除、重新关联会返回 conflict。
选择文件期间专辑被移除，会取消或拒绝添加。
移除整张专辑也会移除其 MV 关联，但保留磁盘视频。

## 播放与错误

播放调用 Windows 进程 API，文件名作为独立参数传入 PotPlayer；不会改变默认应用关联。
成功启动后核心暂停正在播放/缓冲的音乐，保留队列、当前曲目和位置。
文件缺失、播放器不存在或启动失败时，不暂停音乐、不删除关联。
“启动成功”表示 Windows 接受了进程启动，不等于已经验证 PotPlayer 解码成功。
不监控 PotPlayer 退出，不自动续播，不保证强制置前。

错误沿用 OperationError：
- fileMissing：文件移动/不可访问；提供“重新关联…”或播放器设置入口。
- notFound：关联/专辑不存在，或自动检测未找到播放器。
- invalidAction：重复关联、非 MKV、名称错误、非 PotPlayer 程序。
- conflict：资料已变化；保留改名草稿，读取最新快照后让用户重试。
- io/unavailable：启动失败、正忙或取消/超时；展示后端返回的说明。

MKV 验证读取容器头，不是完整解码检查。导出正确性和真实音画播放留到实际素材验收。

## Claude 可使用的演示支持

```ts
createMockSession({ autoTick: false, musicVideos: true })
createMockSession({ autoTick: false, musicVideos: true,
  videoError: { code: 'fileMissing', message: '找不到 MKV 文件，请重新关联文件位置。' } })
```

musicVideos:true 在首张虚构专辑放两条演示记录，并显示播放器已配置。
模拟的添加、重新关联、改名、移除、播放器设置可交互；播放只产生演示提示，不访问本机程序。
videoError 会让 MV/播放器相关操作失败，可用于失败态验证。
默认 mock 的文件选择是即时模拟，不验证 Windows 文件选择器/进程行为。
Claude 可修改 preview/ 接入 URL 参数或增加静态状态，但不要修改核心 mock 实现或接口。

## UI 建议与自由度

专辑详情页增加轻量的“附带影像”区域，已有 MV 时展示名称与明确的播放入口。
无 MV 的专辑不必留大块空白，可从“更多 → 关联 MV…”进入。
每条提供改名、重新关联、移除关联；“移除关联”不可写成“删除文件”。
设置中增加 PotPlayer 的检测/选择入口和简短状态。
具体位置、密度、图标、细节与轻量动效由 Claude 判断，延续现有三主题和平面玻璃风格。
保留音乐为主的视觉层级，避免额外的影视资料库导航或播放器控件。

验收包括键盘可达、弹窗焦点返回、长中日文名称、无 MV、一条/两条 MV、
未配置播放器、文件缺失、取消选择、保存冲突、三主题、窄窗口、高对比度和 reduced motion。
