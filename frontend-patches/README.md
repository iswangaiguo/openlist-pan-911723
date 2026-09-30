# 前端补丁维护

`upstream.json` 锁定官方前端版本和应用顺序。每份补丁表示该顺序下的一次功能变更，
需要更新时先按清单应用到干净源码，再修改所属功能并重新生成补丁。
共享文件可能由后续补丁继续修改，不能把单份补丁的反向检查当作整组已应用的证明；
构建脚本会在临时源码副本中按逆序验证整组补丁。

| 补丁 | 负责的内容 |
| --- | --- |
| `directory-navigation.patch` | 目录快照、导航请求协调、列表状态与签名更新 |
| `multipart-resources.patch` | 分段上传协议与资源清理 |
| `upload-defaults.patch` | 默认上传设置 |
| `browser-ui.patch` | 网盘布局、列表和选择界面、公共样式 |
| `file-actions.patch` | 行内改名、文件菜单、分享界面和权限设置 |
| `file-dialogs.patch` | 文件操作弹窗的公共样式、主题、窄屏布局和目录选择界面 |
| `upload-panel.patch` | 全局上传面板、队列、持久恢复、上传后的目录刷新 |
| `storage-usage.patch` | 用量统计、侧栏入口与相关样式 |
| `module-recovery.patch` | 模块加载错误识别、页面错误边界与恢复 |
| `video-buffer.patch` | HLS/mpegts 缓冲配置 |
| `video-recovery.patch` | 普通与转码视频的最终错误恢复实现 |
| `pdf-range.patch` | 本地 PDF.js 预览入口、主题、语言和重试 |

用量统计首次加载仍自动计算全部挂载，并在五分钟内复用缓存。上传完成事件合并后，
只重算上传目录匹配的最具体挂载，其他挂载的已有结果保留；“刷新用量”强制重算全部挂载。
若上传发生在初次统计期间，先完成初次统计，再刷新对应挂载，避免遗漏其他挂载。

本次整理已验证：除用量统计的预期修改，应用新旧补丁得到的源码逐文件一致。
视频恢复已合并为一份最终补丁，不再依赖追加补丁删除之前加入的恢复触发器。

文件操作弹窗通过 `DriveDialogScope` 共用 Dropbox 风格，并把主题传入页面外层的弹窗。
目录选择器的嵌套弹窗也继承该作用域；管理页面使用同一组件时保留原来的样式。

PDF 预览改用固定版本的 PDF.js 完整查看器，构建时由 `scripts/fetch-pdf-viewer.mjs`
下载官方 legacy release 并校验 SHA-256，部署到带版本和集成修订号的本地静态目录。
`pdf-viewer-bridge.mjs` 在初始化前开启 Range，关闭流式整文件下载和自动补取；
源站不支持 Range 时由 PDF.js 回退普通下载。跨域直链仍需要允许 CORS 并暴露
`Accept-Ranges`、`Content-Length`、`Content-Range`。搜索、打印、下载等操作可能继续读取更多数据。
修改桥接脚本时递增目录中的 `openlist` 修订号，同时更新前端补丁的入口路径。
