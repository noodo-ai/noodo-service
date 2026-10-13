import { addressSchema } from './contracts.js'

/** Resolve only an unambiguous full address; never fall back past an invalid one. */
export function resolveMessageAddress(
  text: string,
  previous: string | null,
): string | null {
  const candidates = text.match(/(?<![a-zA-Z0-9_])0x[a-zA-Z0-9_]*/gi) ?? []
  if (!candidates.length) return previous
  const addresses = new Set<string>()
  for (const candidate of candidates) {
    const parsed = addressSchema.safeParse(candidate.replace(/^0X/, '0x'))
    if (!parsed.success) return null
    addresses.add(parsed.data)
  }
  return addresses.size === 1 ? [...addresses][0]! : null
}
