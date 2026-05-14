# VodStudio — 腾讯云 VOD AIGC 配置指南

## 一、概述

VodStudio 内置腾讯云 VOD AIGC 生图（`vod-aigc-image`）和生视频（`vod-aigc-video`）能力。  
使用前只需要在 **Provider 级别** 配置腾讯云凭据，两个 VOD 模型会自动继承 `tencent-vod` Provider 的 Key。

当前版本按腾讯云官方文档配置：

- 生图接口：`CreateAigcImageTask`
- 生视频接口：`CreateAigcVideoTask`
- Base URL：`https://vod.tencentcloudapi.com`
- CORS 转发：默认启用 `http://127.0.0.1:9527/proxy`
- 调用方式：浏览器侧生成腾讯云 API 3.0 TC3-HMAC-SHA256 签名，请求经本地 CORS 转发通道发送到 VOD 官方域名

---

## 二、获取腾讯云凭据

你需要准备以下四个值：

| 字段 | 说明 | 获取方式 |
|------|------|----------|
| `SecretId` | 腾讯云 API 密钥 ID | [API 密钥管理](https://console.cloud.tencent.com/cam/capi) |
| `SecretKey` | 腾讯云 API 密钥 Key | 同上 |
| `SubAppId` | 云点播应用 ID | [云点播控制台 → 应用管理](https://console.cloud.tencent.com/vod) |
| `Region` | 地域 | 如 `ap-guangzhou`、`ap-beijing`、`ap-shanghai` |

配置格式为：

```text
SecretId|SecretKey|SubAppId|Region
```

示例：

```text
AKIDxxxxxxxxxx|SKxxxxxxxxxx|251007502|ap-guangzhou
```

> 不要把真实 `SecretKey` 写入公开文档、截图、日志或仓库。

---

## 三、配置步骤

### 步骤 1：打开设置面板

启动 VodStudio：

```bash
npm run dev
```

默认地址：

```text
http://localhost:5173/
```

点击界面上的 **设置** / **API 设置** 按钮。

### 步骤 2：找到 `tencent-vod` Provider

在 **Provider 列表** 中找到 `tencent-vod` 并展开。

### 步骤 3：确认 Provider 设置

`tencent-vod` 固定使用以下配置：

| 设置项 | 值 | 说明 |
|--------|----|------|
| 接口类型 | `tencent-vod` | 固定为腾讯云 VOD 调用通路 |
| Base URL | `https://vod.tencentcloudapi.com` | 腾讯云 VOD 官方接口域名 |
| CORS 转发 | 开启 | 浏览器无法直接跨域调用服务端 API，需经 `127.0.0.1:9527/proxy` 转发 |
| 异步模式 | 开启 | VOD AIGC 返回异步任务 ID，必须轮询结果 |
| API Key | `SecretId|SecretKey|SubAppId|Region` | 四段式腾讯云凭据 |

### 步骤 4：启动 CORS 转发服务

腾讯云 VOD API 属于服务端 API，浏览器直接请求 `https://vod.tencentcloudapi.com` 会被 CORS 策略拦截。打开单文件 `index.html` 使用 VOD 生图/生视频前，请在项目目录启动内置转发服务：

```bash
node proxy-server.mjs
```

验证：

```bash
curl http://127.0.0.1:9527/ping
```

正常返回 `{"status":"ok"}` 后，再回到页面执行生图或生视频。

如果页面是通过 HTTPS 或浏览器安全上下文打开，浏览器可能会启用 Private Network Access 检查。请使用最新的 `proxy-server.mjs`，其中已包含 `Access-Control-Allow-Private-Network: true` 响应头。

### 步骤 5：选择 VOD 生图 / 生视频模型

在 `tencent-vod` Provider 展开区，可以分别配置：

- `VOD 生图模型`：对应 `CreateAigcImageTask`
- `VOD 生视频模型`：对应 `CreateAigcVideoTask`

每个模型都可选择：

- `ModelName`
- `ModelVersion`

选择 `ModelName` 后，`ModelVersion` 会自动切换为该模型支持的版本。

### 步骤 6：在画布中使用

- **生图**：添加 `gen-image` 节点 → 模型选择 `vod-aigc-image` → 填写 Prompt → 生成
- **生视频**：添加 `gen-video` 节点 → 模型选择 `vod-aigc-video` → 填写 Prompt → 生成

---

## 四、官方模型选项

### 4.1 VOD 生图模型

| ModelName | ModelVersion |
|-----------|--------------|
| `OG` | `image2_low`、`image2_medium`、`image2_high` |
| `GG` | `2.5`、`3.0`、`3.1` |
| `SI` | `4.0`、`4.5`、`5.0-lite` |
| `Qwen` | `0925` |
| `Hunyuan` | `3.0` |
| `Vidu` | `q2` |
| `Kling` | `2.1`、`3.0`、`3.0-Omni`、`O1` |

默认值：

```text
ModelName = GG
ModelVersion = 2.5
```

### 4.2 VOD 生视频模型

| ModelName | ModelVersion |
|-----------|--------------|
| `Hailuo` | `02`、`2.3`、`2.3-fast` |
| `Kling` | `1.6`、`2.0`、`2.1`、`2.5`、`2.6`、`O1`、`3.0`、`3.0-Omni` |
| `Vidu` | `q2`、`q2-pro`、`q2-turbo`、`q3`、`q3-pro`、`q3-turbo` |
| `GV` | `3.1`、`3.1-fast` |
| `OS` | `2.0` |
| `Hunyuan` | `1.5` |
| `Mingmou` | `1.0` |
| `PixVerse` | `v5.6`、`v6`、`c1` |

默认值：

```text
ModelName = GV
ModelVersion = 3.1-fast
```

---

## 五、配置结构说明

```text
设置面板
 └─ Provider 列表
     └─ tencent-vod
         ├─ 接口类型: tencent-vod
         ├─ Base URL: https://vod.tencentcloudapi.com
         ├─ CORS 转发: 开启（127.0.0.1:9527/proxy）
         ├─ 异步模式: 开启
         ├─ API Key: SecretId|SecretKey|SubAppId|Region
         ├─ VOD 生图模型: ModelName / ModelVersion
         └─ VOD 生视频模型: ModelName / ModelVersion
             │
             ├─ vod-aigc-image   ← 自动继承 Provider 凭据和生图模型默认值
             └─ vod-aigc-video   ← 自动继承 Provider 凭据和生视频模型默认值
```

---

## 六、存储位置

所有配置保存在浏览器 `localStorage` 中（域名 + 端口绑定）：

| 数据 | localStorage Key |
|------|------------------|
| Provider 凭据（含 AK/SK） | `tapnow_providers` |
| 模型配置列表 | `tapnow_api_configs` |
| 模型库 | `tapnow_model_library` |

注意：

- 清除浏览器缓存或更换浏览器/端口会丢失配置。
- `SecretKey` 以明文存储在本地浏览器中，请勿在共享设备上配置生产密钥。
- 建议配置完成后使用设置面板的「导出 API Keys」功能备份。

---

## 七、常见问题

| 问题 | 解决方案 |
|------|----------|
| 报错「未配置腾讯云 VOD 凭据」 | 检查 `tencent-vod` Provider 的 API Key 是否已填写 |
| 报错「凭据格式错误」 | 确认格式为 `SecretId\|SecretKey\|SubAppId\|Region`，四段用 `\|` 分隔 |
| 报错「SubAppId 必须是正整数」 | 到 VOD 控制台复制正确的云点播应用 ID |
| 模型版本不可选 | 先选择对应 `ModelName`，`ModelVersion` 会按官方矩阵联动 |
| 任务长时间未完成 | VOD AIGC 是异步任务，需等待轮询结果或到控制台排查 |
| 请求失败 / 网络错误 | 确认已启动 `node proxy-server.mjs`，且网络可以访问 `https://vod.tencentcloudapi.com` |
| 浏览器 CORS error | 腾讯云 VOD 是服务端 API，浏览器不能直接跨域调用；请保持 CORS 转发开启并启动 `127.0.0.1:9527` |
| 换浏览器后配置丢失 | 配置存在 localStorage，需重新填写或从备份导入 |

---

## 八、参考文档

- VOD 生图接口 `CreateAigcImageTask`：<https://cloud.tencent.com/document/product/266/126240>
- VOD 生视频接口 `CreateAigcVideoTask`：<https://cloud.tencent.com/document/product/266/126239>
- 腾讯云 API 密钥管理：<https://cloud.tencent.com/document/product/598/40488>
