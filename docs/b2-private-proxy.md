# B2 私有下载代理

浏览器 → OpenList Worker → B2 私有桶 → OpenList Worker → 浏览器。
S3 驱动生成签名地址，原生下载代理获取并转发文件，无需额外部署签名 Worker。

## 存储配置

| 项目 | 配置 |
| --- | --- |
| Endpoint、Region、Bucket | 实际 B2 S3 端点、区域及桶名 |
| Access Key、Secret Key | 有相应桶读取权限的 B2 凭据 |
| Custom Host | 留空 |
| Web Proxy | 开启 |
| Proxy Range | 开启；未配置时默认开启，显式关闭仍有效 |
| Down Proxy URL | 留空，使用当前 Worker 原生代理 |

如使用 WebDAV，需要代理读取时选择 `native_proxy`。下载访问控制继续由
OpenList 的签名设置决定；B2 私有桶本身不代表 OpenList 下载入口自动要求登录。

## 保留的增强

- 签名 HEAD 请求绕过缓存，保留签名所使用的 HTTP 方法。
- 带 Range 的 B2 视频请求绕过回源缓存，并保留分段响应。
- [分片上传与进度恢复](b2-multipart-upload.md)。
- [B2 目录后台重命名](b2-directory-rename.md)。
- [Worker 目录元数据缓存](worker-directory-cache.md)，独立于文件内容缓存。

原单文件内容缓存试验已移除；曾启用的部署请按
[试验退出说明](b2-range-cache-pilot.md) 清理控制台配置。

## 验证

在开启下载签名的存储上确认无效签名被拒绝；合法视频 Range 请求返回 206、
正确的 Content-Range 和对应字节。实际下载链路应通过当前 Worker，
而非向浏览器 302 到 B2。代码更新不自动修改既有存储配置。
