import {
  ServiceError,
  toolSchemas,
  type ToolName,
  type ToolOutput,
} from '../contracts.js'
import type { InfoClient } from './client.js'
import type { ToolContext } from './tool-context.js'
import { getMarket } from './market.js'
import { getAccount } from './account.js'
import { getFills } from './fills.js'
export type { ToolContext } from './tool-context.js'

export class BusinessTools {
  constructor(
    private client: InfoClient,
    private supportedModes: string[] = [],
  ) {}
  async execute(
    name: ToolName,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    const schema = toolSchemas[name]
    if (!schema)
      throw new ServiceError(
        'toolForbidden',
        'Only the three read-only tools are available',
      )
    const parsed = schema.safeParse(input)
    if (!parsed.success)
      throw new ServiceError('invalidToolInput', 'Invalid tool arguments')
    if (name === 'get_market_overview')
      return getMarket(
        this.client,
        toolSchemas.get_market_overview.parse(input),
        ctx,
      )
    const args = parsed.data
    if (!ctx.address)
      throw new ServiceError(
        'accountRequired',
        'Include one full public Hyperliquid user or subaccount address in your message',
      )
    if ('address' in args && args.address && args.address !== ctx.address)
      throw new ServiceError(
        'addressMismatch',
        'Tool address must match this run’s resolved account',
      )
    if (name === 'get_account_overview')
      return getAccount(this.client, this.supportedModes, ctx)
    return getFills(this.client, toolSchemas.get_recent_fills.parse(input), ctx)
  }
}
