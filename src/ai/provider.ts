import Anthropic from '@anthropic-ai/sdk'
import { VERSION } from '@anthropic-ai/sdk/version'
import type {
  Message,
  MessageParam,
  Tool,
  ToolResultBlockParam,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages'
import { z } from 'zod'
import { ServiceError, toolSchemas } from '../contracts.js'
import { WeightedLimiter } from '../hyperliquid/client.js'
export type { Message, MessageParam, ToolResultBlockParam }
export const ADAPTER_VERSION = `claude-provider-v2-stream/sdk-${VERSION}`
const descriptions = {
  get_market_overview:
    'Query one active default Hyperliquid perpetual market by original coin (BTC, ETH, HYPE...). Optional candleInterval requests candles; choose 1h unless user specifies. No spot or HIP-3.',
  get_account_overview:
    'Query this run’s fixed public user/subaccount; raw positions, balances only in verified mode, deterministic risk and stop-order observations. No signature or execution.',
  get_recent_fills:
    'Query a limited default perpetual fill sample for this run’s fixed account. Omit times for recent seven days; specify BOTH millisecond times only for an explicit historical interval (max 30 days). Never infer complete PnL.',
}
export const toolDefinitions: Tool[] = Object.entries(toolSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    input_schema: z.toJSONSchema(schema, {
      io: 'input',
    }) as Tool['input_schema'],
  }),
)
export interface ModelInput {
  messages: MessageParam[]
  system: string
  signal: AbortSignal
  deadline: number
  maxTokens: number
  tools: boolean
}
export type ProviderEvent =
  | { type: 'text'; text: string; blockIndex: number }
  | { type: 'tool.preparing'; id: string; name: string }
export type ModelResponse = Message & {
  toolInputErrors?: Record<string, string>
}

// Raw JSON is buffered by provider call ID, never forwarded to the client.
export class StreamAssembly {
  private indices = new Map<number, string>()
  private calls = new Map<
    string,
    { json: string; initial: unknown; closed: boolean }
  >()
  private texts = new Map<number, string>()
  constructor(private emit: (event: ProviderEvent) => void) {}
  accept(event: MessageStreamEvent) {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'tool_use') {
        if (this.calls.has(block.id) || this.indices.has(event.index))
          throw new ServiceError(
            'invalidModelStream',
            'Model returned duplicate tool calls',
            502,
          )
        this.indices.set(event.index, block.id)
        this.calls.set(block.id, {
          json: '',
          initial: block.input,
          closed: false,
        })
        this.emit({ type: 'tool.preparing', id: block.id, name: block.name })
      } else if (block.type === 'text' && block.text)
        this.text(event.index, block.text)
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta')
        this.text(event.index, event.delta.text)
      if (event.delta.type === 'input_json_delta') {
        const call = this.calls.get(this.indices.get(event.index) ?? '')
        if (!call || call.closed)
          throw new ServiceError(
            'invalidModelStream',
            'Model returned an invalid tool stream',
            502,
          )
        call.json += event.delta.partial_json
      }
    } else if (event.type === 'content_block_stop') {
      const call = this.calls.get(this.indices.get(event.index) ?? '')
      if (call) call.closed = true
    }
  }
  private text(index: number, text: string) {
    this.texts.set(index, (this.texts.get(index) ?? '') + text)
    if (text) this.emit({ type: 'text', blockIndex: index, text })
  }
  finish(message: Message): ModelResponse {
    const errors: Record<string, string> = {}
    for (const [index, block] of message.content.entries()) {
      if (block.type === 'text') {
        const sent = this.texts.get(index) ?? ''
        if (!block.text.startsWith(sent))
          throw new ServiceError(
            'invalidModelStream',
            'Model text did not match its stream',
            502,
          )
        this.text(index, block.text.slice(sent.length))
      }
      if (block.type === 'tool_use') {
        const call = this.calls.get(block.id)
        if (!call?.closed || message.stop_reason !== 'tool_use') {
          errors[block.id] = 'incompleteToolInput'
          block.input = {}
          continue
        }
        try {
          block.input = call.json ? JSON.parse(call.json) : call.initial
        } catch {
          errors[block.id] = 'invalidToolInput'
          block.input = {}
        }
      }
    }
    return { ...message, toolInputErrors: errors }
  }
}
export interface Provider {
  count(input: ModelInput): Promise<number>
  generate(
    input: ModelInput,
    onEvent: (event: ProviderEvent) => void,
  ): Promise<ModelResponse>
  final(
    input: ModelInput,
    onText: (text: string) => void,
    onEvent?: (event: ProviderEvent) => void,
  ): Promise<ModelResponse>
}
export class ClaudeProvider implements Provider {
  private sdk: Anthropic
  private limiter: WeightedLimiter
  constructor(
    private model: string,
    key: string,
    requestsPerMinute = 30,
  ) {
    this.limiter = new WeightedLimiter(requestsPerMinute, 'Claude')
    this.sdk = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20000 })
  }
  private body(input: ModelInput) {
    return {
      model: this.model,
      system: input.system,
      messages: input.messages,
      thinking: { type: 'disabled' as const },
      tools: toolDefinitions,
      tool_choice: input.tools
        ? { type: 'auto' as const }
        : { type: 'none' as const },
    }
  }
  private async gate(input: ModelInput) {
    await this.limiter.take(1, input.signal, input.deadline)
  }
  private options(input: ModelInput) {
    return {
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(
          Math.max(1, Math.min(20000, input.deadline - Date.now())),
        ),
      ]),
      maxRetries: 0,
    }
  }
  private error(e: unknown): never {
    if (e instanceof Anthropic.APIError) {
      if (e.status === 429) {
        const h = e.headers?.get('retry-after'),
          wait = h ? Number(h) * 1000 : 1000
        this.limiter.cooldown =
          Date.now() + Math.min(Number.isFinite(wait) ? wait : 1000, 60000)
      }
      throw new ServiceError(
        e.status === 429
          ? 'modelRateLimited'
          : e.status === 401
            ? 'modelCredentialsInvalid'
            : 'modelUnavailable',
        'Claude API request failed; check service configuration or retry later',
        502,
        e.status === 429 || !e.status || e.status >= 500,
      )
    }
    throw new ServiceError(
      'modelUnavailable',
      'Claude API request timed out or failed',
      502,
      true,
    )
  }
  async count(input: ModelInput) {
    await this.gate(input)
    try {
      return (
        await this.sdk.messages.countTokens(
          this.body(input),
          this.options(input),
        )
      ).input_tokens
    } catch (e) {
      if (e instanceof Anthropic.APIError) this.error(e)
      throw new ServiceError(
        'tokenCountUnavailable',
        'Cannot verify model input token budget',
        502,
        true,
      )
    }
  }
  private async request(
    input: ModelInput,
    onEvent: (event: ProviderEvent) => void,
  ) {
    await this.gate(input)
    const stream = this.sdk.messages.stream(
      { ...this.body(input), max_tokens: input.maxTokens },
      this.options(input),
    )
    try {
      const assembly = new StreamAssembly(onEvent)
      for await (const event of stream) {
        input.signal.throwIfAborted()
        assembly.accept(event)
      }
      input.signal.throwIfAborted()
      return assembly.finish(await stream.finalMessage())
    } catch (e) {
      if (e instanceof ServiceError) throw e
      this.error(e)
    } finally {
      if (!stream.ended) stream.abort()
    }
  }
  generate(input: ModelInput, onEvent: (event: ProviderEvent) => void) {
    return this.request(input, onEvent)
  }
  final(
    input: ModelInput,
    onText: (text: string) => void,
    onEvent?: (event: ProviderEvent) => void,
  ) {
    return this.request(
      { ...input, tools: false },
      onEvent ??
        ((event) => {
          if (event.type === 'text') onText(event.text)
        }),
    )
  }
}
