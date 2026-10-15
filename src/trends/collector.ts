import { loadTrendsState, saveTrendsState } from '../db/trends.js'
import { Decimal } from 'decimal.js'
import type { Store } from '../db/store.js'
import { InfoClient } from '../hyperliquid/client.js'
import {
  accountSchema,
  marketSchema,
  roleSchema,
} from '../hyperliquid/schemas.js'
import {
  MARKET_INTERVAL,
  WALLET_INTERVAL,
  LEADERBOARD_INTERVAL,
  LEADERBOARD_URL,
  SCOPE,
  type TrendsState,
  type TrendEvent,
} from './contracts.js'
import {
  hourBaseline,
  change,
  marketEvents,
  walletEvents,
  leaderboardEvents,
  mergeEvents,
  selectTraders,
} from './rules.js'

function nonnegative(value: string | null): string | null {
  return value !== null && new Decimal(value).gte(0) ? value : null
}

export class TrendsCollector {
  private state: TrendsState
  private controller = new AbortController()
  private running: Promise<void> | null = null
  private lastLeaderboardAttempt = 0
  private lastWalletAttempt = 0
  constructor(
    private store: Store,
    private client: InfoClient,
    private fetcher: typeof fetch = fetch,
  ) {
    this.state = loadTrendsState(store)
  }
  read(now = Date.now()) {
    const latest = this.state.history.at(-1)
    const baseline = latest && hourBaseline(this.state.history, latest.at)
    const stale = !latest || now - latest.at > MARKET_INTERVAL * 2
    const markets =
      latest?.markets.map((row) => ({
        ...row,
        oiChange1h: baseline
          ? change(
              row.openInterest,
              baseline.markets.find((old) => old.coin === row.coin)
                ?.openInterest ?? null,
            )
          : null,
      })) ?? []
    return {
      scope: SCOPE,
      generatedAt: latest?.at ?? null,
      marketSource: latest
        ? { sourceId: latest.sourceId, at: latest.at }
        : null,
      interestBaseline: baseline
        ? { sourceId: baseline.sourceId, at: baseline.at }
        : null,
      stale,
      marketError: this.state.marketError,
      leaderboardError: this.state.leaderboardError,
      walletError: this.state.walletError,
      leaderboardAt: this.state.leaderboardAt,
      walletsAt: this.state.walletsAt,
      leaderboardStale:
        this.state.leaderboardAt === null ||
        now - this.state.leaderboardAt > LEADERBOARD_INTERVAL * 2,
      walletsStale:
        this.state.walletsAt === null ||
        now - this.state.walletsAt > WALLET_INTERVAL * 2,
      highlights: {
        volume: markets
          .filter(
            (row) => row.volume !== null && new Decimal(row.volume).gte(0),
          )
          .sort((a, b) => new Decimal(b.volume!).cmp(a.volume!))
          .slice(0, 3),
        interest: markets
          .filter((row) => row.oiChange1h !== null)
          .sort((a, b) =>
            new Decimal(b.oiChange1h!)
              .abs()
              .cmp(new Decimal(a.oiChange1h!).abs()),
          )
          .slice(0, 3),
        funding: markets
          .filter((row) => row.funding !== null)
          .sort((a, b) =>
            new Decimal(b.funding!).abs().cmp(new Decimal(a.funding!).abs()),
          )
          .slice(0, 3),
      },
      traders: this.state.traders,
      events: this.state.events.filter((row) => now - row.at < 7 * 86_400_000),
    }
  }
  refresh(now = Date.now()): Promise<void> {
    if (this.running) return this.running
    this.running = this.collect(now).finally(() => {
      this.running = null
    })
    return this.running
  }
  async stop(): Promise<void> {
    this.controller.abort()
    await this.running
  }
  private async collect(now: number): Promise<void> {
    if (this.controller.signal.aborted) return
    const incoming: TrendEvent[] = []
    const options = () => ({
      signal: this.controller.signal,
      deadline: Date.now() + 17_000,
      toolCallId: 'trends',
      force: true,
    })
    if (
      !this.state.history.length ||
      now - this.state.history.at(-1)!.at >= MARKET_INTERVAL
    ) {
      try {
        const result = await this.client.query(
          'metaAndAssetCtxs',
          {},
          marketSchema,
          options(),
        )
        const current = {
          at: result.source.fetchedAt,
          sourceId: result.source.sourceId,
          markets: result.data[0].universe.flatMap((asset, i) => {
            const context = result.data[1][i]!
            return asset.isDelisted
              ? []
              : [
                  {
                    coin: asset.name,
                    markPx:
                      context.markPx !== null &&
                      new Decimal(context.markPx).gt(0)
                        ? context.markPx
                        : null,
                    funding: context.funding,
                    openInterest: nonnegative(context.openInterest),
                    volume: nonnegative(context.dayNtlVlm),
                  },
                ]
          }),
        }
        incoming.push(...marketEvents(current, this.state.history))
        this.state.history = [
          ...this.state.history.filter(
            (row) => current.at - row.at <= 70 * 60_000,
          ),
          current,
        ].slice(-16)
        this.state.marketError = false
      } catch {
        this.state.marketError = true
      }
    }
    if (this.controller.signal.aborted) return
    if (
      (this.state.leaderboardAt === null ||
        now - this.state.leaderboardAt >= LEADERBOARD_INTERVAL) &&
      now - this.lastLeaderboardAttempt >= MARKET_INTERVAL
    ) {
      this.lastLeaderboardAttempt = now
      try {
        const response = await this.fetcher(LEADERBOARD_URL, {
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(8000),
          ]),
          redirect: 'error',
        })
        if (!response.ok) throw new Error('Leaderboard unavailable')
        // The stats host has an independent, undocumented contract. Never fall back to invented rows.
        const traders = selectTraders(await response.json(), this.state.traders)
        const at = Date.now()
        incoming.push(...leaderboardEvents(traders, at))
        this.state.traders = traders
        this.state.leaderboardAt = at
        this.state.leaderboardError = false
      } catch {
        this.state.leaderboardError = true
      }
    }
    if (this.controller.signal.aborted) return
    const market = this.state.history.at(-1)
    if (
      market &&
      this.state.traders.length &&
      this.state.leaderboardAt !== null &&
      now - this.state.leaderboardAt <= LEADERBOARD_INTERVAL * 2 &&
      (this.state.walletsAt === null ||
        now - this.state.walletsAt >= WALLET_INTERVAL) &&
      now - this.lastWalletAttempt >= MARKET_INTERVAL
    ) {
      this.lastWalletAttempt = now
      let failed = false
      for (const trader of this.state.traders) {
        if (this.controller.signal.aborted) break
        try {
          const role = await this.client.query(
            'userRole',
            { user: trader.address },
            roleSchema,
            options(),
          )
          if (!['user', 'subAccount'].includes(role.data.role)) continue
          const result = await this.client.query(
            'clearinghouseState',
            { user: trader.address },
            accountSchema,
            options(),
          )
          const current = {
            address: trader.address,
            at: result.source.fetchedAt,
            sourceId: result.source.sourceId,
            positions: result.data.assetPositions.map((row) => ({
              coin: row.position.coin,
              size: row.position.szi,
            })),
          }
          incoming.push(
            ...walletEvents(
              current,
              this.state.wallets.find((row) => row.address === trader.address),
              market,
            ),
          )
          this.state.wallets = [
            ...this.state.wallets.filter(
              (row) => row.address !== trader.address,
            ),
            current,
          ]
        } catch {
          failed = true
        }
      }
      this.state.wallets = this.state.wallets.filter((row) =>
        this.state.traders.some((trader) => trader.address === row.address),
      )
      if (!failed) this.state.walletsAt = Date.now()
      this.state.walletError = failed
    }
    this.state.events = mergeEvents(this.state.events, incoming, now)
    if (!this.controller.signal.aborted) saveTrendsState(this.store, this.state)
  }
}
