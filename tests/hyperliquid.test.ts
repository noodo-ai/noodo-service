import { describe, expect, it, vi } from 'vitest'
import { InfoClient, INFO_URL } from '../src/hyperliquid/client.js'
import { BusinessTools } from '../src/hyperliquid/tools.js'
import { calculateRisk } from '../src/hyperliquid/risk.js'
import {
  accountSchema,
  marketSchema,
  ordersSchema,
  roleSchema,
} from '../src/hyperliquid/schemas.js'
import {
  account,
  address,
  otherAddress,
  market,
  position,
  order,
  fill,
} from './fixtures/hyperliquid.js'
const ctx = () => ({
  address,
  signal: new AbortController().signal,
  deadline: Date.now() + 50000,
  toolCallId: 'tool-1',
})
function fake(
  responses: Record<string, unknown>,
  handler?: (type: string, body: Record<string, unknown>) => unknown,
) {
  const fetcher = vi.fn(async (url, init) => {
    expect(url).toBe(INFO_URL)
    const body = JSON.parse(String(init?.body))
    const type = body.type as string
    if (
      ['clearinghouseState', 'metaAndAssetCtxs', 'frontendOpenOrders'].includes(
        type,
      )
    )
      expect(body.dex).toBe('')
    const value = handler ? handler(type, body) : responses[type]
    if (value instanceof Error) throw value
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>
  return { client: new InfoClient(900, fetcher), fetcher }
}
const base = () => ({
  userRole: { role: 'user' },
  userAbstraction: 'disabled',
  clearinghouseState: account(),
  frontendOpenOrders: [order],
  metaAndAssetCtxs: market,
  userFills: [],
  userFillsByTime: [],
})
describe('deterministic risk', () => {
  it('calculates long/short distances, concentrations and same-summary margin usage', () => {
    const result = calculateRisk(
      accountSchema.parse(account()),
      marketSchema.parse(market),
      ordersSchema.parse([order]),
      true,
      true,
      ['s'],
    )
    expect(result.marginUsage.value).toBe('0.2')
    expect(result.positions.map((p) => p.liquidationDistance.value)).toEqual([
      '0.2',
      '0.2',
    ])
    expect(result.positions[0]?.concentration.value).toBe('0.5')
    expect(result.positions[0]?.stopStatus).toBe('matched')
  })
  it('preserves null and negative liquidation distances; does not convert unknown to zero', () => {
    const raw = account()
    raw.assetPositions = [
      position('BTC', '1', null),
      position('ETH', '-1', '40'),
    ]
    const r = calculateRisk(
      accountSchema.parse(raw),
      marketSchema.parse(market),
      null,
      true,
      true,
      [],
    )
    expect(r.positions[0]?.liquidationDistance.value).toBeNull()
    expect(r.positions[1]?.liquidationDistance.value).toBe('-0.2')
    expect(r.attention[0]?.coin).toBe('BTC')
    expect(r.positions[1]?.reasonCodes).toContain(
      'verifyLiquidationDistanceImmediately',
    )
    expect(r.positions[0]?.stopStatus).toBe('unknown')
  })
  it('handles empty positions, nonpositive equity and invalid decimals', () => {
    const raw = {
      ...account(),
      marginSummary: { accountValue: '-1', totalMarginUsed: '1' },
      assetPositions: [],
    }
    expect(
      calculateRisk(accountSchema.parse(raw), null, [], true, true, [])
        .marginUsage.reason,
    ).toBe('nonPositiveEquity')
    expect(
      accountSchema.parse({ ...account(), withdrawable: 'NaN' }).withdrawable,
    ).toBeNull()
    const r = calculateRisk(
      accountSchema.parse(account()),
      marketSchema.parse(market),
      [],
      false,
      true,
      [],
    )
    expect(r.marginUsage.value).toBeNull()
    expect(r.positions[0]?.concentration.value).toBeNull()
  })
  it('does not treat reduce-only limit or a wrong-direction trigger as a stop', () => {
    const orders = [
      { ...order, isTrigger: false, orderType: 'Limit' },
      { ...order, side: 'B' },
      { ...order, orderType: 'Take Profit Market' },
    ]
    const r = calculateRisk(
      accountSchema.parse(account()),
      marketSchema.parse(market),
      ordersSchema.parse(orders),
      true,
      true,
      [],
    )
    expect(r.positions[0]?.stopStatus).toBe('notFoundInThisQuery')
  })
})
describe('read-only adapter', () => {
  it('obtains all position prices once and filters spot/other-dex orders', async () => {
    const data = base()
    data.frontendOpenOrders = [order, { ...order, coin: '@1' }]
    const { client, fetcher } = fake(data)
    const result = await new BusinessTools(client, ['disabled']).execute(
      'get_account_overview',
      {},
      ctx(),
    )
    expect(
      fetcher.mock.calls.filter(
        ([, i]) => JSON.parse(String(i?.body)).type === 'metaAndAssetCtxs',
      ),
    ).toHaveLength(1)
    expect(
      (result.data.positions as { relatedOrders: unknown[] }[])[0]
        ?.relatedOrders,
    ).toHaveLength(1)
    expect(result.sources.every((s) => s.toolCallId === 'tool-1')).toBe(true)
  })
  it.each(['agent', 'vault', 'missing'])(
    'stops unsupported role %s without querying another address',
    async (role) => {
      const data = base()
      data.userRole = { role }
      const { client, fetcher } = fake(data)
      const out = await new BusinessTools(client).execute(
        'get_account_overview',
        {},
        ctx(),
      )
      expect(out.coverage.complete).toBe(false)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(out.data.summary).toBeUndefined()
    },
  )
  it.each([
    'default',
    'dexAbstraction',
    'unifiedAccount',
    'portfolioMargin',
    'newMode',
  ])('hides balances and derived risk for mode %s', async (mode) => {
    const data = base()
    data.userAbstraction = mode
    const { client } = fake(data)
    const out = await new BusinessTools(client, ['disabled']).execute(
      'get_account_overview',
      {},
      ctx(),
    )
    expect(out.data.summary).toBeNull()
    expect(out.coverage.reasonCodes).toContain('unsupportedAccountMode')
    expect(
      (out.data.positions as { liquidationDistance: { value: unknown } }[])[0]
        ?.liquidationDistance.value,
    ).toBeNull()
  })
  it('degrades mode/orders/price errors while preserving account positions', async () => {
    const responses = base()
    const { client } = fake(responses, (t) =>
      ['userAbstraction', 'frontendOpenOrders', 'metaAndAssetCtxs'].includes(t)
        ? null
        : responses[t as keyof typeof responses],
    )
    const out = await new BusinessTools(client, ['disabled']).execute(
      'get_account_overview',
      {},
      ctx(),
    )
    expect(out.data.positions).toHaveLength(2)
    expect(out.data.summary).toBeNull()
    expect(out.coverage.reasonCodes).toEqual(
      expect.arrayContaining([
        'accountModeUnavailable',
        'ordersUnavailable',
        'pricesUnavailable',
      ]),
    )
  })
  it('stops on failed role recognition and rejects implicit address switches', async () => {
    const { client, fetcher } = fake({ userRole: { role: 'unknown' } })
    await expect(
      new BusinessTools(client).execute('get_account_overview', {}, ctx()),
    ).rejects.toThrow('schema')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(
      new BusinessTools(client).execute(
        'get_account_overview',
        { address: otherAddress },
        ctx(),
      ),
    ).rejects.toThrow('resolved account')
  })
  it('refreshes stale account/price snapshots once, then disables cross-snapshot risk', async () => {
    const data = base()
    data.clearinghouseState.time = Date.now() - 20000
    const { client, fetcher } = fake(data)
    const out = await new BusinessTools(client, ['disabled']).execute(
      'get_account_overview',
      {},
      ctx(),
    )
    expect(out.coverage.reasonCodes).toContain('snapshotSkew')
    expect(
      (out.data.positions as { liquidationDistance: { reason: string } }[])[0]
        ?.liquidationDistance.reason,
    ).toBe('snapshotSkew')
    expect(
      fetcher.mock.calls.filter(
        ([, i]) => JSON.parse(String(i?.body)).type === 'clearinghouseState',
      ),
    ).toHaveLength(2)
  })
  it('keeps original cache timestamps and cancels only the subscriber', async () => {
    const { client, fetcher } = fake({ userRole: { role: 'user' } })
    const a = await client.query(
      'userRole',
      { user: address },
      roleSchema,
      ctx(),
    )
    const b = await client.query(
      'userRole',
      { user: address },
      roleSchema,
      ctx(),
    )
    expect(b.source.fetchedAt).toBe(a.source.fetchedAt)
    expect(b.source.cacheHit).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    let resolveResponse!: (r: Response) => void
    const delayed = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolveResponse = r
        }),
    ) as typeof fetch
    const shared = new InfoClient(900, delayed),
      cancel = new AbortController(),
      p = shared.query('userRole', { user: address }, roleSchema, {
        ...ctx(),
        signal: cancel.signal,
      }),
      q = shared.query('userRole', { user: address }, roleSchema, ctx())
    await new Promise((r) => setTimeout(r, 0))
    cancel.abort()
    resolveResponse(new Response('{"role":"user"}'))
    await expect(p).rejects.toBeDefined()
    await expect(q).resolves.toMatchObject({ data: { role: 'user' } })
  })
  it('bounds candles, rejects unknown markets and preserves OI units', async () => {
    const { client } = fake(base())
    const tools = new BusinessTools(client),
      out = await tools.execute('get_market_overview', { coin: 'BTC' }, ctx())
    expect(out.data.openInterestUsdEstimate).toBe('1200')
    expect(out.data.openInterest).toBe('12')
    await expect(
      tools.execute('get_market_overview', { coin: 'BTCUSDT' }, ctx()),
    ).rejects.toThrow('not an active')
    await expect(
      tools.execute(
        'get_market_overview',
        { coin: 'BTC', candleInterval: 'bad' },
        ctx(),
      ),
    ).rejects.toThrow('arguments')
  })
  it('filters mixed markets and returns latest sample without claiming complete coverage', async () => {
    const data = base(),
      now = Date.now()
    data.userFills = [
      fill(now - 20, 'BTC', '1'),
      fill(now - 10, '@1', '2'),
      fill(now - 1, 'ETH', '3'),
    ] as never[]
    const { client } = fake(data)
    const out = await new BusinessTools(client).execute(
      'get_recent_fills',
      {},
      ctx(),
    )
    expect((out.data.fills as { tid: string }[]).map((f) => f.tid)).toEqual([
      '3',
      '1',
    ])
    expect(out.coverage.complete).toBe(false)
    expect(out.coverage.excludedCount).toBe(1)
  })
  it('advances pagination using the raw mixed-market timestamp, deduplicates ties and never skips a stalled boundary', async () => {
    const data = base(),
      end = Date.now(),
      start = end - 10000,
      queries: number[] = []
    const { client } = fake(data, (t, b) => {
      if (t !== 'userFillsByTime') return data[t as keyof typeof data]
      queries.push(Number(b.startTime))
      return [fill(start + 1, 'BTC', '1'), fill(start + 2, '@1', '2')]
    })
    const out = await new BusinessTools(client).execute(
      'get_recent_fills',
      { startTime: start, endTime: end },
      ctx(),
    )
    expect(queries).toEqual([start, start + 2])
    expect(out.coverage.truncationReasons).toContain('boundaryStalled')
    expect(out.coverage.reasonCodes).toContain('retentionUnverified')
    expect(out.data.fills).toHaveLength(1)
  })
  it('truncates recent and historical output in their respective sort directions', async () => {
    const data = base(),
      end = Date.now(),
      start = end - 10000,
      rows = Array.from({ length: 1100 }, (_, i) =>
        fill(start + i, 'BTC', String(i + 1)),
      )
    const { client } = fake(data, (t) =>
      t === 'userFills' || t === 'userFillsByTime'
        ? rows
        : data[t as keyof typeof data],
    )
    const tools = new BusinessTools(client)
    const recent = await tools.execute('get_recent_fills', {}, ctx()),
      history = await tools.execute(
        'get_recent_fills',
        { startTime: start, endTime: end },
        ctx(),
      )
    expect((recent.data.fills as { tid: string }[])[0]?.tid).toBe('1100')
    expect((history.data.fills as { tid: string }[])[0]?.tid).toBe('1')
    expect(history.coverage.truncationReasons).toContain('outputLimit')
    expect(recent.data.fills).toHaveLength(1000)
  })
})

it('does not infer absent stops when metadata/prices are unavailable even if orders succeeded', async () => {
  const data = base()
  const { client } = fake(data, (t) =>
    t === 'metaAndAssetCtxs' ? null : data[t as keyof typeof data],
  )
  const output = await new BusinessTools(client, ['disabled']).execute(
    'get_account_overview',
    {},
    ctx(),
  )
  expect(
    (output.data.positions as { stopStatus: string }[])[0]?.stopStatus,
  ).toBe('unknown')
})
it('preserves unsafe upstream integer IDs without rounding', async () => {
  const data = base()
  const fetcher: typeof fetch = async (_url, init) => {
    const type = JSON.parse(String(init?.body)).type
    if (type === 'userFills')
      return new Response(
        `[${JSON.stringify(fill(Date.now() - 1000)).replace('"tid":"1"', '"tid":900719925474099312345')}]`,
      )
    return new Response(JSON.stringify(data[type as keyof typeof data]))
  }
  const output = await new BusinessTools(new InfoClient(900, fetcher)).execute(
    'get_recent_fills',
    {},
    ctx(),
  )
  expect((output.data.fills as { tid: string }[])[0]?.tid).toBe(
    '900719925474099312345',
  )
})
