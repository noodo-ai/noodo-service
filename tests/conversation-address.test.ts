import { expect, it } from 'vitest'
import { resolveMessageAddress } from '../src/conversation-address.js'
import { address, otherAddress } from './fixtures/hyperliquid.js'

it('extracts full addresses from natural language and explorer links', () => {
  expect(resolveMessageAddress(`查看${address}的仓位`, null)).toBe(address)
  expect(
    resolveMessageAddress(
      `Analyze https://app.hyperliquid.xyz/explorer/address/${address}?tab=fills`,
      null,
    ),
  ).toBe(address)
  expect(
    resolveMessageAddress(
      `Check ${address.toUpperCase()} and ${address}`,
      null,
    ),
  ).toBe(address)
  expect(resolveMessageAddress('最近成交呢？', address)).toBe(address)
  expect(resolveMessageAddress('BTC price?', null)).toBeNull()
})
it.each([
  `${address} ${otherAddress}`,
  '0x1234',
  `${address}f`,
  `${address}ZZ`,
  `${address} 0xinvalid`,
])(
  'requires clarification instead of reusing a prior account for %s',
  (text) => {
    expect(resolveMessageAddress(text, address)).toBeNull()
  },
)
