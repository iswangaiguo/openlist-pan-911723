# B2 大文件分片上传

B2/S3 的普通上传此前会回退到 `/api/fs/put`，默认只允许 25 MiB，并将整个文件读入内存。本修复将官方前端的 Multipart 协议接到 S3 CreateMultipartUpload / UploadPart / CompleteMultipartUpload / AbortMultipartUpload。

## 部署与使用

1. 部署包含此修复的 Worker。现有 `DB` D1 绑定无需更换；上传会话及分片表在首次分片请求时自动创建，不修改现有配置表。
2. 重新加载网页，上传方式选择 **Multipart**。`multipart_enabled` 缺省为 `true`，默认分片为 10 MiB；已有显式禁用设置会保留。不要为 2 GB 文件改用 Stream 或 Form。
3. 以同一用户、路径和文件重试未完成上传，前端会跳过已确认分片。完成记录保留，断线后查询状态或重复完成请求不会再发起合并。

每片上限取 `MAX_UPPART` 与 16 MiB 中较小者，S3 非末片至少 5 MiB，最多 10,000 片。前端建议值与后端协商结果可能不同。无需调大 `MAX_UPLOAD`。存储权限必须允许创建、上传、完成及取消 multipart upload。

## Cloudflare 免费套餐与 1102

免费 Worker 的每请求 CPU 限额为 10 ms。早期分片实现会在 Worker 中缓存每个 10 MiB 分片并计算整片 SHA-256，实际部署已出现 `Worker exceeded CPU time limit`。

HTTPS B2 endpoint（`*.backblazeb2.com`）在 Workers 中现在通过原生 `FixedLengthStream` 转发分片，使用短期预签名 UploadPart URL，只对小型签名请求计算 hash。长度由运行时校验，只有流完整转发并且 B2 返回 ETag 后才保存分片进度。浏览器仍通过同源 Worker 上传，无需修改桶 CORS，也不向浏览器暴露 B2 凭据或签名 URL。其他 provider、HTTP endpoint 和非 Worker 运行时保留原有上传方式。

前端识别 JSON 或 HTML 的 Cloudflare 1102 响应后停止所有分片请求、清零速度并显示错误；普通网络故障仍可重试。开启“尝试秒传”时浏览器仍先计算本地文件 hash，这与 Worker 的 CPU 超限不同。

修复移除了随分片大小增长的整片 hash 和缓冲开销，但免费套餐是否足够仍需在部署后实测。若还有 1102，检查单次调用的 CPU 时间及 `exceededCpu`，不要仅依赖汇总 CPU 指标。

## 会话及故障恢复

- D1 会话在多个 Worker 实例、冷启动和并发分片请求间共享。每片 ETag 独立保存，合并按分片编号排序；读取使用 primary session，避免读副本滞后。
- 会话绑定用户、实际目录和存储配置。更换用户或存储凭据后不会接续旧会话。
- 分片失败可重试，合并失败保留已确认分片；取消接口为 `POST /api/fs/multipart/abort`，请求带认证及 `X-Upload-Id`。
- 会话及完成记录七天过期；后续初始化会清理过期 D1 记录。配置 B2 桶生命周期，清理长期未完成的 provider uploads，防止遗留分片持续占用空间。
- 非 D1 部署保留原有内存会话行为，跨实例恢复需要 D1。

## 验证范围

测试覆盖真实 SQLite 执行的 D1 表和 SQL、跨绑定恢复、并发分片记录、乱序上传、短末片、缺片拒绝、失败合并重试、完成幂等、会话权限、取消、伪造驱动会话拒绝、缺少 ETag、HTTP 200 内嵌 S3 错误以及 2.5 GiB 文件的分片协商。

B2 请求使用模拟服务返回；尚未用生产 B2 凭据完成实际 2 GB 上传。原生 workerd 测试验证 10 MiB 转发、自动 Content-Length、短/长请求拒绝和 provider 失败取消；签名测试确认不再计算整片 hash。上线后用原先失败的文件验证，并检查 Worker 日志中的请求状态、CPU/内存限制和 B2 错误。
