# Anthropic-to-OpenAI Cloudflare Worker

[中文](README.md) | [English](README.en.md)

A single-file Cloudflare Worker that converts the Anthropic Messages API to the OpenAI Chat Completions API. Clients only need to access a fixed endpoint:

```text
https://<your-proxy-address>/v1/messages
```

The model name is passed directly to the downstream OpenAI API from the `model` field in the Anthropic request body.

## Cloudflare Variables

Configure the following variables in the Worker's Settings > Variables and Secrets:

| Variable | Example | Description |
|---|---|---|
| `TARGET_API_BASE_URL` | `https://api.openai.com/v1` | Base URL of the downstream API |
| `TARGET_API_KEY` | `sk-...` | Optional. Configure it as a Secret to always use this key |

The Worker appends `/chat/completions` to `TARGET_API_BASE_URL`. When `TARGET_API_KEY` is not configured, the Worker converts the request's `x-api-key` header to the downstream `Authorization: Bearer` header.

Paste the contents of `worker.js` directly into the Cloudflare Worker editor. It supports regular responses, SSE streaming responses, text, base64-encoded images, and tool calls.

## Local Deployment

```bash
npx wrangler deploy
```

Use `npx wrangler secret put TARGET_API_KEY` for production secrets instead of writing them to a configuration file.
