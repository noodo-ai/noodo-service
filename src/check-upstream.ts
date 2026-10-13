import { BusinessTools } from './hyperliquid/tools.js'
import { InfoClient } from './hyperliquid/client.js'
import { publicError } from './contracts.js'
try {
  const result = await new BusinessTools(new InfoClient()).execute(
    'get_market_overview',
    { coin: 'BTC' },
    {
      address: null,
      signal: AbortSignal.timeout(20000),
      deadline: Date.now() + 20000,
      toolCallId: 'contract-smoke',
    },
  )
  console.log(
    JSON.stringify({
      verified: true,
      coin: result.data.coin,
      markPx: result.data.markPx,
      funding: result.data.funding,
      scope: result.coverage.marketScope,
      complete: result.coverage.complete,
      queryTime: result.sources[0]?.fetchedAt,
    }),
  )
} catch (e) {
  console.error(JSON.stringify(publicError(e).toJSON()))
  process.exitCode = 1
}
