import type { Store } from './store.js'
import {
  emptyState,
  stateSchema,
  type TrendsState,
} from '../trends/contracts.js'

export function loadTrendsState(store: Store): TrendsState {
  const saved = store.sql
    .prepare('SELECT payload FROM trends_state WHERE id=1')
    .get() as { payload: string } | undefined
  return saved ? stateSchema.parse(JSON.parse(saved.payload)) : emptyState()
}
export function saveTrendsState(store: Store, state: TrendsState): void {
  store.sql
    .prepare(
      'INSERT INTO trends_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
    )
    .run(JSON.stringify(state))
}
