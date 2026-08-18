# Anthropic-to-OpenAI Cloudflare Worker

[中文](README.md) | [English](README.en.md)

单文件 Cloudflare Worker，将 Anthropic Messages API 转换为 OpenAI Chat Completions API。客户端只访问固定地址：

```text
https://<你的代理地址>/v1/messages
```

模型名称从 Anthropic 请求体的 `model` 字段直接传递给下游 OpenAI API。

## Cloudflare 变量

在 Worker 的 Settings > Variables and Secrets 中配置：

| 变量                    | 示例                          | 说明                    |
|-----------------------|-----------------------------|-----------------------|
| `TARGET_API_BASE_URL` | `https://api.openai.com/v1` | 下游 API 基础地址           |
| `TARGET_API_KEY`      | `sk-...`                    | 可选。设为 Secret 后固定使用该密钥 |

Worker 会在 `TARGET_API_BASE_URL` 后追加 `/chat/completions`。未配置 `TARGET_API_KEY` 时，Worker 会将请求的 `x-api-key` 转换为下游的 `Authorization: Bearer`。

将 `worker.js` 的内容直接粘贴到 Cloudflare Worker 编辑器即可。它支持普通响应、SSE 流式响应、文本、base64 图片和工具调用。

## 本地部署

```bash
npx wrangler deploy
```

生产密钥请使用 `npx wrangler secret put TARGET_API_KEY`，不要写入配置文件。
