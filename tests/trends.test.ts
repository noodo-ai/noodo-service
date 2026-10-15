import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/db/store.js'
import { InfoClient } from '../src/hyperliquid/client.js'
import { TrendsCollector } from '../src/trends/collector.js'
import {
  change,
  hourBaseline,
  marketEvents,
  mergeEvents,
  selectTraders,
  walletEvents,
} from '../src/trends/rules.js'
import {
  emptyState,
  type MarketSnapshot,
  type WalletSnapshot,
} from '../src/trends/contracts.js'
import { createServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { tokenHash } from '../src/http/auth.js'
const now = Date.now()
const address = `0x${'a'.repeat(40)}`
const snapshot = (
  at: number,
  oi = '100',
  funding = '0.0001',
): MarketSnapshot => ({
  at,
  sourceId: `source-${at}`,
  markets: [
    {
      coin: 'BTC',
      markPx: '60000',
      funding,
      openInterest: oi,
      volume: '2000000',
    },
  ],
})
const wallet = (at: number, size: string | null): WalletSnapshot => ({
  address,
  at,
  sourceId: `wallet-${at}`,
  positions: [{ coin: 'BTC', size }],
})
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function store(): Store {
  const db = new Store(':memory:')
  stores.push(db)
  return db
}
it.each([
  { name: 'empty history', history: [] },
  { name: 'warm-up', history: [snapshot(now)] },
  {
    name: 'hourly comparison',
    history: [snapshot(now - 3_600_000), snapshot(now, '105')],
  },
])(
  'returns market provenance without requiring signals: $name',
  async ({ history }) => {
    const db = store()
    db.sql
      .prepare('INSERT INTO trends_state VALUES(1,?)')
      .run(JSON.stringify({ ...emptyState(), history }))
    const collector = new TrendsCollector(db, new InfoClient())
    const data = collector.read(now)
    const latest = history.at(-1)
    expect(data.marketSource).toEqual(
      latest ? { sourceId: latest.sourceId, at: latest.at } : null,
    )
    expect(data.interestBaseline).toEqual(
      history.length === 2
        ? { sourceId: history[0]!.sourceId, at: history[0]!.at }
        : null,
    )
    expect(data.events).toEqual([])
    if (history.length === 2)
      expect(data.highlights.interest[0]?.oiChange1h).toBe('5')
    expect(collector.read(now + 20 * 60_000).marketSource).toEqual(
      data.marketSource,
    )
    await collector.stop()
  },
)
describe('deterministic trends', () => {
  it('keeps exact large decimals, unknown baselines and zero denominators', () => {
    expect(
      change(
        '100000000000000000000000000001',
        '100000000000000000000000000000',
      ),
    ).toBe('0.000000000000000000000000001')
    expect(change(null, '100')).toBeNull()
    expect(change('100', '0')).toBeNull()
    expect(hourBaseline([snapshot(now - 70 * 60_000)], now)).toBeUndefined()
  })
  it('requires a real hourly baseline and detects funding crossings only across a short observation gap', () => {
    const current = snapshot(now, '110', '-0.0001')
    expect(marketEvents(current, [])).toEqual([])
    const events = marketEvents(current, [
      snapshot(now - 3_600_000),
      snapshot(now - 300_000),
    ])
    expect(events.map((row) => row.rule)).toEqual([
      'oi-1h-up-10pct',
      'funding-negative',
    ])
    expect(events[0].sourceIds).toEqual([
      `source-${now - 3_600_000}`,
      `source-${now}`,
    ])
    expect(marketEvents(current, [snapshot(now - 30 * 60_000)])).toEqual([])
    expect(mergeEvents(events, events, now)).toHaveLength(2)
    expect(
      mergeEvents(
        events,
        marketEvents(snapshot(now + 300_000, '112'), [
          snapshot(now - 3_600_000),
        ]),
        now + 300_000,
      ),
    ).toHaveLength(2)
  })
  it('sorts the reported weekly PnL rather than ROI, deduplicates addresses, and preserves unknown values', () => {
    const row = (addr: string, pnl: string, roi: string | null) => ({
      ethAddress: addr,
      windowPerformances: [['week', { pnl, roi }]],
    })
    const result = selectTraders(
      {
        leaderboardRows: [
          row(address, '9007199254740993', null),
          row(`0x${'b'.repeat(40)}`, '9007199254740992', '100'),
          row(
            address.toUpperCase().replace('0X', '0x'),
            '9007199254740993',
            '1',
          ),
        ],
      },
      [],
    )
    expect(result).toHaveLength(2)
    expect(result[0].address).toBe(address)
    expect(result[0].roi).toBeNull()
    expect(() => selectTraders({ unexpected: [] }, [])).toThrow()
  })
  it('labels net position changes, including closures, without treating unknown or stale positions as trades', () => {
    const previous = wallet(now - 900_000, '100')
    expect(
      walletEvents(wallet(now, '120'), previous, snapshot(now)),
    ).toHaveLength(1)
    expect(walletEvents(wallet(now, null), previous, snapshot(now))).toEqual([])
    expect(
      walletEvents(
        wallet(now, '120'),
        wallet(now - 3_600_000, '100'),
        snapshot(now),
      ),
    ).toEqual([])
    const closed = walletEvents(
      { ...wallet(now, '0'), positions: [] },
      previous,
      snapshot(now),
    )
    expect(closed[0].summary).toContain('from 100 to 0 BTC')
    expect(closed[0].summary).toContain('not an individual trade')
  })
})
it('persists snapshots and reports partial failures and stale data without inventing signals', async () => {
  const db = store()
  const state = { ...emptyState(), history: [snapshot(now - 3_600_000)] }
  db.sql
    .prepare('INSERT INTO trends_state VALUES(1,?)')
    .run(JSON.stringify(state))
  const marketFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        { universe: [{ name: 'BTC', szDecimals: 5 }] },
        [
          {
            markPx: '60000',
            funding: '0.0001',
            openInterest: '120',
            dayNtlVlm: '3000000',
          },
        ],
      ]),
    )
  const collector = new TrendsCollector(
    db,
    new InfoClient(900, marketFetch),
    async () => new Response('{}'),
  )
  await collector.refresh()
  expect(collector.read().highlights.interest[0].oiChange1h).toBe('20')
  expect(collector.read().events).toHaveLength(1)
  expect(collector.read().leaderboardError).toBe(true)
  const restored = new TrendsCollector(db, new InfoClient(), marketFetch)
  expect(restored.read().events).toEqual(collector.read().events)
  expect(restored.read().marketSource).toEqual(collector.read().marketSource)
  expect(restored.read().interestBaseline).toEqual({
    sourceId: state.history[0]!.sourceId,
    at: state.history[0]!.at,
  })
  expect(restored.read(now + 20 * 60_000).stale).toBe(true)
  await collector.stop()
  await restored.stop()
})
it('requires authentication and reads stored trends without triggering collection', async () => {
  const db = store()
  db.sql
    .prepare('INSERT INTO users VALUES(?,?,?,?)')
    .run('alice', 'alice', 'unused', now)
  db.sql
    .prepare('INSERT INTO sessions VALUES(?,?,?)')
    .run(tokenHash('alice'), 'alice', now + 60_000)
  const app = await createServer(
    loadConfig({
      ANTHROPIC_API_KEY: 'test',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      NODE_ENV: 'development',
      COOKIE_SECURE: 'false',
    }),
    { store: db, logger: false },
  )
  try {
    expect((await app.inject({ url: '/v1/trends' })).statusCode).toBe(401)
    const result = await app.inject({
      url: '/v1/trends',
      headers: { cookie: 'noodo_session=alice' },
    })
    expect(result.statusCode).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.json().generatedAt).toBeNull()
    expect(result.json().marketSource).toBeNull()
    expect(result.json().interestBaseline).toBeNull()
    expect(result.json().events).toEqual([])
  } finally {
    await app.close()
  }
})
it('does not run overlapping collection and cancels active upstream requests on shutdown', async () => {
  const db = store()
  let signal: AbortSignal | null = null
  const hanging: typeof fetch = async (_url, init) => {
    signal = init?.signal ?? null
    return new Promise((_resolve, reject) =>
      signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      }),
    )
  }
  const collector = new TrendsCollector(
    db,
    new InfoClient(900, hanging),
    hanging,
  )
  const first = collector.refresh()
  expect(collector.refresh()).toBe(first)
  // The limiter and shared query dispatch cross several microtask boundaries.
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await collector.stop()
  expect((signal as AbortSignal | null)?.aborted).toBe(true)
  expect(collector.read().generatedAt).toBeNull()
})
