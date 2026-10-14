import {
  SYSTEM,
  MAX_REPLY_CHARACTERS,
  TARGET_REPLY_CHARACTERS,
  replyLength,
  compact,
  prepareModelInput,
} from './model-context.js'
import { createRunProgress, type Emit } from './run-progress.js'
import { type Store, type Run, type Usage } from '../db/store.js'
import {
  emptyResult,
  publicError,
  ServiceError,
  toolSchemas,
  type ToolName,
  type ToolOutput,
} from '../contracts.js'
import {
  ADAPTER_VERSION,
  type Provider,
  type MessageParam,
  type Message,
  type ModelResponse,
  type ToolResultBlockParam,
  type ProviderEvent,
} from './provider.js'
import { FORMULA_VERSION } from '../hyperliquid/risk.js'
import { type BusinessTools } from '../hyperliquid/tools.js'
export type { Emit } from './run-progress.js'
export class Runner {
  constructor(
    private store: Store,
    private tools: BusinessTools,
    private provider: Provider,
    private report: (metrics: Record<string, unknown>) => void = () => {},
  ) {}
  async execute(run: Run, signal: AbortSignal, emit: Emit): Promise<void> {
    const start = Date.now(),
      deadline = Infinity,
      combined = signal
    const result = emptyResult(),
      usage: Usage = { input: 0, output: 0, unconfirmed: 0 }
    this.store.sql
      .prepare('UPDATE runs SET adapterVersion=? WHERE id=?')
      .run(ADAPTER_VERSION, run.id)
    const checkpoint = () => this.store.checkpoint(run.id, result, usage)
    let totalTools = 0,
      toolFailures = 0,
      hadToolFailure = false
    const modelResponses: Record<string, unknown>[] = []
    const responseText = (response: Message) =>
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    const history = this.store.history(run.conversationId, 12).messages
    const messages: MessageParam[] = history
      .filter((m) => m.role === 'user' || m.textStatus === 'final')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: `[observedAddress=${m.observedAddress ?? 'none'}; version=${m.addressVersion}; ${m.runId === run.id ? 'current request' : 'historical, not current evidence'}]\n${m.text}`,
      }))
    const outputs = new Map<string, ToolOutput>()
    const system = `${SYSTEM}\nFixed observedAddress=${run.observedAddress ?? 'none'}, addressVersion=${run.addressVersion}, marketScope=${run.marketScope}. Current UTC=${new Date().toISOString()}.`
    const { appendText, prepareTool, toolStatus, stop } = createRunProgress(
      this.store,
      run,
      result,
      combined,
      emit,
      checkpoint,
    )
    let nextRound = 0
    const invoke = async (
      tools: boolean,
      compressionAttempt = 0,
    ): Promise<{ response: ModelResponse; round: number }> => {
      const { input, count } = await prepareModelInput(
          this.provider,
          messages,
          outputs,
          system,
          combined,
          deadline,
          usage,
          tools,
        ),
        reserved = count + input.maxTokens
      const round = nextRound++
      let streamed = ''
      const textId = `text:${round}:0`
      const onEvent = (event: ProviderEvent) => {
        combined.throwIfAborted()
        if (event.type === 'tool.preparing')
          prepareTool(round, event.id, event.name)
        else if (event.text) {
          // Reserve activity order while withholding unchecked answer drafts.
          if (!streamed)
            result.activity!.push({
              type: 'text',
              id: textId,
              round,
              phase: 'pending',
              text: '',
            })
          streamed += event.text
        }
      }
      usage.unconfirmed += reserved
      checkpoint()
      let response: ModelResponse
      try {
        response = tools
          ? await this.provider.generate(input, onEvent)
          : await this.provider.final(
              input,
              (text) => onEvent({ type: 'text', blockIndex: 0, text }),
              onEvent,
            )
        combined.throwIfAborted()
      } catch (error) {
        // Preserve interrupted evidence without treating it as a complete answer.
        const item = result.activity!.find((a) => a.id === textId)
        if (item?.type === 'text') item.text = streamed
        if (streamed) result.text += `${result.text ? '\n\n' : ''}${streamed}`
        throw error
      }
      const text = responseText(response)
      const hasTools = response.content.some((b) => b.type === 'tool_use')
      const phase =
        tools &&
        (hasTools ||
          !['end_turn', 'max_tokens'].includes(response.stop_reason ?? ''))
          ? 'explanation'
          : 'final'
      modelResponses.push({
        stage: tools ? 'generate' : 'final',
        stopReason: response.stop_reason,
        contentTypes: response.content.map((block) => block.type),
        textCharacters: text.length,
        outputTokens: response.usage.output_tokens,
      })
      usage.unconfirmed -= reserved
      usage.input += response.usage.input_tokens
      usage.output += response.usage.output_tokens
      this.store.checkpoint(run.id, result, usage, response.model)
      if (
        !hasTools &&
        (response.stop_reason === 'max_tokens' ||
          replyLength(text) > MAX_REPLY_CHARACTERS)
      ) {
        result.activity = result.activity!.filter((a) => a.id !== textId)
        checkpoint()
        if (compressionAttempt >= 2)
          throw new ServiceError(
            'incompleteModelResponse',
            'Model could not produce a complete answer within the character limit',
            502,
            true,
          )
        messages.push(
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: `Rewrite the preceding draft as a complete, self-contained final answer, not a continuation. It ${response.stop_reason === 'max_tokens' ? 'was cut off by the token limit' : `exceeded ${MAX_REPLY_CHARACTERS} characters`}. Use at most ${compressionAttempt ? 600 : TARGET_REPLY_CHARACTERS} Unicode characters including whitespace and Markdown. Preserve essential sourced figures, material risks, coverage and missing-data caveats. Remove secondary detail and repetition. End with complete sentences. Use only the existing evidence; do not call tools or invent data.`,
          },
        )
        return invoke(false, compressionAttempt + 1)
      }
      if (text) {
        if (result.text) appendText('\n\n', round, 0, true)
        appendText(text, round, 0)
      }
      for (const item of result.activity!)
        if (item.type === 'text' && item.round === round) item.phase = phase
      emit('message.round.completed', { round, phase })
      checkpoint()
      return { response, round }
    }
    emit('run.started', {
      runId: run.id,
      observedAddress: run.observedAddress,
      addressVersion: run.addressVersion,
      marketScope: run.marketScope,
    })
    try {
      let final: Message | undefined
      for (let iteration = 0; iteration < 3; iteration++) {
        const { response, round } = await invoke(true)
        const calls = response.content.filter((b) => b.type === 'tool_use')
        if (!calls.length) {
          const text = responseText(response)
          if (
            text.trim() &&
            ['end_turn', 'max_tokens'].includes(response.stop_reason ?? '')
          ) {
            final = response
            break
          }
          messages.push(
            { role: 'assistant', content: response.content },
            {
              role: 'user',
              content:
                'Give the final answer now, using fresh evidence when available and clearly stating scope or missing data.',
            },
          )
          break
        }
        messages.push({ role: 'assistant', content: response.content })
        const toolResults: ToolResultBlockParam[] = []
        for (const call of calls) {
          const id = prepareTool(round, call.id, call.name)
          this.store.sql
            .prepare(
              'UPDATE tool_calls SET arguments=?,assistantContent=?,updatedAt=? WHERE id=?',
            )
            .run(
              JSON.stringify(call.input),
              JSON.stringify(response.content),
              Date.now(),
              id,
            )
          try {
            combined.throwIfAborted()
            const inputError = response.toolInputErrors?.[call.id]
            if (inputError)
              throw new ServiceError(
                inputError,
                'Tool arguments were not complete or valid',
              )
            const schema = Object.hasOwn(toolSchemas, call.name)
              ? toolSchemas[call.name as ToolName]
              : undefined
            if (!schema)
              throw new ServiceError(
                'toolForbidden',
                'Only read-only tools are available',
              )
            if (!schema.safeParse(call.input).success)
              throw new ServiceError(
                'invalidToolInput',
                'Invalid tool arguments',
              )
            if (totalTools >= 6)
              throw new ServiceError(
                'toolBudgetExceeded',
                'Six-tool execution limit reached',
              )
            totalTools++
            toolStatus(id, 'running')
            this.store.sql
              .prepare('UPDATE tool_calls SET status=?,updatedAt=? WHERE id=?')
              .run('running', Date.now(), id)
            checkpoint()
            emit('tool.started', { toolCallId: id, name: call.name })
            const output = await this.tools.execute(
              call.name as ToolName,
              call.input,
              {
                address: run.observedAddress,
                signal: combined,
                deadline,
                toolCallId: id,
              },
            )
            combined.throwIfAborted()
            outputs.set(call.id, output)
            result.dataCards.push({
              ...output,
              id,
              kind: call.name as ToolName,
              sourceIds: output.sources.map((s) => s.sourceId),
              formulaVersion: FORMULA_VERSION,
            })
            result.sources.push(...output.sources)
            result.coverage.push(output.coverage)
            result.warnings = [
              ...new Set([...result.warnings, ...output.warnings]),
            ]
            toolStatus(id, output.coverage.complete ? 'success' : 'partial')
            this.store.sql.transaction(() => {
              this.store.sql
                .prepare(
                  'UPDATE tool_calls SET status=?,result=?,updatedAt=? WHERE id=?',
                )
                .run(
                  output.coverage.complete ? 'success' : 'partial',
                  JSON.stringify(output),
                  Date.now(),
                  id,
                )
              checkpoint()
            })()
            emit('tool.completed', {
              toolCallId: id,
              status: output.coverage.complete ? 'success' : 'partial',
              name: call.name,
            })
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: JSON.stringify(compact(output, 1)),
            })
          } catch (e) {
            toolFailures++
            const error = publicError(e)
            toolStatus(id, 'failed')
            if (error.status >= 500) hadToolFailure = true
            result.warnings.push(
              `${Object.hasOwn(toolSchemas, call.name) ? call.name : 'read-only query'}: ${error.code}`,
            )
            this.store.sql.transaction(() => {
              this.store.sql
                .prepare(
                  'UPDATE tool_calls SET status=?,error=?,updatedAt=? WHERE id=?',
                )
                .run('failed', JSON.stringify(error.toJSON()), Date.now(), id)
              checkpoint()
            })()
            emit('tool.completed', {
              toolCallId: id,
              status: 'failed',
              name: Object.hasOwn(toolSchemas, call.name)
                ? call.name
                : 'unknown',
            })
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: JSON.stringify(error.toJSON()),
            })
            combined.throwIfAborted()
          }
        }
        messages.push({ role: 'user', content: toolResults }) // every tool_use has its paired result, including rejected calls
        if (totalTools >= 6) break
      }
      if (!final) {
        final = (await invoke(false)).response
      }
      combined.throwIfAborted()
      if (!responseText(final).trim())
        throw new ServiceError(
          'emptyModelResponse',
          'Model returned no final explanation',
          502,
          true,
        )
      if (
        final.content.some((b) => b.type === 'tool_use') ||
        !['end_turn', 'max_tokens'].includes(final.stop_reason ?? '')
      )
        throw new ServiceError(
          'incompleteModelResponse',
          'Model did not finish its final explanation',
          502,
          true,
        )
      if (hadToolFailure && result.dataCards.length === 0)
        throw new ServiceError(
          'evidenceUnavailable',
          'No requested data could be retrieved; explanation is incomplete',
          502,
          true,
        )
      result.textStatus =
        final.stop_reason === 'max_tokens' ? 'partial' : 'final'
      if (result.textStatus === 'partial')
        result.warnings.push(
          'Answer incomplete: model output token limit reached.',
        )
      if (this.store.finish(run, 'completed', result, usage, null))
        emit('message.completed', { result })
    } catch (e) {
      const interrupted = signal.aborted
      const error = interrupted
        ? new ServiceError(
            'clientDisconnected',
            'Response interrupted; saved results remain available',
            499,
            true,
          )
        : publicError(e)
      result.textStatus = result.text ? 'partial' : 'unavailable'
      if (
        this.store.finish(
          run,
          interrupted ? 'interrupted' : 'failed',
          result,
          usage,
          error.toJSON(),
        )
      )
        emit(interrupted ? 'run.interrupted' : 'run.failed', {
          error: error.toJSON(),
          result,
        })
    } finally {
      stop()
      const saved = this.store.run(run.id, run.ownerId)
      this.report({
        runId: run.id,
        latencyMs: Date.now() - start,
        tokenUsage: usage,
        toolExecutions: totalTools,
        status: saved.status,
        errorCode: JSON.parse(saved.error ?? 'null')?.code ?? null,
        modelResponses,
        toolFailures,
        cacheHits: result.sources.filter((s) => s.cacheHit).length,
        sourceQueries: result.sources.length,
      })
    }
  }
}
