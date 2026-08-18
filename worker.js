/**
 * Anthropic Messages API to OpenAI Chat Completions proxy.
 *
 * Cloudflare Worker variables:
 *   TARGET_API_BASE_URL: https://api.openai.com/v1
 *   TARGET_API_KEY:      optional fixed upstream API key (store as a secret)
 *
 * If TARGET_API_KEY is absent, the incoming x-api-key is forwarded upstream.
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    if (url.pathname !== "/v1/messages") return response("Not Found", 404);
    if (request.method !== "POST") return response("Method Not Allowed", 405);

    let claudeRequest;
    try {
      claudeRequest = await request.json();
    } catch {
      return json({ error: { type: "invalid_request_error", message: "Request body must be valid JSON." } }, 400);
    }

    if (!claudeRequest || typeof claudeRequest.model !== "string" || !Array.isArray(claudeRequest.messages)) {
      return json({ error: { type: "invalid_request_error", message: "model and messages are required." } }, 400);
    }

    let targetUrl;
    try {
      targetUrl = targetChatCompletionsUrl(env);
    } catch (error) {
      return json({ error: { type: "configuration_error", message: error.message } }, 500);
    }

    const apiKey = env.TARGET_API_KEY || request.headers.get("x-api-key");
    if (!apiKey) {
      return json({ error: { type: "authentication_error", message: "Configure TARGET_API_KEY or send x-api-key." } }, 401);
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(convertClaudeToOpenAIRequest(claudeRequest)),
      });
    } catch (error) {
      return json({ error: { type: "api_error", message: `Unable to reach upstream API: ${error.message}` } }, 502);
    }

    if (!upstream.ok) {
      return new Response(await upstream.text(), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: { "Content-Type": upstream.headers.get("content-type") || "application/json", ...corsHeaders() },
      });
    }

    if (claudeRequest.stream) {
      if (!upstream.body) return json({ error: { type: "api_error", message: "Upstream returned an empty streaming response." } }, 502);
      return new Response(upstream.body.pipeThrough(new TransformStream(openAIStreamToAnthropic(claudeRequest.model))), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
      });
    }

    try {
      return json(convertOpenAIToClaudeResponse(await upstream.json(), claudeRequest.model));
    } catch (error) {
      return json({ error: { type: "api_error", message: `Invalid upstream response: ${error.message}` } }, 502);
    }
  },
};

function targetChatCompletionsUrl(env) {
  const baseUrl = String(env.TARGET_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl || !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(baseUrl)) {
    throw new Error("TARGET_API_BASE_URL must be configured as an http(s) URL.");
  }
  return `${baseUrl}/chat/completions`;
}

function convertClaudeToOpenAIRequest(claude) {
  const messages = [];
  if (claude.system) messages.push({ role: "system", content: claude.system });

  for (const message of claude.messages) {
    if (message.role === "user") {
      if (!Array.isArray(message.content)) {
        messages.push({ role: "user", content: message.content });
        continue;
      }
      const toolResults = message.content.filter((block) => block.type === "tool_result");
      const otherBlocks = message.content.filter((block) => block.type !== "tool_result");
      for (const block of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
      if (otherBlocks.length) messages.push({ role: "user", content: toOpenAIContent(otherBlocks) });
    } else if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      const text = [];
      const toolCalls = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text || "");
        if (block.type === "tool_use") toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
      messages.push({ role: "assistant", content: text.join("\n") || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
  }

  const result = {
    model: claude.model,
    messages,
    max_tokens: claude.max_tokens,
    temperature: claude.temperature,
    top_p: claude.top_p,
    stop: claude.stop_sequences,
    stream: Boolean(claude.stream),
  };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];

  if (Array.isArray(claude.tools)) {
    result.tools = claude.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: cleanSchema(tool.input_schema) },
    }));
  }
  if (claude.tool_choice) {
    result.tool_choice = claude.tool_choice.type === "tool"
      ? { type: "function", function: { name: claude.tool_choice.name } }
      : "auto";
  }
  return result;
}

function toOpenAIContent(blocks) {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text || "" };
    if (block.type === "image" && block.source?.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
    return { type: "text", text: block.text || "" };
  });
}

function cleanSchema(value) {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$schema" && key !== "additionalProperties") result[key] = cleanSchema(child);
  }
  if (result.type === "string" && result.format && !["date-time", "enum"].includes(result.format)) delete result.format;
  return result;
}

function convertOpenAIToClaudeResponse(openai, model) {
  const choice = openai.choices?.[0];
  if (!choice) throw new Error("Upstream response has no choices.");
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = {}; }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  const reasons = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  return {
    id: openai.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reasons[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: { input_tokens: openai.usage?.prompt_tokens || 0, output_tokens: openai.usage?.completion_tokens || 0 },
  };
}

function openAIStreamToAnthropic(model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let started = false;
  let done = false;
  let finishReason = "stop";
  const tools = new Map();
  const send = (controller, event, data) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const start = (controller) => {
    if (started) return;
    started = true;
    send(controller, "message_start", { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    send(controller, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  };
  const finish = (controller) => {
    if (done) return;
    start(controller);
    done = true;
    send(controller, "content_block_stop", { type: "content_block_stop", index: 0 });
    for (const tool of tools.values()) if (tool.started) send(controller, "content_block_stop", { type: "content_block_stop", index: tool.anthropicIndex });
    const reason = finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";
    send(controller, "message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 0 } });
    send(controller, "message_stop", { type: "message_stop" });
  };
  const processEvent = (event, controller) => {
    const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") return finish(controller);
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      start(controller);
      send(controller, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } });
    }
    for (const change of delta.tool_calls || []) {
      let tool = tools.get(change.index);
      if (!tool) { tool = { id: "", name: "", anthropicIndex: tools.size + 1, started: false }; tools.set(change.index, tool); }
      if (change.id) tool.id = change.id;
      if (change.function?.name) tool.name = change.function.name;
      start(controller);
      if (!tool.started && tool.id && tool.name) {
        tool.started = true;
        send(controller, "content_block_start", { type: "content_block_start", index: tool.anthropicIndex, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
      }
      if (tool.started && change.function?.arguments) send(controller, "content_block_delta", { type: "content_block_delta", index: tool.anthropicIndex, delta: { type: "input_json_delta", partial_json: change.function.arguments } });
    }
  };
  return {
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const event of events) processEvent(event, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer, controller);
      finish(controller);
    },
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version",
  };
}

function response(body, status) {
  return new Response(body, { status, headers: corsHeaders() });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
