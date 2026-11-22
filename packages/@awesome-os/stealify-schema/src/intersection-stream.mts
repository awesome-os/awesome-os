/**
 * @file packages/@awesome-os/stealify-schema/src/intersection-stream.mts
 * @description Pure Web Streams 7-Tuple Composed Intersection Stream primitive.
 *
 * Bridges the StealifyLang 7-Tuple Execution Context Algebra (`C_cloud = (B, D, L, T, κ, Λ, Ω)`)
 * directly onto standard Web Streams (`ReadableStream`, `TransformStream`, `WritableStream`, `.tee()`):
 *   - `createContextGateTransform`: enforces `checkAdmissibility` + per-frame `shouldEmitForPersona`
 *     with zero leakage to consumer callers.
 *   - `createPersonaTee`: structural zero-cost consumer mode (skips `.tee()` when `!isDevOpsAttached`)
 *     and live `.tee()` fan-out into consumer + devops/telemetry/error branches when DevOps is attached.
 *   - `composeIntersectionStreams`: flattens multi-stage `.pipeThrough()` pipelines while algebraically
 *     composing their 7-tuple `ExecutionContext`s via `intersectContexts`.
 *   - `createFrameSource` / `createFrameCollector`: pure Web Streams source & sink helpers.
 *
 * Strictly `erasableSyntaxOnly: true` and ZERO `node:*` imports.
 */

import {
  checkAdmissibility,
  intersectContexts,
  isDevOpsAttached,
  personaRank,
  shouldEmitForPersona,
  type AdmissibilityViolation,
  type ExecutionContext,
  type PersonaPlane,
} from './algebra.mts'

export type StreamFrameKind = 'data' | 'error' | 'advisory' | 'metric' | 'fix'

export interface StreamFrame<T = unknown> {
  readonly kind: StreamFrameKind
  readonly source: string
  readonly minPersona: PersonaPlane
  readonly payload: T
  readonly ts: number
  readonly violations?: readonly AdmissibilityViolation[]
}

export interface ComposedIntersectionStream<TIn = StreamFrame, TOut = StreamFrame> {
  readonly id: string
  readonly context: ExecutionContext
  readonly readable: ReadableStream<TOut>
  readonly writable: WritableStream<TIn>
}

export interface ContextGateOptions {
  readonly strict?: boolean
}

export interface PersonaTeeResult<T = unknown> {
  readonly consumer: ReadableStream<StreamFrame<T>>
  readonly devops: ReadableStream<StreamFrame<T>> | null
}

export interface FrameCollector<T = unknown> {
  readonly writable: WritableStream<StreamFrame<T>>
  readonly done: Promise<readonly StreamFrame<T>[]>
}

export class ContextGateError extends Error {
  readonly violations: readonly AdmissibilityViolation[]
  constructor(violations: readonly AdmissibilityViolation[]) {
    super(
      `ContextGate admissibility failed (${violations.length} violation(s)): ${violations
        .map((v) => `${v.invariant}: ${v.message}`)
        .join('; ')}`
    )
    this.name = 'ContextGateError'
    this.violations = violations
  }
}

const DEVOPS_RANK = personaRank('devops')

/**
 * Creates a pure Web `TransformStream` that gates `StreamFrame` traffic using the
 * 7-Tuple Execution Context Algebra:
 *   - Evaluates `checkAdmissibility(reqCtx, callerCtx)` once.
 *   - In `strict: true` mode, errors the stream immediately if admissibility fails.
 *   - Per frame, evaluates `shouldEmitForPersona(frame.minPersona, callerCtx.persona ?? 'consumer')`
 *     and silently drops any frame above the caller's persona plane (zero leakage).
 *   - In non-strict mode, annotates admissibility `violations` onto devops/kernel-audit frames cleanly.
 */
export function createContextGateTransform<T = unknown>(
  reqCtx: ExecutionContext,
  callerCtx: ExecutionContext,
  opts?: ContextGateOptions
): TransformStream<StreamFrame<T>, StreamFrame<T>> {
  const admissibility = checkAdmissibility(reqCtx, callerCtx)
  const callerPersona: PersonaPlane = callerCtx.persona ?? 'consumer'
  const strict = opts?.strict === true

  return new TransformStream<StreamFrame<T>, StreamFrame<T>>({
    start(controller) {
      if (strict && !admissibility.admissible) {
        controller.error(new ContextGateError(admissibility.violations))
      }
    },
    transform(frame, controller) {
      if (!shouldEmitForPersona(frame.minPersona, callerPersona)) {
        return
      }

      if (!admissibility.admissible && personaRank(frame.minPersona) >= DEVOPS_RANK) {
        const mergedViolations = frame.violations
          ? [...frame.violations, ...admissibility.violations]
          : admissibility.violations
        controller.enqueue({
          ...frame,
          violations: mergedViolations,
        })
        return
      }

      controller.enqueue(frame)
    },
  })
}

/**
 * Persona-aware fan-out over a `ReadableStream<StreamFrame<T>>`:
 *   - **Structural Zero-Cost Consumer Mode:** when `!isDevOpsAttached(callerCtx)`, does NOT call
 *     `source.tee()` — pipes directly through a lightweight consumer-only filter `TransformStream`
 *     and returns `{ consumer, devops: null }`.
 *   - **DevOps Attached Mode:** when `isDevOpsAttached(callerCtx)`, calls `source.tee()` to fan out
 *     into `branchA` (consumer-only `TransformStream`) and `branchB` (devops/telemetry/error
 *     `TransformStream`), returning `{ consumer, devops }`.
 */
export function createPersonaTee<T = unknown>(
  source: ReadableStream<StreamFrame<T>>,
  callerCtx: ExecutionContext
): PersonaTeeResult<T> {
  const callerPersona: PersonaPlane = callerCtx.persona ?? 'consumer'

  if (!isDevOpsAttached(callerCtx)) {
    const consumerFilter = new TransformStream<StreamFrame<T>, StreamFrame<T>>({
      transform(frame, controller) {
        if (shouldEmitForPersona(frame.minPersona, callerPersona)) {
          controller.enqueue(frame)
        }
      },
    })
    return {
      consumer: source.pipeThrough(consumerFilter),
      devops: null,
    }
  }

  const [branchA, branchB] = source.tee()

  const consumerFilter = new TransformStream<StreamFrame<T>, StreamFrame<T>>({
    transform(frame, controller) {
      if (shouldEmitForPersona(frame.minPersona, 'consumer')) {
        controller.enqueue(frame)
      }
    },
  })

  const devopsFilter = new TransformStream<StreamFrame<T>, StreamFrame<T>>({
    transform(frame, controller) {
      if (!shouldEmitForPersona(frame.minPersona, callerPersona)) {
        return
      }
      if (personaRank(frame.minPersona) >= DEVOPS_RANK || frame.kind !== 'data') {
        controller.enqueue(frame)
      }
    },
  })

  return {
    consumer: branchA.pipeThrough(consumerFilter),
    devops: branchB.pipeThrough(devopsFilter),
  }
}

/**
 * Algebraically composes a sequence of `ComposedIntersectionStream` stages:
 *   1. Composes all stage `context`s via `intersectContexts(id, stages.map(s => s.context))`.
 *   2. Chains `stages[0].readable.pipeThrough(stages[1]).pipeThrough(...)` into one flattened
 *      `ComposedIntersectionStream` (`writable: stages[0].writable`, `readable: lastReadable`, `context`).
 */
export function composeIntersectionStreams(
  id: string,
  stages: readonly ComposedIntersectionStream<any, any>[]
): ComposedIntersectionStream<any, any> {
  const context = intersectContexts(
    id,
    stages.map((stage) => stage.context)
  )

  const first = stages[0]!
  let currentReadable: ReadableStream<any> = first.readable
  for (let i = 1; i < stages.length; i += 1) {
    currentReadable = currentReadable.pipeThrough(stages[i]!)
  }

  return Object.freeze({
    id,
    context,
    writable: first.writable,
    readable: currentReadable,
  })
}

/**
 * Creates a pure Web `ReadableStream` emitting the provided `StreamFrame` array in order.
 */
export function createFrameSource<T = unknown>(
  frames: readonly StreamFrame<T>[]
): ReadableStream<StreamFrame<T>> {
  return new ReadableStream<StreamFrame<T>>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame)
      }
      controller.close()
    },
  })
}

/**
 * Creates a pure Web `WritableStream` sink that collects all written `StreamFrame`s
 * and resolves `done` with the frozen array once the stream closes.
 */
export function createFrameCollector<T = unknown>(): FrameCollector<T> {
  const collected: StreamFrame<T>[] = []
  let resolveDone!: (frames: readonly StreamFrame<T>[]) => void
  let rejectDone!: (reason?: unknown) => void

  const done = new Promise<readonly StreamFrame<T>[]>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  done.catch(() => {})

  const writable = new WritableStream<StreamFrame<T>>({
    write(frame) {
      collected.push(frame)
    },
    close() {
      resolveDone(Object.freeze(collected))
    },
    abort(reason) {
      rejectDone(reason)
    },
  })

  return { writable, done }
}

export type LivenessPhase = 'pending' | 'progress' | 'done'

export interface LivenessFrame<T = unknown> {
  readonly phase: LivenessPhase
  readonly label?: string
  readonly count: number
  readonly total?: number
  readonly pct?: number
  readonly elapsedMs: number
  readonly data?: T
}

/**
 * Wraps any pure Web `ReadableStream<T>` with automatic `LivenessFrame<T>` envelopes:
 * emits `pending` on start, `progress` with `{ count, total, pct, elapsedMs, data }`
 * on every chunk, and `done` on flush — works identically for DOM, Canvas 2D/3D,
 * or raw framebuffers with zero manual `isLoading` state.
 */
export function createLivenessTransform<T = unknown>(opts?: {
  readonly label?: string
  readonly total?: number
}): TransformStream<T, LivenessFrame<T>> {
  const startMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  let count = 0

  return new TransformStream<T, LivenessFrame<T>>({
    start(controller) {
      controller.enqueue({
        phase: 'pending',
        label: opts?.label,
        count: 0,
        total: opts?.total,
        pct: opts?.total ? 0 : undefined,
        elapsedMs: 0,
      })
    },
    transform(chunk, controller) {
      count++
      const elapsedMs = Number((nowMs() - startMs).toFixed(2))
      const pct =
        opts?.total && opts.total > 0
          ? Math.min(100, Number(((count / opts.total) * 100).toFixed(1)))
          : undefined
      controller.enqueue({
        phase: 'progress',
        label: opts?.label,
        count,
        total: opts?.total,
        pct,
        elapsedMs,
        data: chunk,
      })
    },
    flush(controller) {
      controller.enqueue({
        phase: 'done',
        label: opts?.label,
        count,
        total: opts?.total,
        pct: 100,
        elapsedMs: Number((nowMs() - startMs).toFixed(2)),
      })
    },
  })
}
