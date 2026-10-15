import { Decimal } from 'decimal.js'
import { createHash } from 'node:crypto'
import {
  LEADERBOARD_URL,
  type MarketSnapshot,
  type Trader,
  type TrendEvent,
  type WalletSnapshot,
} from './contracts.js'
import { leaderboardSchema } from './contracts.js'

const percent = (value: Decimal): string =>
  `${value.isPositive() ? '+' : ''}${value.toFixed(2)}%`
const usd = (value: Decimal): string => `$${value.abs().toFixed(0)}`
export function change(
  current: string | null,
  previous: string | null,
): string | null {
  if (
    current === null ||
    previous === null ||
    new Decimal(current).lt(0) ||
    new Decimal(previous).lte(0)
  )
    return null
  return new Decimal(current).minus(previous).div(previous).mul(100).toFixed()
}
export function event(input: Omit<TrendEvent, 'id'>): TrendEvent {
  return {
    ...input,
    id: createHash('sha256')
      .update(JSON.stringify([input.rule, input.coin, input.title, input.at]))
      .digest('hex')
      .slice(0, 24),
  }
}
export function selectTraders(raw: unknown, previous: Trader[]): Trader[] {
  const rows = leaderboardSchema.parse(raw).leaderboardRows
  const seen = new Set<string>()
  return rows
    .flatMap((row) => {
      const address = row.ethAddress.toLowerCase()
      const week = row.windowPerformances.find(
        ([window]) => window === 'week',
      )?.[1]
      if (!week?.pnl || seen.has(address)) return []
      seen.add(address)
      return [
        {
          address,
          pnl: week.pnl,
          roi: week.roi ?? null,
          volume: week.vlm ?? null,
        },
      ]
    })
    .sort(
      (a, b) =>
        new Decimal(b.pnl).cmp(a.pnl) || a.address.localeCompare(b.address),
    )
    .slice(0, 5)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      previousRank:
        previous.find((old) => old.address === row.address)?.rank ?? null,
    }))
}
export function hourBaseline(
  history: MarketSnapshot[],
  now: number,
): MarketSnapshot | undefined {
  return history
    .filter(
      (point) => now - point.at >= 55 * 60_000 && now - point.at <= 65 * 60_000,
    )
    .sort(
      (a, b) =>
        Math.abs(now - a.at - 3_600_000) - Math.abs(now - b.at - 3_600_000),
    )[0]
}
export function marketEvents(
  current: MarketSnapshot,
  history: MarketSnapshot[],
): TrendEvent[] {
  const baseline = hourBaseline(history, current.at)
  const last = history.at(-1)
  const events: TrendEvent[] = []
  for (const market of current.markets) {
    const previous = baseline?.markets.find((row) => row.coin === market.coin)
    const oiChange = previous
      ? change(market.openInterest, previous.openInterest)
      : null
    if (previous && oiChange !== null && new Decimal(oiChange).abs().gte(10)) {
      const delta = new Decimal(oiChange)
      events.push(
        event({
          kind: 'markets',
          coin: market.coin,
          title: `${market.coin} open interest ${delta.isPositive() ? 'rises' : 'falls'} ${delta.abs().toFixed(2)}%`,
          summary: `Underlying open interest changed ${percent(delta)} between snapshots ${Math.round((current.at - baseline!.at) / 60_000)} minutes apart. This does not identify trade direction.`,
          at: current.at,
          sourceIds: [baseline!.sourceId, current.sourceId],
          sourceUrl: 'https://app.hyperliquid.xyz/trade',
          rule: `oi-1h-${delta.isPositive() ? 'up' : 'down'}-10pct`,
        }),
      )
    }
    const oldFunding = last?.markets.find(
      (row) => row.coin === market.coin,
    )?.funding
    if (
      last &&
      current.at - last.at <= 10 * 60_000 &&
      market.funding !== null &&
      oldFunding != null
    ) {
      const rate = new Decimal(market.funding)
      if (rate.mul(oldFunding).lt(0))
        events.push(
          event({
            kind: 'markets',
            coin: market.coin,
            title: `${market.coin} funding turns ${rate.isPositive() ? 'positive' : 'negative'}`,
            summary: `Current hourly funding is ${rate.mul(100).toFixed(4)}%. ${rate.isPositive() ? 'Longs pay shorts' : 'Shorts pay longs'} at this rate; the next settlement may differ.`,
            at: current.at,
            sourceIds: [last.sourceId, current.sourceId],
            sourceUrl: 'https://app.hyperliquid.xyz/trade',
            rule: `funding-${rate.isPositive() ? 'positive' : 'negative'}`,
          }),
        )
    }
  }
  return events
}
export function walletEvents(
  current: WalletSnapshot,
  previous: WalletSnapshot | undefined,
  market: MarketSnapshot,
): TrendEvent[] {
  if (
    !previous ||
    current.at - previous.at > 20 * 60_000 ||
    Math.abs(current.at - market.at) > 10 * 60_000
  )
    return []
  const coins = new Set(
    [...current.positions, ...previous.positions].map((row) => row.coin),
  )
  return [...coins].flatMap((coin) => {
    const price = market.markets.find((row) => row.coin === coin)?.markPx
    const size = current.positions.find((row) => row.coin === coin)?.size
    const oldSize = previous.positions.find((row) => row.coin === coin)?.size
    if (
      !price ||
      new Decimal(price).lte(0) ||
      size === null ||
      oldSize === null
    )
      return []
    const delta = new Decimal(size ?? '0').minus(oldSize ?? '0')
    const value = delta.abs().mul(price)
    if (value.lt(1_000_000)) return []
    const short = `${current.address.slice(0, 6)}…${current.address.slice(-4)}`
    return [
      event({
        kind: 'traders',
        coin,
        title: `${short} changes ${coin} net position`,
        summary: `Signed position moved from ${oldSize ?? '0'} to ${size ?? '0'} ${coin} over ${Math.round((current.at - previous.at) / 60_000)} minutes (about ${usd(value)} at the latest mark). Snapshot comparison, not an individual trade; tracked leaderboard sample only.`,
        at: current.at,
        sourceIds: [previous.sourceId, current.sourceId, market.sourceId],
        sourceUrl: `https://app.hyperliquid.xyz/explorer/address/${current.address}`,
        rule: `wallet-${current.address}-1m-usd`,
      }),
    ]
  })
}
export function mergeEvents(
  previous: TrendEvent[],
  incoming: TrendEvent[],
  now: number,
): TrendEvent[] {
  const accepted = [...previous].filter((row) => now - row.at < 7 * 86_400_000)
  for (const row of incoming) {
    if (
      !accepted.some(
        (old) =>
          old.rule === row.rule &&
          old.coin === row.coin &&
          row.at - old.at < 3_600_000,
      )
    )
      accepted.push(row)
  }
  return accepted
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 100)
}
export function leaderboardEvents(traders: Trader[], at: number): TrendEvent[] {
  return traders
    .filter((row) => row.previousRank !== null && row.previousRank !== row.rank)
    .map((row) =>
      event({
        kind: 'traders',
        coin: null,
        title: `${row.address.slice(0, 6)}…${row.address.slice(-4)} moves to #${row.rank}`,
        summary: `Previously #${row.previousRank} in the last stored top five. Ranked by reported 7-day PnL, not risk-adjusted performance.`,
        at,
        sourceIds: [`leaderboard:${at}`],
        sourceUrl: LEADERBOARD_URL,
        rule: `rank-${row.address}-${row.rank}`,
      }),
    )
}
