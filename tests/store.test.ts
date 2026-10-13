import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Store, quotaDate } from '../src/db/store.js'
import { emptyResult } from '../src/contracts.js'
import { loadConfig } from '../src/config.js'
import { address, otherAddress } from './fixtures/hyperliquid.js'
const config = loadConfig({
  ANTHROPIC_API_KEY: 'test-only',
  CLAUDE_MODEL: 'test-model',
  ALLOWED_ORIGINS: 'http://localhost:5173',
  NODE_ENV: 'development',
  COOKIE_SECURE: 'false',
})
const stores: Store[] = []
function setup() {
  const store = new Store(':memory:')
  stores.push(store)
  const owner = randomUUID(),
    other = randomUUID()
  for (const id of [owner, other])
    store.sql
      .prepare('INSERT INTO users VALUES(?,?,?,?)')
      .run(id, id, 'test-hash', Date.now())
  const c = store.create(owner, address)
  return {
    store,
    owner,
    other,
    c,
    p: {
      clientRequestId: randomUUID(),
      text: 'BTC price?',
      expectedAddressVersion: 1,
    },
  }
}
afterEach(() => stores.splice(0).forEach((s) => s.close()))
describe('atomic runs and resource ownership', () => {
  it('accepts once, settles once, and allows duplicate after address switch', () => {
    const { store, owner, c, p } = setup()
    const first = store.accept(c.id, owner, p, config)
    expect(store.accept(c.id, owner, p, config).duplicate).toBe(true)
    const result = {
      ...emptyResult(),
      text: 'Saved answer',
      textStatus: 'final' as const,
    }
    expect(
      store.finish(
        first.run,
        'completed',
        result,
        { input: 100, output: 20, unconfirmed: 0 },
        null,
      ),
    ).toBe(true)
    expect(
      store.finish(
        first.run,
        'interrupted',
        emptyResult(),
        { input: 0, output: 0, unconfirmed: 32000 },
        null,
      ),
    ).toBe(false)
    store.updateAddress(c.id, owner, otherAddress, 1)
    expect(store.accept(c.id, owner, p, config).run.observedAddress).toBe(
      address,
    )
    expect(store.run(first.run.id, owner).settledTokens).toBe(120)
    expect(
      store.history(c.id).messages.filter((m) => m.role === 'assistant'),
    ).toHaveLength(1)
  })
  it('rejects duplicate ID with different payload, version conflict, and active-run address update', () => {
    const { store, owner, c, p } = setup()
    store.accept(c.id, owner, p, config)
    expect(() =>
      store.accept(c.id, owner, { ...p, text: 'different' }, config),
    ).toThrow('different payload')
    expect(() =>
      store.accept(
        c.id,
        owner,
        { ...p, clientRequestId: randomUUID() },
        config,
      ),
    ).toThrow('active run')
    expect(() => store.updateAddress(c.id, owner, otherAddress, 1)).toThrow(
      'active run',
    )
    expect(() =>
      store.accept(
        c.id,
        owner,
        { ...p, clientRequestId: randomUUID(), expectedAddressVersion: 2 },
        config,
      ),
    ).toThrow('changed')
  })
  it('does not leak conversation or run to another invited user', () => {
    const { store, owner, other, c, p } = setup()
    const run = store.accept(c.id, owner, p, config).run
    expect(() => store.owner(c.id, other)).toThrow('not found')
    expect(() => store.run(run.id, other)).toThrow('not found')
  })
  it('counts active reservations and enforces global concurrency atomically', () => {
    const { store, owner, c, p } = setup()
    store.accept(c.id, owner, p, {
      ...config,
      GLOBAL_DAILY_TOKEN_LIMIT: 32000,
    })
    const next = store.create(owner, null)
    expect(() =>
      store.accept(
        next.id,
        owner,
        { ...p, clientRequestId: randomUUID() },
        { ...config, GLOBAL_DAILY_TOKEN_LIMIT: 32000 },
      ),
    ).toThrow('token allowance')
    expect(() =>
      store.accept(
        next.id,
        owner,
        { ...p, clientRequestId: randomUUID() },
        { ...config, USER_DAILY_REQUEST_LIMIT: 1 },
      ),
    ).toThrow('request allowance')
    for (let i = 0; i < 9; i++) {
      const chat = store.create(owner, null)
      store.accept(
        chat.id,
        owner,
        { ...p, clientRequestId: randomUUID() },
        config,
      )
    }
    expect(() =>
      store.accept(
        next.id,
        owner,
        { ...p, clientRequestId: randomUUID() },
        config,
      ),
    ).toThrow('busy')
  })
  it('recovers running runs with persisted partial result and conservative quota settlement', () => {
    const { store, owner, c, p } = setup()
    const run = store.accept(c.id, owner, p, config).run
    store.checkpoint(
      run.id,
      { ...emptyResult(), text: 'partial', textStatus: 'partial' },
      { input: 20, output: 5, unconfirmed: 0 },
    )
    store.recover()
    store.recover()
    const recovered = store.run(run.id, owner)
    expect(recovered.status).toBe('interrupted')
    expect(recovered.settledTokens).toBe(32000)
    expect(JSON.parse(recovered.result!).textStatus).toBe('partial')
    expect(store.history(c.id).messages).toHaveLength(2)
  })
  it('paginates equal-time messages with a stable cursor', () => {
    const { store, owner, c, p } = setup()
    const run = store.accept(c.id, owner, p, config).run
    store.finish(
      run,
      'completed',
      emptyResult(),
      { input: 0, output: 0, unconfirmed: 0 },
      null,
    )
    store.sql.prepare('UPDATE messages SET createdAt=1').run()
    const first = store.history(c.id, 1)
    const second = store.history(c.id, 1, first.nextCursor!)
    expect(first.messages[0]?.id).not.toBe(second.messages[0]?.id)
    expect(second.nextCursor).toBeNull()
  })
})
it('uses Shanghai quota date at the UTC day boundary', () =>
  expect(quotaDate(Date.parse('2026-10-11T16:01:00Z'))).toBe('2026-10-12'))
it('rejects unsafe config without exposing the key', () => {
  expect(() => loadConfig({ ...config, NODE_ENV: 'production' })).toThrow(
    'only in development',
  )
  expect(() =>
    loadConfig({ ...config, ANTHROPIC_API_KEY: '', CLAUDE_MODEL: '' }),
  ).toThrow('ANTHROPIC_API_KEY')
})

it('uses the fixed Claude model without requiring a model environment variable', () => {
  const env = {
    ANTHROPIC_API_KEY: 'test-only',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    NODE_ENV: 'development',
    COOKIE_SECURE: 'false',
  }
  expect(loadConfig(env).CLAUDE_MODEL).toBe('claude-sonnet-4-6')
  expect(loadConfig({ ...env, CLAUDE_MODEL: '' }).CLAUDE_MODEL).toBe(
    'claude-sonnet-4-6',
  )
  expect(
    loadConfig({ ...env, CLAUDE_MODEL: 'different-model-latest' }).CLAUDE_MODEL,
  ).toBe('claude-sonnet-4-6')
})
it('restores checkpoint order and settles preparing/running tools after restart', () => {
  const { store, owner, c, p } = setup(),
    run = store.accept(c.id, owner, p, config).run
  const activity = [
    {
      type: 'text' as const,
      id: 't0',
      round: 0,
      phase: 'explanation' as const,
      text: 'Checking.',
    },
    {
      type: 'tool' as const,
      id: 'a',
      name: 'get_market_overview' as const,
      status: 'preparing' as const,
    },
    {
      type: 'tool' as const,
      id: 'b',
      name: 'get_account_overview' as const,
      status: 'running' as const,
    },
  ]
  for (const item of activity.filter((a) => a.type === 'tool'))
    store.sql
      .prepare(
        'INSERT INTO tool_calls(id,runId,name,arguments,version,status,assistantContent,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        item.id,
        run.id,
        item.name,
        '{}',
        'tools-v1',
        item.status,
        '[]',
        1,
        1,
      )
  store.checkpoint(
    run.id,
    { ...emptyResult(), text: 'Checking.', textStatus: 'partial', activity },
    { input: 10, output: 10, unconfirmed: 2000 },
  )
  store.recover()
  store.recover()
  const saved = store.run(run.id, owner)
  expect(saved.status).toBe('interrupted')
  expect(JSON.parse(saved.result!).activity).toEqual([
    activity[0],
    { ...activity[1], status: 'failed' },
    { ...activity[2], status: 'failed' },
  ])
  expect(
    store.sql.prepare('SELECT status FROM tool_calls ORDER BY id').all(),
  ).toEqual([{ status: 'failed' }, { status: 'failed' }])
  expect(store.history(c.id).messages.map((m) => m.text)).toEqual([
    'BTC price?',
    'Checking.',
  ])
})

it('resolves message addresses atomically and preserves the fixed run on replay', () => {
  const { store, owner, c, p } = setup()
  const payload = { ...p, text: `查看 ${otherAddress} 的仓位` }
  const first = store.accept(c.id, owner, payload, config).run
  expect(first).toMatchObject({
    observedAddress: otherAddress,
    addressVersion: 2,
  })
  expect(store.owner(c.id, owner)).toMatchObject({
    observedAddress: otherAddress,
    addressVersion: 2,
  })
  expect(store.history(c.id).messages[0]).toMatchObject({
    observedAddress: otherAddress,
    addressVersion: 2,
  })
  expect(store.accept(c.id, owner, payload, config)).toMatchObject({
    duplicate: true,
    run: { id: first.id, addressVersion: 2 },
  })
  store.finish(
    first,
    'completed',
    emptyResult(),
    { input: 0, output: 0, unconfirmed: 0 },
    null,
  )
  const followup = store.accept(
    c.id,
    owner,
    {
      ...p,
      clientRequestId: randomUUID(),
      text: '最近的成交呢？',
      expectedAddressVersion: 2,
    },
    config,
  ).run
  expect(followup.observedAddress).toBe(otherAddress)
  expect(followup.addressVersion).toBe(2)
})

it('does not change the address when a new request is rejected', () => {
  const { store, owner, c, p } = setup()
  expect(() =>
    store.accept(
      c.id,
      owner,
      { ...p, text: `Analyze ${otherAddress}` },
      { ...config, USER_DAILY_REQUEST_LIMIT: 0 },
    ),
  ).toThrow('allowance')
  expect(store.owner(c.id, owner)).toMatchObject({
    observedAddress: address,
    addressVersion: 1,
  })
})
