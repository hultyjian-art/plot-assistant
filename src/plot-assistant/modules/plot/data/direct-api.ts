/**
 * 剧情推进 — 直连 API 通道（移植自 ACU 1.3.6）
 *
 * 只在「通过酒馆渠道发送」关掉时启用：自己拼请求、自己发、自己归一返回，
 * 不经过酒馆助手 generateRaw。协议转换逐条照搬 ACU 的 custom-api-protocol.ts
 * 与 custom-api-transport.ts，四个接口协议（custom_api_format 四值）行为一致：
 *   - openai_compat      → POST {url}/chat/completions
 *   - openai_responses   → POST {url}/responses
 *   - claude_messages    → POST {url}/messages
 *   - gemini_interactions→ POST {url}/interactions
 *
 * 与 ACU 的差异只有两处，都是环境差异、不是功能差异：
 *   1. 发送函数用 globalThis.fetch（本项目是酒馆助手 iframe，没有 ACU 那套
 *      生成请求拦截器，不需要 pristineFetch 剥离包装）；
 *   2. 不实现 sendViaTavern=true 那条分支 —— 那条在本项目里就是现有的
 *      generateRaw 路径，由 ai-call.ts 保留。
 *
 * 不做隐式回退：关了酒馆渠道、地址又填错，就明确报错，不悄悄改走酒馆。
 */

/** 四协议取值，唯一白名单来源（对齐 ACU CUSTOM_API_FORMAT_VALUES_ACU）。 */
export const DIRECT_API_FORMATS = [
  'openai_compat',
  'openai_responses',
  'claude_messages',
  'gemini_interactions',
] as const;

export type DirectApiFormat = (typeof DIRECT_API_FORMATS)[number];

export const DIRECT_API_FORMAT_DEFAULT: DirectApiFormat = 'openai_compat';

/** 非法 / 缺失值归一为 openai_compat（ACU 的历史行为）。 */
export function normalizeDirectApiFormat(value: unknown): DirectApiFormat {
  const raw = String(value ?? '').trim();
  return (DIRECT_API_FORMATS as readonly string[]).includes(raw) ? (raw as DirectApiFormat) : DIRECT_API_FORMAT_DEFAULT;
}

const text = (value: any): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(part => typeof part === 'string' ? part : part?.text ?? '').join('') : '';
const args = (value: any): any => typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {};

/** 直连保留消息顺序与身份，不读预设后处理、不生成伪对话。 */
export function processDirectMessages(input: any[]): any[] {
  return input.map(message => ({ ...message }));
}

/** 按协议把用户填的基地址补成真正的请求端点。 */
export function providerEndpoint(raw: string, format: DirectApiFormat): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 端点必须是 HTTP 或 HTTPS 地址。');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages|interactions)$/, '');
  if (!path && format !== 'openai_compat' && format !== 'openai_responses') {
    path = format === 'claude_messages' ? '/v1' : '/v1beta';
  }
  const endpoint: Record<DirectApiFormat, string> = {
    openai_compat: '/chat/completions',
    openai_responses: '/responses',
    claude_messages: '/messages',
    gemini_interactions: '/interactions',
  };
  url.pathname = path + endpoint[format];
  return url.toString();
}

/** 把通用请求体转成所选协议的网络请求体。 */
export function buildProviderRequest(body: Record<string, any>, format: DirectApiFormat): Record<string, any> {
  if (format === 'openai_compat') return { ...body };
  const { messages, max_tokens, tools, tool_choice, response_format, ...rest } = body;
  if (format === 'openai_responses') {
    const input = messages.flatMap((m: any) => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: text(m.content) }];
      const items: any[] = m.content ? [{ role: m.role, content: m.content }] : [];
      for (const call of m.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id, ...call.function });
      return items;
    });
    return {
      ...rest, input, max_output_tokens: max_tokens,
      ...(tools?.length ? { tools: tools.map((t: any) => ({ type: 'function', ...t.function })), tool_choice } : {}),
      ...(response_format ? { text: { format: response_format.type === 'json_schema' ? { type: 'json_schema', ...response_format.json_schema } : response_format } } : {}),
    };
  }
  if (format === 'claude_messages') {
    const system = messages.filter((m: any) => m.role === 'system').map((m: any) => ({ type: 'text', text: text(m.content) }));
    const converted = messages.filter((m: any) => m.role !== 'system').map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) }]
        : [
            ...(m.content ? [{ type: 'text', text: text(m.content) }] : []),
            ...(m.tool_calls ?? []).map((c: any) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: args(c.function.arguments) })),
          ],
    }));
    const { top_p, temperature, model, stream } = rest;
    return {
      model, stream, temperature, top_p, max_tokens, messages: converted,
      ...(system.length ? { system } : {}),
      ...(tools?.length ? {
        tools: tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
        tool_choice: { type: 'auto' },
      } : {}),
      ...(response_format ? { output_config: { format: { type: 'json_schema', schema: response_format.json_schema?.schema ?? { type: 'object' } } } } : {}),
    };
  }
  const input = messages.filter((m: any) => m.role !== 'system').flatMap((m: any) => {
    if (m.role === 'tool') return [{ type: 'function_result', call_id: m.tool_call_id, result: text(m.content) }];
    return [
      ...(m.content ? [{ type: m.role === 'assistant' ? 'model_output' : 'user_input', content: [{ type: 'text', text: text(m.content) }] }] : []),
      ...(m.tool_calls ?? []).map((c: any) => ({ type: 'function_call', id: c.id, name: c.function.name, arguments: args(c.function.arguments) })),
    ];
  });
  return {
    model: rest.model, stream: rest.stream, store: false, input,
    system_instruction: messages.filter((m: any) => m.role === 'system').map((m: any) => text(m.content)).join('\n\n'),
    generation_config: { max_output_tokens: max_tokens, ...(tools?.length ? { tool_choice: 'auto' } : {}) },
    ...(tools?.length ? { tools: tools.map((t: any) => ({ type: 'function', ...t.function })) } : {}),
    ...(response_format ? { response_format: { type: 'json', schema: response_format.json_schema?.schema ?? { type: 'object' } } } : {}),
  };
}

const UPSTREAM_ERROR_MESSAGE_LIMIT = 300;

/** 只取上游错误的 type / code / message，message 截 300 字。 */
export function describeProviderUpstreamError(data: any): string {
  const raw = data?.error ?? (Array.isArray(data?.errors) ? data.errors[0] : undefined);
  const fields: string[] = [];
  let message = '';
  if (raw && typeof raw === 'object') {
    const type = raw.type ?? raw.status;
    if (typeof type === 'string' || typeof type === 'number') fields.push(`type=${type}`);
    if (typeof raw.code === 'string' || typeof raw.code === 'number') fields.push(`code=${raw.code}`);
    if (typeof raw.message === 'string') message = raw.message;
  } else if (typeof raw === 'string') {
    message = raw;
  }
  if (!raw && typeof data?.status === 'string') fields.push(`status=${data.status}`);
  const trimmed = message.trim();
  const shown = trimmed.length > UPSTREAM_ERROR_MESSAGE_LIMIT ? `${trimmed.slice(0, UPSTREAM_ERROR_MESSAGE_LIMIT)}…` : trimmed;
  return `直连 API 返回上游错误${fields.length ? `（${fields.join(', ')}）` : ''}${shown ? `：${shown}` : '。'}`;
}

/** 非流式回复归一到 OpenAI 回复契约（ACU normalizeProviderReply_ACU）。 */
export function normalizeProviderReply(data: any, format: DirectApiFormat): any {
  if (format === 'openai_compat' || data?.choices) return data;
  if (data?.error || data?.errors?.length || ['failed', 'cancelled'].includes(data?.status)) throw new Error(describeProviderUpstreamError(data));
  const blocks = format === 'claude_messages' ? data.content ?? []
    : format === 'openai_responses' ? data.output ?? [] : data.steps ?? data.outputs ?? [];
  const content = blocks.map((b: any) => b.type === 'text' ? b.text : text(b.content)).join('');
  const calls = blocks.filter((b: any) => ['function_call', 'tool_use'].includes(b.type)).map((b: any) => ({
    id: b.call_id ?? b.id, type: 'function', function: { name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? b.input ?? {}) },
  }));
  const usage = data.usage;
  return {
    choices: [{
      message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: calls.length ? 'tool_calls' : (data.stop_reason === 'max_tokens' || data.status === 'incomplete' ? 'length'
        : format === 'claude_messages' ? (['end_turn', 'stop_sequence'].includes(data.stop_reason) ? 'stop' : null)
        : data.status === 'completed' ? 'stop' : null),
    }],
    usage: usage ? { ...usage, prompt_tokens: usage.input_tokens ?? usage.total_input_tokens, completion_tokens: usage.output_tokens ?? usage.total_output_tokens } : undefined,
  };
}

/** Responses / Interactions SSE 转成 Chat Completion SSE（ACU normalizeProviderStream_ACU）。 */
export function normalizeProviderStream(raw: string, format: DirectApiFormat): string {
  if (format === 'openai_compat' || format === 'claude_messages') return raw;
  const packets: string[] = [];
  const emit = (delta: any, finish_reason: string | null = null, usage?: any) => packets.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  let completed = false;
  for (const event of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { completed = true; continue; }
    const json = JSON.parse(data);
    if (json.error || json.type === 'error' || json.type === 'response.failed' || json.event_type === 'error') throw new Error('直连 API 流返回上游错误。');
    if (format === 'openai_responses') {
      if (json.type === 'response.output_text.delta') emit({ content: json.delta });
      if (json.type === 'response.output_item.added' && json.item?.type === 'function_call') emit({ tool_calls: [{ index: json.output_index ?? 0, id: json.item.call_id ?? json.item.id, type: 'function', function: { name: json.item.name, arguments: '' } }] });
      if (json.type === 'response.function_call_arguments.delta') emit({ tool_calls: [{ index: json.output_index ?? 0, function: { arguments: json.delta } }] });
      if (json.type === 'response.completed' || json.type === 'response.incomplete') {
        const reply = normalizeProviderReply(json.response, format);
        emit({}, reply.choices[0].finish_reason, reply.usage); completed = true;
      }
    } else {
      const type = json.event_type ?? json.type;
      if (type === 'content.delta' && json.delta?.type === 'text') emit({ content: json.delta.text ?? '' });
      if (type === 'step.delta' && json.delta?.type === 'text') emit({ content: json.delta.text ?? '' });
      if (type === 'content.start' && json.content?.type === 'function_call') emit({ tool_calls: [{ index: json.index ?? 0, id: json.content.id, type: 'function', function: { name: json.content.name, arguments: JSON.stringify(json.content.arguments ?? {}) } }] });
      if (type === 'interaction.complete' || type === 'interaction.completed') {
        const reply = normalizeProviderReply(json.interaction ?? json, format);
        emit({}, reply.choices[0].finish_reason, reply.usage); completed = true;
      }
    }
  }
  if (completed) packets.push('data: [DONE]\n\n');
  return packets.join('');
}

/** 从 Chat Completion SSE 里累积出一条最终消息（本项目不做流式展示，只取终值）。 */
function collectSseMessage(sse: string): any {
  let content = '';
  const toolCalls: any[] = [];
  let finishReason: string | null = null;
  for (const block of sse.replace(/\r\n/g, '\n').split('\n\n')) {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') content += delta.content;
      if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls);
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
    } catch {
      // 单个坏包不该毁掉整段：正文可能就在别的包里
    }
  }
  return { choices: [{ message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }] };
}

/** 一次直连调用所需的全部配置（已由上层把面板原文解析成对象 / 数组）。 */
export interface DirectApiConfig {
  url: string;
  apiKey: string;
  model: string;
  format: DirectApiFormat;
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  maxTokens: number | 'same_as_preset' | 'unset';
  temperature: number | 'same_as_preset' | 'unset';
  /** 附加请求体参数（parseBodyParams 已解析）。 */
  includeBody: Record<string, unknown> | null;
  /** 要剔除的请求体键名（parseExcludeParams 已解析）。 */
  excludeBody: string[];
  /** 附加请求头（parseHeaderLines 已解析）。 */
  headers: Record<string, string> | null;
  /** 关闭工具调用：直连时根本不放 tools / tool_choice 进请求体。 */
  disableToolCalls: boolean;
}

/** 直连调用的结果，形状对齐 ai-call.ts 的 RawGenerateResult 消费者。 */
export interface DirectApiOutcome {
  content: string;
  reasoning: string;
  toolCalls?: unknown[];
}

/**
 * 发一次直连调用，拿回归一后的消息。
 *
 * 失败一律抛 Error（让重试层按接口失败处理）：地址不合法 / 上游非 2xx / 返回不是 JSON
 * 都带原文前 300 字，避免只报「请求失败」让人没法查。
 */
export async function sendDirectApi(config: DirectApiConfig, signal?: AbortSignal): Promise<DirectApiOutcome> {
  signal?.throwIfAborted();
  const format = normalizeDirectApiFormat(config.format);

  // 通用基础体：与 ACU 剔除 bridgeKeys 后的 bridgeBody 等价，这里直接按已知字段构造。
  const base: Record<string, any> = {
    model: config.model,
    messages: processDirectMessages(config.messages),
    stream: false,
  };
  if (typeof config.maxTokens === 'number') base.max_tokens = config.maxTokens;
  if (typeof config.temperature === 'number') base.temperature = config.temperature;

  const included = (config.includeBody ?? {}) as Record<string, any>;
  const body = buildProviderRequest(
    {
      ...base,
      ...included,
      messages: processDirectMessages((included.messages as any[]) ?? base.messages),
    },
    format,
  );
  // 协议原生字段由转换器写入，通用字段只补它没写的那些，不能覆盖成旧协议形状。
  const convertedKeys = new Set(['messages', 'max_tokens', 'tools', 'tool_choice', 'response_format']);
  for (const [key, value] of Object.entries(included)) {
    if (!convertedKeys.has(key) && value !== undefined) body[key] = value;
  }
  for (const key of config.excludeBody) delete body[key];
  if (config.disableToolCalls) {
    delete body.tools;
    delete body.tool_choice;
  }

  // 鉴权头：claude 用 x-api-key，gemini 用 x-goog-api-key，其余 Bearer。
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (config.apiKey) {
    if (format === 'claude_messages') headers.set('x-api-key', config.apiKey);
    else if (format === 'gemini_interactions') headers.set('x-goog-api-key', config.apiKey);
    else headers.set('Authorization', `Bearer ${config.apiKey}`);
  }
  if (format === 'claude_messages') {
    headers.set('anthropic-version', '2023-06-01');
    headers.set('anthropic-dangerous-direct-browser-access', 'true');
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    headers.set(name, value);
  }

  const url = providerEndpoint(config.url, format);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error(`剧情推进：直连 API 请求失败（${url}）：${error instanceof Error ? error.message : String(error)}`) as Error & { cause: unknown };
    wrapped.cause = error;
    throw wrapped;
  }
  const raw = await response.text();
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(`剧情推进：直连 API 返回 HTTP ${response.status}：${raw.slice(0, UPSTREAM_ERROR_MESSAGE_LIMIT)}`);
  }

  const isSse = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
  let normalized: any;
  try {
    normalized = isSse
      ? collectSseMessage(normalizeProviderStream(raw, format))
      : normalizeProviderReply(JSON.parse(raw), format);
  } catch (error) {
    const wrapped = new Error(`剧情推进：直连 API 返回无法解析：${error instanceof Error ? error.message : String(error)}；原文前 300 字：${raw.slice(0, UPSTREAM_ERROR_MESSAGE_LIMIT)}`) as Error & { cause: unknown };
    wrapped.cause = error;
    throw wrapped;
  }

  const message = normalized?.choices?.[0]?.message;
  if (!message) {
    throw new Error(`剧情推进：直连 API 返回里没有消息正文。原文前 300 字：${raw.slice(0, UPSTREAM_ERROR_MESSAGE_LIMIT)}`);
  }
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning
    : typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  return {
    content: text(message.content),
    reasoning,
    ...(Array.isArray(message.tool_calls) ? { toolCalls: message.tool_calls } : {}),
  };
}
