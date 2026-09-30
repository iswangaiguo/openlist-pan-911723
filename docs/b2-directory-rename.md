# B2 目录重命名：临时路径映射与后台迁移

此方案只适用于使用 Backblaze B2 S3 端点的 `B2`/`S3` 挂载，并要求配置 D1 `DB` binding。普通 S3 存储继续使用已有的分步重命名。B2 没有真正的目录；这里的目录是对象 key 的 prefix。

目录列表、文件预览和子目录查询在同一次读请求内复用按存储划分的任务快照，
用于临时映射、写入状态和关联文件列表。下一次请求重新查询 D1；上传、删除、
改名等写操作的守卫始终实时查询，不使用读快照。

## 用户可见流程

1. 用户把 `/电影` 改为 `/影视`。服务端确认旧 prefix 有对象、新 prefix 不存在，然后在 D1 创建迁移任务。
2. `/fs/rename` 立即返回。目录列表只显示 `/影视`；浏览、下载和播放会在新旧 prefix 中查找，复制过的对象优先使用新 prefix。
3. 任务运行期间，OpenList 暂停对此目录及其后代的上传、删除、再次重命名、移动和复制。列表响应包含 `migration.state`、`migration.processed` 和 `migration.discovered`；`discovered` 是已扫描数，扫描完成前不等于总数。
4. 浏览器可以连续调用 `/fs/rename/b2/step` 加速迁移；每分钟触发的 Worker 定时任务负责在浏览器关闭后继续推进。
5. 旧 prefix 当前可见对象为空、队列全部处理完后，删除 D1 任务和临时映射。此时 OpenList 路径和 B2 当前可见 key prefix 一致。

## 任务状态和恢复

`migrating → verifying → completed`。复制、权限或校验失败时进入 `paused`，保留已完成的对象和临时映射。修复原因后调用 `/fs/rename/b2/resume`，任务从 D1 中的 cursor、待处理对象、目标 fileId 和大文件 part SHA1 继续。D1 的 lease 防止浏览器和定时任务同时处理同一任务。每个存储同一时间只允许一个 B2 重命名任务。

每次 `b2_list_file_names` 最多读取 500 个名称，记录 `nextFileName`，每个 Worker 步骤最多并行处理 4 个对象。任务逐个用源 `fileId` 调用 `b2_copy_file`；超过 5 GB 的对象使用 `b2_start_large_file`、`b2_copy_part`、`b2_finish_large_file`。在删除源版本前，必须验证目标版本的名称、长度、可用的 SHA1，以及它仍是目标 key 的当前版本。源 key 若被外部客户端替换，任务暂停。

## B2 版本历史与边界

复制完成后先为旧 key 建立 hide marker，再用源 `fileId` 删除已迁移版本，防止旧的历史版本重新成为当前可见版本。**历史版本和 hide marker 仍可能保留在 B2 版本历史中**，受 bucket 生命周期和 Object Lock 设置约束；本方案对齐的是当前可见的 key prefix，不会自动清除历史版本。SSE-C 对象缺少客户密钥时会暂停。OpenList 能冻结自身写入，不能阻止 B2 控制台或其他客户端同时写相同 key；这些冲突会在校验中暂停任务，管理员需要处理后再恢复。

重命名期间必须保留 D1 数据库。若直接删除 D1 任务表，临时映射和恢复游标都会丢失。
