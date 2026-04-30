# Tapnow Studio — 腾讯云 VOD AIGC 配置指南

## 一、概述

Tapnow Studio 内置了腾讯云 VOD AIGC 的生图（`vod-aigc-image`）和生视频（`vod-aigc-video`）能力。  
使用前需要在 **Provider 级别** 配置腾讯云 AK/SK 凭据，模型会自动继承 Provider 的 Key，无需在每个模型上单独填写。

---

## 二、获取腾讯云凭据

你需要准备以下四个值：

| 字段 | 说明 | 获取方式 |
|------|------|----------|
| `SecretId` | 腾讯云 API 密钥 ID | [API 密钥管理](https://console.cloud.tencent.com/cam/capi) |
| `SecretKey` | 腾讯云 API 密钥 Key | 同上 |
| `SubAppId` | 云点播子应用 ID | [云点播控制台 → 应用管理](https://console.cloud.tencent.com/vod) |
| `Region` | 地域 | 如 `ap-guangzhou`、`ap-beijing`、`ap-shanghai` |

---

## 三、配置步骤

### 步骤 1：打开设置面板

启动 Tapnow Studio（`npm run dev`，默认 http://localhost:5173/），点击界面上的 **设置** 按钮。

### 步骤 2：找到 `tencent-vod` Provider

在设置面板的 **Provider 列表** 中，找到 **`tencent-vod`**，点击展开。

### 步骤 3：填写 API Key

在展开后的 **API Key** 输入框中，按以下格式填入（四段用 `|` 分隔）：

```
SecretId|SecretKey|SubAppId|Region
```

**示例：**

```
AKIDxxxxxxxxxx|SKxxxxxxxxxx|251007502|ap-guangzhou
```

### 步骤 4：确认 Provider 设置

展开后还有以下选项，一般保持默认即可：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 接口类型 | `tencent-vod` | 不要修改 |
| 本地代理 | ✅ 开启 | 通过 `http://127.0.0.1:9527/proxy` 转发请求 |
| 异步模式 | ✅ 开启 | VOD AIGC 任务为异步，必须开启 |

### 步骤 5：使用模型

- **生图**：在画布中添加 `gen-image` 节点 → 模型选择 `vod-aigc-image` → 填写 Prompt → 生成
- **生视频**：在画布中添加 `gen-video` 节点 → 模型选择 `vod-aigc-video` → 填写 Prompt → 生成

模型会自动使用 `tencent-vod` Provider 中配置的凭据，无需在模型层面单独填写 Key。

---

## 四、配置结构说明

```
设置面板
 └─ Provider 列表
     └─ tencent-vod              ← 在这里配置 AK/SK
         ├─ 接口类型: tencent-vod
         ├─ 本地代理: ✅
         ├─ 异步模式: ✅
         └─ API Key: SecretId|SecretKey|SubAppId|Region
             │
             ├─ vod-aigc-image   ← 自动继承 Provider 的 Key
             └─ vod-aigc-video   ← 自动继承 Provider 的 Key
```

---

## 五、存储位置

所有配置保存在 **浏览器 localStorage** 中（域名+端口绑定）：

| 数据 | localStorage Key |
|------|------------------|
| Provider 凭据（含 AK/SK） | `tapnow_providers` |
| 模型配置列表 | `tapnow_api_configs` |
| 模型库 | `tapnow_model_library` |

> ⚠️ **注意**：
> - 清除浏览器缓存或更换浏览器/端口会丢失配置
> - SecretKey 以明文存储在 localStorage，请勿在共享设备上配置生产密钥
> - 建议配置完成后使用设置面板的「导出 API Keys」功能备份

---

## 六、本地代理服务

VOD/COS 请求默认通过本地代理 `http://127.0.0.1:9527/proxy?url=...` 转发（解决浏览器 CORS 限制）。

### 启动代理

项目自带 `proxy-server.mjs`，启动方式：

```bash
# 前台运行（可看日志）
node proxy-server.mjs

# 或后台运行
nohup node proxy-server.mjs > /tmp/vodstudio-proxy.log 2>&1 &
```

启动成功后会输出：
```
[proxy-server] 本地代理服务已启动: http://127.0.0.1:9527
[proxy-server] 支持路由: /ping, /proxy?url=<target>
```

### 验证

```bash
curl http://127.0.0.1:9527/ping
# 应返回 {"status":"ok","time":"..."}
```

### 停止代理

```bash
pkill -f "node proxy-server.mjs"
```

如需修改代理地址/端口，在设置面板的「本地服务器」选项中调整。

---

## 七、常见问题

| 问题 | 解决方案 |
|------|----------|
| 报错「未配置腾讯云 VOD 凭据」 | 检查 `tencent-vod` Provider 的 API Key 是否已填写 |
| 报错「凭据格式错误」 | 确认格式为 `SecretId\|SecretKey\|SubAppId\|Region`，四段用 `\|` 分隔 |
| 请求失败 / 网络错误 | 确认本地代理服务 (`127.0.0.1:9527`) 正在运行 |
| 换浏览器后配置丢失 | 配置存在 localStorage，需重新填写或从备份导入 |

AKIDxxxxxxxxxx|SKxxxxxxxxxx|251007502|ap-guangzhou