
# PandoraToV1Api Cloudflare Workers 版本

## 项目概览

此项目为 [PandoraToV1Api](https://github.com/Ink-Osier/PandoraToV1Api) 的 Cloudflare Workers 版本，旨在利用 Cloudflare 的资源，提供便捷的部署方式和快速的响应速度。项目的核心目标是将 Pandora-Next proxy 模式下的 `backend-api` 转换为 `/v1/chat/completions` 接口，支持流式和非流式响应，从而方便支持原生 OpenAI `/v1/chat/completions` 接口的项目体验多模态的 GPT-4。

## 支持功能

- 支持 GPT-4, GPT-4-Mobile, GPT-3.5-Turbo 模型。
- 支持代码解释器、绘图、联网工具结果显示。
- 支持流式和非流式响应。
- 目前不支持上传文件和 GPTs。

## 部署方式

### Cloudflare Wrangler 部署

#### 官方教程

访问 [Cloudflare Workers 官方教程](https://developers.cloudflare.com/workers/get-started/guide/) 了解更多信息。

#### 步骤

1. **克隆项目**:
   ```bash
   git clone https://github.com/palafin02back/p2vapi_worker.git
   ```

2. **配置环境**:
   - 创建 R2: 访问 [Cloudflare R2 概览](https://dash.cloudflare.com/7c7d8f1ace797311e23742f30364704c/r2/overview)。
     ![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/ad1a649c-a9e2-490a-9f02-208273fbcacd)

   - 编辑 `wrangler.toml` 文件，配置如下变量：
     - `BASE_URL`: 部署的 Pandora 的域名地址。
     - `PROXY_API_PREFIX`: Pandora 的 proxy 模式前缀。
     - `R2_DOMAIN`: 绑定的 R2 桶域名地址。

   ```toml
   [vars]
   BASE_URL = "https://your-proxy-url.com"
   PROXY_API_PREFIX = "yourprefix"
   R2_DOMAIN ="https://your-r2-url.com"

   [[r2_buckets]]
   binding = 'R2buket'
   bucket_name = 'your_r2_name'
   preview_bucket_name = ""
   ```

3. **部署**:
   ```bash
   npm install
   npx wrangler dev # 本地测试
   npx wrangler deploy # 部署到 Cloudflare（需登录 Cloudflare 账户）
   ```

### Cloudflare Worker 部署

1. **创建 Worker**: 参照 Cloudflare Worker 控制台的指引创建新的 Worker。
![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/5a8f3159-2275-4a10-9abc-65e0162f72e9)

2. **设置环境变量**: 在 Worker 设置中配置好环境变量。
![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/82ac3a9b-4fd6-46f0-ba14-cad1f9943f36)


3. **部署脚本**: 复制 `worker.js` 的内容并替换 Worker 中的内容。

## 使用方式

以 [ChatNextWeb](https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web) 为例:

1. **填写自定义 URL**: 使用部署后的 Worker 地址。
2. **填写 Key**: 输入 Pandora Next 的 fk-key（每次消耗 Pandora 的额度 4+10，不消耗 OpenAI 账号的 API 额度）。
3. **选择模型**: 已映射了以下模型，如选择 `gpt-4-32k` 即使用 `gpt-4-mobile`。
   ```json
   {
       "gpt-4": "gpt-4",
       "gpt-4-32k": "gpt-4-mobile",
       "gpt-3.5-turbo": "text-davinci-002-render-sha"
   }
   ```
![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/ea837647-c27d-4b4a-9a01-5bd07ab8cd0a)
![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/6bd7c68f-38c0-44b0-951f-0e1867612eed)
![image](https://github.com/palafin02back/p2vapi_worker/assets/155502697/d6814a42-9c1c-4c9d-b5c0-ee57bbc106e4)





