// Synthetic contract fixtures shaped from the official Info API documentation.
// They validate arithmetic/behavior, not live account-mode semantics.
export const address = '0x' + 'a'.repeat(40)
export const otherAddress = '0x' + 'b'.repeat(40)
export const market = [
  {
    universe: [
      { name: 'BTC', szDecimals: 5 },
      { name: 'ETH', szDecimals: 4 },
    ],
  },
  [
    {
      markPx: '100',
      funding: '0.0000125',
      openInterest: '12',
      dayNtlVlm: '10000',
    },
    { markPx: '50', funding: '-0.00001', openInterest: '3', dayNtlVlm: '2000' },
  ],
]
export const position = (
  coin = 'BTC',
  szi = '1',
  liquidationPx: string | null = '80',
  value = '100',
) => ({
  position: {
    coin,
    szi,
    liquidationPx,
    positionValue: value,
    unrealizedPnl: '10',
    marginUsed: '20',
    leverage: { type: 'cross', value: 5 },
  },
})
export const account = () => ({
  marginSummary: { accountValue: '1000', totalMarginUsed: '200' },
  withdrawable: '800',
  time: Date.now(),
  assetPositions: [position(), position('ETH', '-2', '60')],
})
export const order = {
  coin: 'BTC',
  oid: '9007199254740993',
  side: 'A',
  reduceOnly: true,
  isTrigger: true,
  triggerCondition: 'Price below 90',
  orderType: 'Stop Market',
  triggerPx: '90',
  sz: '1',
}
export const fill = (time = Date.now(), coin = 'BTC', tid = '1') => ({
  coin,
  tid,
  time,
  px: '100',
  sz: '1',
  dir: 'Open Long',
  side: 'B',
  closedPnl: '0',
  fee: '0.01',
  feeToken: 'USDC',
})
