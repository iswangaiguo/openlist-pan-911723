# B2 Range 缓存试验已移除

单文件固定 ETag 的缓存试验已移除。私有 B2 下载继续使用上游 S3 签名与
OpenList 原生代理，配置见 [B2 私有下载代理](b2-private-proxy.md)。

升级前，若曾启用试验，请停用当时为单个 B2 对象创建的 Cloudflare Cache Rule，
并清除该对象的试验缓存；不要修改其他缓存规则。删除 Worker 环境变量
`B2_RANGE_CACHE_PILOT`。新代码即使遇到遗留变量也会忽略它。

代码更新不会自动修改 Cloudflare 控制台配置。升级后不再返回
`X-OpenList-Range-Cache` 或 `X-OpenList-Origin-Ms` 试验诊断头。
带 Range 的 B2 视频回源和签名 HEAD 元数据请求继续使用 `no-store`。
