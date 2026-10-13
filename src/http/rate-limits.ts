import { ServiceError } from '../contracts.js'

export class RateLimits {
  private counts = new Map<string, { n: number; until: number }>()
  take(key: string, max: number, ms = 60000) {
    const now = Date.now(),
      old = this.counts.get(key),
      value = old && old.until > now ? old : { n: 0, until: now + ms }
    if (value.n >= max)
      throw new ServiceError(
        'rateLimited',
        'Too many requests; try again later',
        429,
        true,
      )
    for (const [k, v] of this.counts) if (v.until < now) this.counts.delete(k)
    if (!this.counts.has(key) && this.counts.size >= 10000)
      throw new ServiceError(
        'rateLimited',
        'Service rate-limit capacity reached',
        429,
        true,
      )
    value.n++
    this.counts.set(key, value)
  }
}
