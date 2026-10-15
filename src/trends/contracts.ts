import { z } from 'zod'
import { Decimal } from 'decimal.js'

export const MARKET_INTERVAL = 5 * 60_000
export const WALLET_INTERVAL = 15 * 60_000
export const LEADERBOARD_INTERVAL = 60 * 60_000
export const LEADERBOARD_URL =
  'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
export const SCOPE = 'Hyperliquid mainnet · default perpetuals'
const number = z
  .string()
  .max(120)
  .regex(/^-?\d+(\.\d+)?$/)
  .refine((value) => new Decimal(value).isFinite())
const timestamp = z.number().int().nonnegative()
export const marketPointSchema = z.object({
  coin: z.string(),
  markPx: number.nullable(),
  funding: number.nullable(),
  openInterest: number.nullable(),
  volume: number.nullable(),
})
export const snapshotSchema = z.object({
  at: timestamp,
  sourceId: z.string(),
  markets: z.array(marketPointSchema),
})
export const traderSchema = z.object({
  address: z.string().regex(/^0x[\da-f]{40}$/i),
  rank: z.number().int().positive(),
  previousRank: z.number().int().positive().nullable(),
  pnl: number,
  roi: number.nullable(),
  volume: number.nullable(),
})
export const eventSchema = z.object({
  id: z.string(),
  kind: z.enum(['markets', 'traders']),
  coin: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  at: timestamp,
  sourceIds: z.array(z.string()),
  sourceUrl: z.string().url(),
  rule: z.string(),
})
export const walletSchema = z.object({
  address: z.string(),
  at: timestamp,
  sourceId: z.string(),
  positions: z.array(z.object({ coin: z.string(), size: number.nullable() })),
})
export const stateSchema = z.object({
  history: z.array(snapshotSchema),
  traders: z.array(traderSchema),
  wallets: z.array(walletSchema),
  events: z.array(eventSchema),
  leaderboardAt: timestamp.nullable(),
  walletsAt: timestamp.nullable(),
  marketError: z.boolean(),
  leaderboardError: z.boolean(),
  walletError: z.boolean(),
})
export type MarketPoint = z.infer<typeof marketPointSchema>
export type MarketSnapshot = z.infer<typeof snapshotSchema>
export type Trader = z.infer<typeof traderSchema>
export type TrendEvent = z.infer<typeof eventSchema>
export type WalletSnapshot = z.infer<typeof walletSchema>
export type TrendsState = z.infer<typeof stateSchema>
export function emptyState(): TrendsState {
  return {
    history: [],
    traders: [],
    wallets: [],
    events: [],
    leaderboardAt: null,
    walletsAt: null,
    marketError: false,
    leaderboardError: false,
    walletError: false,
  }
}
export const leaderboardSchema = z.object({
  leaderboardRows: z.array(
    z.object({
      ethAddress: z.string().regex(/^0x[\da-f]{40}$/i),
      windowPerformances: z.array(
        z.tuple([
          z.string(),
          z.object({
            pnl: number.nullish(),
            roi: number.nullish(),
            vlm: number.nullish(),
          }),
        ]),
      ),
    }),
  ),
})
