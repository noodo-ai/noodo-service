import { ServiceError, publicError, type ToolOutput } from '../contracts.js'
import type { InfoClient } from './client.js'
import { createOutput, type ToolContext } from './tool-context.js'
import { Decimal } from 'decimal.js'
import { marketSchema, candleSchema } from './schemas.js'

export async function getMarket(
  client: InfoClient,

  args: { coin: string; candleInterval?: string },
  ctx: ToolContext,
): Promise<ToolOutput> {
  const out = createOutput({ ...ctx, address: null })
  const response = await client.query('metaAndAssetCtxs', {}, marketSchema, ctx)
  out.sources.push(response.source)
  const index = response.data[0].universe.findIndex(
    (a) => a.name === args.coin && !a.isDelisted,
  )
  if (index < 0)
    throw new ServiceError(
      'unsupportedAsset',
      'Asset is not an active default perpetual market',
    )
  const asset = response.data[0].universe[index]!,
    prices = response.data[1][index]!
  out.data = {
    coin: asset.name,
    szDecimals: asset.szDecimals,
    ...prices,
    openInterestUsdEstimate:
      prices.openInterest !== null && prices.markPx !== null
        ? new Decimal(prices.openInterest).mul(prices.markPx).toString()
        : null,
    fundingPeriod: '1h',
    sourceIds: [response.source.sourceId],
  }
  if (Object.values(prices).some((v) => v === null)) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push('invalidMarketFields')
  }
  out.warnings.push(
    'markPx is mark price; funding is hourly, positive means longs pay shorts. Current funding does not guarantee the next settlement. Open interest is in underlying units; USD notional is an estimate.',
  )
  if (args.candleInterval) {
    const seconds: Record<string, number> = {
      '1m': 60,
      '3m': 180,
      '5m': 300,
      '15m': 900,
      '30m': 1800,
      '1h': 3600,
      '2h': 7200,
      '4h': 14400,
      '8h': 28800,
      '12h': 43200,
      '1d': 86400,
      '3d': 259200,
      '1w': 604800,
      '1M': 2678400,
    }
    const endTime = Date.now(),
      startTime =
        endTime - Math.min(86400000, seconds[args.candleInterval]! * 1000 * 199)
    try {
      const candles = await client.query(
        'candleSnapshot',
        {
          req: {
            coin: asset.name,
            interval: args.candleInterval,
            startTime,
            endTime,
          },
        },
        candleSchema,
        ctx,
      )
      out.sources.push(candles.source)
      out.data.candles = candles.data
        .filter((c) => c.s === asset.name && c.i === args.candleInterval)
        .slice(-200)
      out.data.candleSourceIds = [candles.source.sourceId]
    } catch (e) {
      out.coverage.complete = false
      out.coverage.reasonCodes.push('candlesUnavailable')
      out.warnings.push(publicError(e).code)
    }
  }
  return out
}
