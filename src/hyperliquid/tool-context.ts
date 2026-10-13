import { SCOPE, type ToolOutput } from '../contracts.js'
import type { InfoClient } from './client.js'
import { roleSchema } from './schemas.js'

export interface ToolContext {
  address: string | null
  signal: AbortSignal
  deadline: number
  toolCallId: string
}

export function createOutput(ctx: ToolContext): ToolOutput {
  return {
    data: {},
    sources: [],
    coverage: {
      marketScope: SCOPE,
      observedAddress: ctx.address,
      complete: true,
      reasonCodes: [],
    },
    warnings: [
      'Default perpetuals only; excludes spot, HIP-3, vaults, HyperEVM and automatic subaccount aggregation.',
    ],
  }
}
export async function checkAccountRole(
  client: InfoClient,
  ctx: ToolContext,
  out: ToolOutput,
): Promise<boolean> {
  const role = await client.query(
    'userRole',
    { user: ctx.address },
    roleSchema,
    ctx,
  )
  out.sources.push(role.source)
  out.data.role = role.data.role
  if (!['user', 'subAccount'].includes(role.data.role)) {
    out.coverage.complete = false
    out.coverage.reasonCodes.push(
      role.data.role === 'missing'
        ? 'accountNotFound'
        : 'unsupportedAccountRole',
    )
    out.warnings.push(
      role.data.role === 'missing'
        ? 'No account was found; this does not imply zero assets.'
        : 'Agent and vault addresses are outside this MVP; select the user or specific subaccount explicitly.',
    )
    return false
  }
  return true
}
