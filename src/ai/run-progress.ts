import { randomUUID } from 'node:crypto'
import type { Store, Run } from '../db/store.js'
import { toolSchemas, type ToolName, type RunResult } from '../contracts.js'

export type Emit = (event: string, data: Record<string, unknown>) => void

export function createRunProgress(
  store: Store,
  run: Run,
  result: RunResult,
  combined: AbortSignal,
  emit: Emit,
  checkpoint: () => void,
) {
  let lastCheckpoint = Date.now(),
    lastLength = 0
  const appendText = (
    text: string,
    round: number,
    blockIndex: number,
    separator = false,
  ) => {
    combined.throwIfAborted()
    if (!text) return
    const id = `text:${round}:${blockIndex}`
    let item = result.activity!.find((a) => a.id === id)
    if (!item) {
      item = { type: 'text', id, round, phase: 'pending', text: '' }
      result.activity!.push(item)
    }
    if (item.type !== 'text') return
    if (!separator) item.text += text
    result.text += text
    result.textStatus = 'partial'
    if (
      Date.now() - lastCheckpoint >= 1000 ||
      result.text.length - lastLength >= 1000
    ) {
      checkpoint()
      lastCheckpoint = Date.now()
      lastLength = result.text.length
    }
    emit('message.delta', {
      text,
      round,
      blockId: id,
      ...(separator ? { separator: true } : {}),
    })
  }
  const textTimer = setInterval(() => {
    if (result.text.length !== lastLength) {
      checkpoint()
      lastLength = result.text.length
      lastCheckpoint = Date.now()
    }
  }, 1000)
  const prepared = new Map<string, string>()
  const prepareTool = (round: number, callId: string, name: string) => {
    combined.throwIfAborted()
    const key = `${round}:${callId}`
    const existing = prepared.get(key)
    if (existing) return existing
    const id = randomUUID(),
      now = Date.now()
    const safeName = Object.hasOwn(toolSchemas, name)
      ? (name as ToolName)
      : 'unknown'
    prepared.set(key, id)
    store.sql
      .prepare(
        'INSERT INTO tool_calls(id,runId,name,arguments,version,status,assistantContent,createdAt,updatedAt,providerToolUseId) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        run.id,
        name,
        '{}',
        'tools-v1',
        'preparing',
        '[]',
        now,
        now,
        callId,
      )
    result.activity!.push({
      type: 'tool',
      id,
      name: safeName,
      status: 'preparing',
    })
    checkpoint()
    emit('tool.preparing', { toolCallId: id, name: safeName })
    return id
  }
  const toolStatus = (
    id: string,
    status: 'running' | 'success' | 'partial' | 'failed',
  ) => {
    const item = result.activity!.find((a) => a.id === id)
    if (item?.type === 'tool') item.status = status
  }
  return {
    appendText,
    prepareTool,
    toolStatus,
    stop: () => clearInterval(textTimer),
  }
}
