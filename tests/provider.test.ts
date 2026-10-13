import { afterEach, expect, it, vi } from 'vitest'
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages'
import { ClaudeProvider, StreamAssembly } from '../src/ai/provider.js'
const message = (content: Message['content']): Message => ({
  id: 'm',
  type: 'message',
  role: 'assistant',
  model: 'test',
  content,
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
})
it('buffers multiple tool IDs independently and rejects unfinished, malformed JSON', () => {
  const emit = vi.fn(),
    assembly = new StreamAssembly(emit)
  const accept = (event: MessageStreamEvent) => assembly.accept(event)
  accept({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '', citations: null },
  })
  accept({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Checking' },
  })
  const calls = ['a', 'b', 'c', 'd'].map((id) => ({
    type: 'tool_use' as const,
    id,
    name: 'get_market_overview',
    input: {},
  }))
  calls.forEach((call, i) =>
    accept({ type: 'content_block_start', index: i + 1, content_block: call }),
  )
  for (const [index, partial_json] of [
    [1, '{"coin":'],
    [2, '{"coin":"ETH"}'],
    [1, '"BTC"}'],
    [3, '{bad}'],
    [4, '{"coin":'],
  ] as const)
    accept({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json },
    })
  for (const index of [1, 2, 3]) accept({ type: 'content_block_stop', index })
  const result = assembly.finish(
    message([{ type: 'text', text: 'Checking', citations: null }, ...calls]),
  )
  expect(result.content.slice(1, 3)).toMatchObject([
    { id: 'a', input: { coin: 'BTC' } },
    { id: 'b', input: { coin: 'ETH' } },
  ])
  expect(result.toolInputErrors).toEqual({
    c: 'invalidToolInput',
    d: 'incompleteToolInput',
  })
  expect(emit.mock.calls.map(([event]) => event.type)).toEqual([
    'text',
    ...calls.map(() => 'tool.preparing'),
  ])
  expect(JSON.stringify(emit.mock.calls)).not.toContain('coin')
})
it('reconciles complete text without duplicating deltas and rejects duplicate IDs', () => {
  const emit = vi.fn(),
    assembly = new StreamAssembly(emit)
  assembly.accept({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  })
  assembly.finish(
    message([{ type: 'text', text: 'Hello world', citations: null }]),
  )
  expect(emit.mock.calls.map(([e]) => e.text).join('')).toBe('Hello world')
  const start: MessageStreamEvent = {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'a',
      name: 'get_account_overview',
      input: {},
    },
  }
  assembly.accept(start)
  expect(() => assembly.accept({ ...start, index: 2 })).toThrow(
    'duplicate tool calls',
  )
})
afterEach(() => vi.unstubAllGlobals())
it.each(['generate', 'final'] as const)(
  'uses the installed SDK stream interface for %s',
  async (method) => {
    const final = message([
      { type: 'text', text: 'Live answer', citations: null },
    ])
    const events = [
      {
        type: 'message_start',
        message: { ...final, content: [], stop_reason: null },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Live answer' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ]
    const fetch = vi.fn(async (url: unknown, init: RequestInit | undefined) => {
      expect(String(url)).toContain('/messages')
      expect(init?.method).toBe('POST')
      return new Response(
        events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    vi.stubGlobal('fetch', fetch)
    const provider = new ClaudeProvider('test', 'test-only'),
      emit = vi.fn()
    const input = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      system: '',
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
      maxTokens: 50,
      tools: true,
    }
    const result =
      method === 'generate'
        ? await provider.generate(input, emit)
        : await provider.final(input, vi.fn(), emit)
    expect(result.content).toMatchObject([
      { type: 'text', text: 'Live answer' },
    ])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      stream: true,
      tool_choice: { type: method === 'final' ? 'none' : 'auto' },
    })
  },
)
it.each(['error', 'cancel'] as const)(
  'retains delivered text and rejects SDK streaming %s',
  async (mode) => {
    const abort = new AbortController()
    const start = message([])
    const events = [
      { type: 'message_start', message: { ...start, stop_reason: null } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Intermediate' },
      },
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'private detail' },
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            events
              .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )
    const provider = new ClaudeProvider('test', 'test-only'),
      texts: string[] = []
    await expect(
      provider.generate(
        {
          messages: [],
          system: '',
          signal: abort.signal,
          deadline: Date.now() + 5000,
          maxTokens: 50,
          tools: true,
        },
        (event) => {
          if (event.type === 'text') {
            texts.push(event.text)
            if (mode === 'cancel') abort.abort()
          }
        },
      ),
    ).rejects.toMatchObject({ code: 'modelUnavailable' })
    expect(texts).toEqual(['Intermediate'])
  },
)
