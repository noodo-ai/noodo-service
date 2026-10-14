import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import argon2 from 'argon2'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/db/store.js'
import { createServer } from '../src/server.js'
import { Runner } from '../src/ai/runner.js'
import { BusinessTools } from '../src/hyperliquid/tools.js'
import { InfoClient } from '../src/hyperliquid/client.js'
import { type Provider } from '../src/ai/provider.js'
import { address, market } from './fixtures/hyperliquid.js'
const config = loadConfig({
  ANTHROPIC_API_KEY: 'test-only',
  CLAUDE_MODEL: 'test-model',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  NODE_ENV: 'development',
  COOKIE_SECURE: 'false',
})
const origin = 'http://localhost:5173'
const resources: {
  app: Awaited<ReturnType<typeof createServer>>
  store: Store
}[] = []
afterEach(async () => {
  for (const r of resources.splice(0)) {
    await r.app.close()
    r.store.close()
  }
})
function response(content: Message['content'], output = 10): Message {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    model: 'test-pinned',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}
function provider(): Provider {
  return {
    count: vi.fn(async () => 100),
    generate: vi.fn(async () =>
      response([
        {
          type: 'tool_use',
          id: 'tool-use-1',
          name: 'get_market_overview',
          input: { coin: 'BTC' },
        },
      ]),
    ),
    final: vi.fn(async (input, onText) => {
      expect(input.tools).toBe(false)
      onText('BTC mark price is 100 USD. ')
      onText('Default perpetuals only.')
      return response([
        {
          type: 'text',
          text: 'BTC mark price is 100 USD. Default perpetuals only.',
          citations: null,
        },
      ])
    }),
  }
}
async function setup(p = provider()) {
  const store = new Store(':memory:'),
    owner = randomUUID(),
    password = 'test-password-123'
  store.sql
    .prepare('INSERT INTO users VALUES(?,?,?,?)')
    .run(owner, 'invited', await argon2.hash(password), Date.now())
  const tools = new BusinessTools(
    new InfoClient(900, async () => new Response(JSON.stringify(market))),
  )
  const app = await createServer(config, {
    store,
    provider: p,
    tools,
    logger: false,
  })
  resources.push({ app, store })
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin },
    payload: { username: 'invited', password },
  })
  const session = String(login.headers['set-cookie']).split(';')[0]!
  return { app, store, owner, session, password, tools, p }
}
it('requires session and exact Origin, rejects missing origin, logs out immediately', async () => {
  const { app, session } = await setup()
  expect((await app.inject({ url: '/v1/conversations' })).statusCode).toBe(401)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { cookie: session },
        payload: {},
      })
    ).statusCode,
  ).toBe(403)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: { cookie: session, origin: 'https://evil.invalid' },
        payload: {},
      })
    ).statusCode,
  ).toBe(403)
  await app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { cookie: session, origin },
  })
  expect(
    (await app.inject({ url: '/v1/auth/me', headers: { cookie: session } }))
      .statusCode,
  ).toBe(401)
})
it('returns SSE, persisted cards and usage; duplicate returns JSON even after address change', async () => {
  const { app, store, owner, session, p } = await setup(),
    headers = { cookie: session, origin }
  const c = (
    await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers,
      payload: { observedAddress: address },
    })
  ).json()
  const payload = {
    clientRequestId: randomUUID(),
    text: 'BTC market?',
    expectedAddressVersion: 1,
  }
  const first = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${c.id}/messages`,
    headers,
    payload,
  })
  expect(first.headers['content-type']).toContain('text/event-stream')
  expect(first.body).toContain('event: message.completed')
  expect(first.body).toContain('event: tool.completed')
  expect(first.body).not.toContain('partial_json')
  const runId = String(first.headers['x-run-id']),
    saved = store.run(runId, owner)
  expect(saved.status).toBe('completed')
  expect(saved.settledTokens).toBe(440)
  expect(saved.model).toBe('test-pinned')
  expect(JSON.parse(saved.result!).sources.length).toBe(3)
  const second = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${c.id}/messages`,
    headers,
    payload,
  })
  expect(second.headers['content-type']).toContain('application/json')
  expect(second.json().runId).toBe(runId)
  expect(p.final).toHaveBeenCalledTimes(1)
  await app.inject({
    method: 'PATCH',
    url: `/v1/conversations/${c.id}`,
    headers,
    payload: { observedAddress: null, expectedAddressVersion: 1 },
  })
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `/v1/conversations/${c.id}/messages`,
        headers,
        payload,
      })
    ).json().runId,
  ).toBe(runId)
  const history = (
    await app.inject({ url: `/v1/conversations/${c.id}`, headers })
  ).json()
  expect(history.messages).toHaveLength(2)
  expect(history.runs[0].result.dataCards.length).toBeGreaterThan(0)
  expect(history.runs[0].createdAt).toBe(saved.createdAt)
  expect(history.runs[0].settledAt).toBe(saved.settledAt)
})
it('rejects empty input before SSE and does not expose cross-user run', async () => {
  const { app, store, owner, session } = await setup(),
    c = store.create(owner, null),
    headers = { cookie: session, origin }
  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${c.id}/messages`,
    headers,
    payload: {
      clientRequestId: randomUUID(),
      text: '   ',
      expectedAddressVersion: 1,
    },
  })
  expect(response.statusCode).toBe(400)
  expect(response.headers['content-type']).toContain('application/json')
  const other = randomUUID()
  store.sql
    .prepare('INSERT INTO users VALUES(?,?,?,?)')
    .run(other, 'other', 'hash', Date.now())
  const hidden = store.create(other, null),
    run = store.accept(
      hidden.id,
      other,
      {
        clientRequestId: randomUUID(),
        text: 'test',
        expectedAddressVersion: 1,
      },
      config,
    ).run
  expect(
    (await app.inject({ url: `/v1/runs/${run.id}`, headers })).statusCode,
  ).toBe(404)
})
it('returns retry-after on login throttling and never creates a public signup route', async () => {
  const { app } = await setup()
  let status = 0,
    header: unknown
  for (let i = 0; i < 10; i++) {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin },
      payload: { username: 'missing', password: 'bad' },
    })
    status = r.statusCode
    header = r.headers['retry-after']
  }
  expect(status).toBe(429)
  expect(header).toBe('60')
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { origin },
        payload: {},
      })
    ).statusCode,
  ).toBe(401)
})
it('pairs rejected tool calls, preserves snapshots and fails conservatively on model error', async () => {
  const p = provider()
  p.generate = vi.fn(async () =>
    response([{ type: 'tool_use', id: 'forbidden', name: 'trade', input: {} }]),
  )
  p.final = vi.fn(async (input) => {
    const serialized = JSON.stringify(input.messages)
    expect(serialized).toContain('tool_use_id')
    expect(serialized).toContain('forbidden')
    throw new Error('provider secret must not leak')
  })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null),
    run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: 'execute trade',
        expectedAddressVersion: 1,
      },
      config,
    ).run
  const events: { event: string; data: unknown }[] = []
  await new Runner(store, tools, p).execute(
    run,
    new AbortController().signal,
    (event, data) => events.push({ event, data }),
  )
  const saved = store.run(run.id, owner)
  expect(saved.status).toBe('failed')
  expect(saved.settledTokens).toBe(2430)
  expect(saved.error).not.toContain('secret')
  expect(events.at(-1)?.event).toBe('run.failed')
})
it('cancels mid-stream, persists partial text and refuses a late completion', async () => {
  const p = provider(),
    abort = new AbortController()
  p.generate = vi.fn(async () => response([]))
  p.final = vi.fn(async (input, onText) => {
    onText('Partial saved')
    abort.abort()
    input.signal.throwIfAborted()
    return response([])
  })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null),
    run = store.accept(
      c.id,
      owner,
      { clientRequestId: randomUUID(), text: 'hi', expectedAddressVersion: 1 },
      config,
    ).run
  await new Runner(store, tools, p).execute(run, abort.signal, () => {})
  const saved = store.run(run.id, owner)
  expect(saved.status).toBe('interrupted')
  expect(JSON.parse(saved.result!).textStatus).toBe('partial')
  expect(JSON.parse(saved.result!).text).toBe('Partial saved')
  expect(saved.settledTokens).toBe(2210)
})
it('fails before generation if token counting fails or budget cannot be verified', async () => {
  const p = provider()
  p.count = vi.fn(async () => {
    throw new Error('count failed')
  })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null),
    run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: 'BTC?',
        expectedAddressVersion: 1,
      },
      config,
    ).run
  await new Runner(store, tools, p).execute(
    run,
    new AbortController().signal,
    () => {},
  )
  expect(store.run(run.id, owner).status).toBe('failed')
  expect(p.generate).not.toHaveBeenCalled()
})

it.each(['end_turn'] as const)(
  'keeps the answer returned after a partial tool result (%s)',
  async (stopReason) => {
    const p = provider()
    const answer = response([
      { type: 'text', text: 'Data coverage is incomplete.', citations: null },
    ])
    answer.stop_reason = stopReason
    vi.mocked(p.generate)
      .mockResolvedValueOnce(
        response([
          {
            type: 'tool_use',
            id: 'partial-tool',
            name: 'get_market_overview',
            input: { coin: 'BTC' },
          },
        ]),
      )
      .mockResolvedValueOnce(answer)
    const { store, owner, tools } = await setup(p)
    vi.spyOn(tools, 'execute').mockResolvedValue({
      data: {},
      sources: [],
      coverage: {
        marketScope: 'hyperliquid:mainnet:default-perpetuals',
        observedAddress: null,
        complete: false,
        reasonCodes: ['pricesUnavailable'],
      },
      warnings: ['Scope: default perpetuals only'],
    })
    const c = store.create(owner, null)
    const run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: 'BTC?',
        expectedAddressVersion: 1,
      },
      config,
    ).run
    const report = vi.fn()
    const emit = vi.fn()
    await new Runner(store, tools, p, report).execute(
      run,
      new AbortController().signal,
      emit,
    )
    const saved = store.run(run.id, owner)
    expect(saved.status).toBe('completed')
    expect(JSON.parse(saved.result!)).toMatchObject({
      text: 'Data coverage is incomplete.',
      textStatus: stopReason === 'max_tokens' ? 'partial' : 'final',
    })
    expect(p.final).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      'message.delta',
      expect.objectContaining({
        text: 'Data coverage is incomplete.',
      }),
    )
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        toolExecutions: 1,
        toolFailures: 0,
        status: 'completed',
        errorCode: null,
      }),
    )
  },
)

it.each([true, false])(
  'uses final message content without duplicating streamed text (deltas=%s)',
  async (deltas) => {
    const p = provider()
    p.generate = vi.fn(async () => response([]))
    p.final = vi.fn(async (_input, onText) => {
      if (deltas) onText('Complete response')
      return response([
        { type: 'text', text: 'Complete response', citations: null },
      ])
    })
    const { store, owner, tools } = await setup(p)
    const c = store.create(owner, null)
    const run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: 'hi',
        expectedAddressVersion: 1,
      },
      config,
    ).run
    await new Runner(store, tools, p).execute(
      run,
      new AbortController().signal,
      () => {},
    )
    const saved = store.run(run.id, owner)
    expect(saved.status).toBe('completed')
    expect(JSON.parse(saved.result!).text).toBe('Complete response')
  },
)

it('reports a genuinely empty final response as failed with model diagnostics', async () => {
  const p = provider()
  p.generate = vi.fn(async () => response([]))
  p.final = vi.fn(async () => response([]))
  const { store, owner, tools } = await setup(p)
  const c = store.create(owner, null)
  const run = store.accept(
    c.id,
    owner,
    {
      clientRequestId: randomUUID(),
      text: 'hi',
      expectedAddressVersion: 1,
    },
    config,
  ).run
  const report = vi.fn()
  await new Runner(store, tools, p, report).execute(
    run,
    new AbortController().signal,
    () => {},
  )
  expect(store.run(run.id, owner).status).toBe('failed')
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'failed',
      errorCode: 'emptyModelResponse',
      toolFailures: 0,
      modelResponses: [
        {
          stage: 'generate',
          stopReason: 'end_turn',
          contentTypes: [],
          textCharacters: 0,
          outputTokens: 10,
        },
        {
          stage: 'final',
          stopReason: 'end_turn',
          contentTypes: [],
          textCharacters: 0,
          outputTokens: 10,
        },
      ],
    }),
  )
})

it('streams explanation, multiple prepared calls, execution and final text in order; restores activity', async () => {
  const p = provider(),
    order: string[] = []
  p.generate = vi
    .fn()
    .mockImplementationOnce(async (_input, emit) => {
      emit({ type: 'text', blockIndex: 0, text: 'Checking markets.' })
      emit({ type: 'tool.preparing', id: 'btc', name: 'get_market_overview' })
      emit({ type: 'tool.preparing', id: 'eth', name: 'get_market_overview' })
      return response([
        { type: 'text', text: 'Checking markets.', citations: null },
        {
          type: 'tool_use',
          id: 'btc',
          name: 'get_market_overview',
          input: { coin: 'BTC' },
        },
        {
          type: 'tool_use',
          id: 'eth',
          name: 'get_market_overview',
          input: { coin: 'ETH' },
        },
      ])
    })
    .mockImplementationOnce(async (input, emit) => {
      const last = input.messages.at(-1)!.content
      expect(last).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool_use_id: 'btc' }),
          expect.objectContaining({ tool_use_id: 'eth', is_error: true }),
        ]),
      )
      emit({
        type: 'text',
        blockIndex: 0,
        text: 'ETH is unavailable. BTC is available.',
      })
      return response([
        {
          type: 'text',
          text: 'ETH is unavailable. BTC is available.',
          citations: null,
        },
      ])
    })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null)
  vi.spyOn(tools, 'execute').mockImplementation(async (_name, args) => {
    order.push('execute')
    if ((args as { coin: string }).coin === 'ETH')
      throw new Error('secret upstream data')
    return {
      data: {},
      sources: [],
      coverage: {
        marketScope: c.marketScope,
        observedAddress: null,
        complete: true,
        reasonCodes: [],
      },
      warnings: ['scope warning'],
    }
  })
  const run = store.accept(
    c.id,
    owner,
    {
      clientRequestId: randomUUID(),
      text: 'markets?',
      expectedAddressVersion: 1,
    },
    config,
  ).run
  await new Runner(store, tools, p).execute(
    run,
    new AbortController().signal,
    (event) => order.push(event),
  )
  expect(order).toEqual([
    'run.started',
    'tool.preparing',
    'tool.preparing',
    'message.delta',
    'message.round.completed',
    'tool.started',
    'execute',
    'tool.completed',
    'tool.started',
    'execute',
    'tool.completed',
    'message.delta',
    'message.delta',
    'message.round.completed',
    'message.completed',
  ])
  const saved = JSON.parse(store.run(run.id, owner).result!)
  expect(saved.text).toBe(
    'Checking markets.\n\nETH is unavailable. BTC is available.',
  )
  expect(saved.activity).toMatchObject([
    { type: 'text', phase: 'explanation', text: 'Checking markets.' },
    { type: 'tool', status: 'success' },
    { type: 'tool', status: 'failed' },
    {
      type: 'text',
      phase: 'final',
      text: 'ETH is unavailable. BTC is available.',
    },
  ])
  expect(store.history(c.id).messages.at(-1)?.text).toBe(saved.text)
})
it('does not execute incomplete or invalid calls and pairs their errors before continuing', async () => {
  const p = provider()
  p.generate = vi
    .fn()
    .mockResolvedValueOnce({
      ...response([
        {
          type: 'tool_use',
          id: 'incomplete',
          name: 'get_market_overview',
          input: { coin: 'BTC' },
        },
        {
          type: 'tool_use',
          id: 'invalid',
          name: 'get_market_overview',
          input: { coin: 1 },
        },
      ]),
      toolInputErrors: { incomplete: 'incompleteToolInput' },
    })
    .mockImplementationOnce(async (input) => {
      expect(input.messages.at(-1)?.content).toEqual([
        expect.objectContaining({ tool_use_id: 'incomplete', is_error: true }),
        expect.objectContaining({ tool_use_id: 'invalid', is_error: true }),
      ])
      return response([
        {
          type: 'text',
          text: 'Arguments could not be completed.',
          citations: null,
        },
      ])
    })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null),
    execute = vi.spyOn(tools, 'execute')
  const run = store.accept(
    c.id,
    owner,
    { clientRequestId: randomUUID(), text: 'hi', expectedAddressVersion: 1 },
    config,
  ).run
  await new Runner(store, tools, p).execute(
    run,
    new AbortController().signal,
    () => {},
  )
  expect(execute).not.toHaveBeenCalled()
  expect(store.run(run.id, owner).status).toBe('completed')
  expect(
    JSON.parse(store.run(run.id, owner).result!)
      .activity.filter((a: { type: string }) => a.type === 'tool')
      .map((a: { status: string }) => a.status),
  ).toEqual(['failed', 'failed'])
})
it.each(['empty', 'error', 'cancel'] as const)(
  'keeps intermediate text but does not succeed when final is %s',
  async (mode) => {
    const p = provider(),
      abort = new AbortController()
    p.generate = vi.fn(async (_input, emit) => {
      emit({ type: 'text', blockIndex: 0, text: 'Checking.' })
      return response([
        { type: 'text', text: 'Checking.', citations: null },
        {
          type: 'tool_use',
          id: 'call',
          name: 'get_market_overview',
          input: { coin: 'BTC' },
        },
      ])
    })
    p.final = vi.fn(async () => {
      if (mode === 'error') throw new Error('stream failed')
      if (mode === 'cancel') abort.abort()
      return response([])
    })
    const { store, owner, tools } = await setup(p),
      c = store.create(owner, null)
    const run = store.accept(
      c.id,
      owner,
      { clientRequestId: randomUUID(), text: 'hi', expectedAddressVersion: 1 },
      config,
    ).run
    await new Runner(store, tools, p).execute(run, abort.signal, () => {})
    const saved = store.run(run.id, owner)
    expect(saved.status).toBe(mode === 'cancel' ? 'interrupted' : 'failed')
    expect(JSON.parse(saved.result!).textStatus).toBe('partial')
    expect(JSON.parse(saved.result!).text).toBe(
      'Checking.\n\nChecking.\n\nChecking.',
    )
    if (mode === 'empty')
      expect(JSON.parse(saved.error!).code).toBe('emptyModelResponse')
  },
)
it('cancels while preparing without executing, and settles pending tool status', async () => {
  const p = provider(),
    abort = new AbortController()
  p.generate = vi.fn(async (input, emit) => {
    emit({ type: 'text', blockIndex: 0, text: 'Checking.' })
    emit({ type: 'tool.preparing', id: 'call', name: 'get_market_overview' })
    abort.abort()
    input.signal.throwIfAborted()
    return response([])
  })
  const { store, owner, tools } = await setup(p),
    c = store.create(owner, null),
    execute = vi.spyOn(tools, 'execute')
  const run = store.accept(
    c.id,
    owner,
    { clientRequestId: randomUUID(), text: 'hi', expectedAddressVersion: 1 },
    config,
  ).run
  await new Runner(store, tools, p).execute(run, abort.signal, () => {})
  expect(execute).not.toHaveBeenCalled()
  const saved = store.run(run.id, owner)
  expect(saved.status).toBe('interrupted')
  expect(JSON.parse(saved.result!).activity[1].status).toBe('failed')
  expect(
    store.sql
      .prepare('SELECT status FROM tool_calls WHERE runId=?')
      .get(run.id),
  ).toEqual({ status: 'failed' })
  expect(saved.settledTokens).toBe(2100)
})
it('allows model generation beyond the former request timeout', async () => {
  const p = provider()
  p.generate = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120000))
    return response([
      { type: 'text', text: 'Complete answer.', citations: null },
    ])
  })
  const { store, owner, tools } = await setup(p)
  const c = store.create(owner, null)
  const run = store.accept(
    c.id,
    owner,
    {
      clientRequestId: randomUUID(),
      text: 'hi',
      expectedAddressVersion: 1,
    },
    config,
  ).run
  vi.useFakeTimers()
  try {
    const executing = new Runner(store, tools, p).execute(
      run,
      new AbortController().signal,
      () => {},
    )
    await vi.advanceTimersByTimeAsync(120000)
    await executing
    expect(store.run(run.id, owner).status).toBe('completed')
    expect(JSON.parse(store.run(run.id, owner).result!)).toMatchObject({
      text: 'Complete answer.',
      textStatus: 'final',
    })
  } finally {
    vi.useRealTimers()
  }
})

it.each(['length', 'tokens', 'still-long', 'failure'] as const)(
  'compresses final drafts before publishing (%s)',
  async (mode) => {
    const p = provider()
    const draft = mode === 'tokens' ? 'Truncated draft' : '长'.repeat(1201)
    p.generate = vi.fn(async (_input, emit) => {
      emit({ type: 'text', text: draft, blockIndex: 0 })
      return {
        ...response([{ type: 'text', text: draft, citations: null }], 2000),
        stop_reason: mode === 'tokens' ? 'max_tokens' : 'end_turn',
      }
    })
    p.final = vi.fn(async (input, onText) => {
      expect(input.tools).toBe(false)
      expect(input.messages.at(-1)?.content).toContain(
        'Rewrite the preceding draft',
      )
      const text =
        mode === 'failure' ||
        (mode === 'still-long' && vi.mocked(p.final).mock.calls.length === 1)
          ? '长'.repeat(1201)
          : '数据覆盖不完整。仅依据当前快照判断，需关注仓位集中风险。'
      onText(text)
      return response([{ type: 'text', text, citations: null }], 100)
    })
    const { store, owner, tools } = await setup(p)
    const c = store.create(owner, null)
    const run = store.accept(
      c.id,
      owner,
      {
        clientRequestId: randomUUID(),
        text: '分析',
        expectedAddressVersion: 1,
      },
      config,
    ).run
    const emit = vi.fn()
    await new Runner(store, tools, p).execute(
      run,
      new AbortController().signal,
      emit,
    )
    const saved = store.run(run.id, owner)
    expect(saved.status).toBe(mode === 'failure' ? 'failed' : 'completed')
    expect(p.final).toHaveBeenCalledTimes(
      ['failure', 'still-long'].includes(mode) ? 2 : 1,
    )
    const result = JSON.parse(saved.result!)
    const published = emit.mock.calls
      .filter(([event]) => event === 'message.delta')
      .map(([, data]) => data.text)
      .join('')
    expect(published).not.toContain(draft)
    expect(result.text).toBe(published)
    if (mode === 'failure') {
      expect(result.text).toBe('')
      expect(JSON.parse(saved.error!).code).toBe('incompleteModelResponse')
    } else {
      expect(result.textStatus).toBe('final')
      expect(result.text).toContain('数据覆盖不完整')
      expect(
        result.activity.filter((a: { type: string }) => a.type === 'text'),
      ).toHaveLength(1)
    }
    expect(JSON.parse(saved.tokenUsage).output).toBe(
      2000 + vi.mocked(p.final).mock.calls.length * 100,
    )
    expect(JSON.parse(saved.tokenUsage).unconfirmed).toBe(0)
  },
)

it('counts supplementary Unicode characters once at the reply boundary', async () => {
  const p = provider()
  const text = '𠮷'.repeat(1200)
  p.generate = vi.fn(async () =>
    response([{ type: 'text', text, citations: null }]),
  )
  const { store, owner, tools } = await setup(p)
  const c = store.create(owner, null)
  const run = store.accept(
    c.id,
    owner,
    {
      clientRequestId: randomUUID(),
      text: 'hi',
      expectedAddressVersion: 1,
    },
    config,
  ).run
  await new Runner(store, tools, p).execute(
    run,
    new AbortController().signal,
    () => {},
  )
  expect(store.run(run.id, owner).status).toBe('completed')
  expect(JSON.parse(store.run(run.id, owner).result!).text).toBe(text)
  expect(p.final).not.toHaveBeenCalled()
})

it.each(['get_account_overview', 'get_recent_fills'] as const)(
  'dispatches %s with the address supplied in chat without a selector',
  async (name) => {
    const p = provider()
    vi.mocked(p.generate)
      .mockResolvedValueOnce(
        response([
          { type: 'tool_use', id: 'account-query', name, input: { address } },
        ]),
      )
      .mockResolvedValue(
        response([{ type: 'text', text: 'Account queried.', citations: null }]),
      )
    const { app, store, owner, session, tools } = await setup(p)
    const execute = vi
      .spyOn(tools, 'execute')
      .mockImplementation(async (_name, _input, ctx) => ({
        data: {},
        sources: [],
        warnings: [],
        coverage: {
          marketScope: 'hyperliquid:mainnet:default-perpetuals',
          observedAddress: ctx.address,
          complete: true,
          reasonCodes: [],
        },
      }))
    const headers = { cookie: session, origin }
    const c = (
      await app.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers,
        payload: {},
      })
    ).json()
    const result = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${c.id}/messages`,
      headers,
      payload: {
        clientRequestId: randomUUID(),
        text: `查看 ${address} 的${name === 'get_recent_fills' ? '最近成交' : '持仓风险'}`,
        expectedAddressVersion: 1,
      },
    })
    expect(result.statusCode).toBe(200)
    expect(execute).toHaveBeenCalledWith(
      name,
      { address },
      expect.objectContaining({ address }),
    )
    const run = store.run(String(result.headers['x-run-id']), owner)
    expect(run).toMatchObject({
      observedAddress: address,
      addressVersion: 2,
      status: 'completed',
    })
    expect(JSON.parse(run.result!).coverage[0].observedAddress).toBe(address)
    expect(vi.mocked(p.generate).mock.calls[0][0].system).toContain(
      `Fixed observedAddress=${address}`,
    )
  },
)

it('accepts and sends the full message beyond 4000 characters to the model', async () => {
  const { app, store, owner, session, p } = await setup()
  const conversation = store.create(owner, null)
  const text = `${'x'.repeat(8000)} END OF FILE`
  const result = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversation.id}/messages`,
    headers: { cookie: session, origin },
    payload: {
      clientRequestId: randomUUID(),
      text,
      expectedAddressVersion: 1,
    },
  })
  expect(result.statusCode).toBe(200)
  expect(store.history(conversation.id).messages[0]?.text).toBe(text)
  const input = vi.mocked(p.generate).mock.calls[0]?.[0]
  expect(input?.messages[0]?.content).toContain(text)
})
