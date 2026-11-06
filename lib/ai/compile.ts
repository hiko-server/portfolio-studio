import { Worker } from 'worker_threads'
import { log } from '../log'
import type { CompileAnswer, CompileJob, MdxRefs } from './compileJob'

/**
 * compileForAi (SERVER-ONLY, design §4.5): the MDX check of every AI write,
 * in one `worker_threads` worker with a heap of its own, so a hostile body
 * can never stall or crash the site.
 *
 *   - one worker, one job at a time; a bounded queue behind it (a full
 *     queue answers CHECK_UNAVAILABLE at once);
 *   - a job has 3 s of wall clock: past it the worker is terminated and the
 *     answer is MDX_TOO_COMPLEX; a worker that runs out of heap
 *     (ERR_WORKER_OUT_OF_MEMORY) answers the same; the next job starts a
 *     new worker;
 *   - a worker has 5 s to load; one that cannot start answers
 *     CHECK_UNAVAILABLE, and the caller writes nothing. There is NO
 *     fallback to the main thread, on purpose;
 *   - an idle worker is terminated after 60 s, to give its memory back.
 *
 * Bodies, references and reasons are never logged: only outcomes.
 */

export type CompileVerdict =
  | { ok: true; refs: MdxRefs; beforeRefs: MdxRefs }
  | { ok: false; code: 'MDX_INVALID'; line: number | null; column: number | null; reason: string }
  | { ok: false; code: 'MDX_TOO_COMPLEX' }
  | { ok: false; code: 'CHECK_UNAVAILABLE' }

export const COMPILE_LIMITS = Object.freeze({
  /** Wall clock of one job, from the moment the worker has it. */
  wallMs: 3000,
  /** Time a new worker has to load its modules. */
  bootMs: 5000,
  /** An idle worker is terminated after this long. */
  idleMs: 60_000,
  /** The worker's old-generation heap. */
  heapMb: 256,
  /** Jobs that may wait behind the running one. */
  queueMax: 16,
})

export type CompileLimits = { -readonly [K in keyof typeof COMPILE_LIMITS]: number }

export type CompileInput = {
  /** The new body. */
  body: string
  /** The body it replaces (stored, or the editor's), whose remote images may stay. */
  before?: string | null
  /** The article language, when known (detected from the body otherwise). */
  lang?: string | null
}

export type AiCompiler = {
  compile(input: CompileInput, opts?: { signal?: AbortSignal }): Promise<CompileVerdict>
  /** Terminate the worker and refuse what is queued (shutdown, tests). */
  close(): Promise<void>
  /** Whether a worker is running, how many were started, how many jobs wait. */
  stats(): { running: boolean; starts: number; queued: number }
}

const TOO_COMPLEX: CompileVerdict = Object.freeze({ ok: false, code: 'MDX_TOO_COMPLEX' })
const UNAVAILABLE: CompileVerdict = Object.freeze({ ok: false, code: 'CHECK_UNAVAILABLE' })

/**
 * The worker this module runs: the literal `new Worker(new URL(...))` that
 * webpack turns into a chunk of its own. Node strips the types when it runs
 * the source directly (tests).
 */
function spawnCompileWorker(heapMb: number): Worker {
  return new Worker(new URL('./compileWorker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: heapMb } })
}

type Queued = { job: CompileJob; resolve: (v: CompileVerdict) => void; signal?: AbortSignal; onAbort?: () => void }

const errorCode = (err: unknown) => (err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code ?? '') : '')

/**
 * A compiler with its own worker. `spawn` starts the worker (the default is
 * this module's worker file); `limits` override COMPILE_LIMITS.
 */
export function createAiCompiler(options: { spawn?: (heapMb: number) => Worker; limits?: Partial<CompileLimits> } = {}): AiCompiler {
  const limits: CompileLimits = { ...COMPILE_LIMITS, ...options.limits }
  const spawn = options.spawn ?? spawnCompileWorker
  let worker: Worker | null = null
  let ready: Promise<boolean> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let closed = false
  let nextId = 1
  let starts = 0
  const queue: Queued[] = []

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  async function stop(w: Worker | null): Promise<void> {
    if (!w) return
    if (w === worker) {
      worker = null
      ready = null
    }
    try {
      await w.terminate()
    } catch {
      // Already gone.
    }
  }

  function armIdle() {
    clearIdle()
    if (!worker) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!running && queue.length === 0) void stop(worker)
    }, limits.idleMs)
    idleTimer.unref?.()
  }

  /** Start the worker when there is none; resolves true once it said it is ready. */
  function start(): Promise<boolean> {
    if (ready) return ready
    starts++
    let w: Worker
    try {
      w = spawn(limits.heapMb)
    } catch (err) {
      log.warn('AI compile worker could not start', { code: errorCode(err) || (err instanceof Error ? err.name : 'error') })
      return Promise.resolve(false)
    }
    worker = w
    // The worker never keeps the process alive by itself: a job in flight does, through its timer.
    w.unref()
    // Errors after the boot reach the job that is running (below); this keeps any other one from being unhandled.
    w.on('error', (err) => log.warn('AI compile worker stopped', { code: errorCode(err) || (err instanceof Error ? err.name : 'error') }))
    w.once('exit', () => {
      if (worker === w) {
        worker = null
        ready = null
      }
    })
    const boot = new Promise<boolean>((resolve) => {
      let settled = false
      const done = (up: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', onFail)
        w.off('exit', onFail)
        if (!up) void stop(w)
        resolve(up)
      }
      const onMessage = (m: unknown) => {
        if (m && typeof m === 'object' && (m as { ready?: unknown }).ready === true) done(true)
      }
      const onFail = () => done(false)
      const timer = setTimeout(() => done(false), limits.bootMs)
      w.on('message', onMessage)
      w.on('error', onFail)
      w.on('exit', onFail)
    })
    ready = boot
    return boot
  }

  function verdictOf(answer: CompileAnswer): CompileVerdict {
    if (answer.ok) return { ok: true, refs: answer.refs, beforeRefs: answer.beforeRefs }
    if (answer.code === 'MDX_INVALID') return { ok: false, code: 'MDX_INVALID', line: answer.line, column: answer.column, reason: answer.reason }
    return TOO_COMPLEX
  }

  async function runOne(job: CompileJob): Promise<CompileVerdict> {
    const up = await start()
    const w = worker
    if (!up || !w) return UNAVAILABLE
    return new Promise<CompileVerdict>((resolve) => {
      let settled = false
      const finish = (v: CompileVerdict, kill: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', onError)
        w.off('exit', onExit)
        if (kill) void stop(w)
        resolve(v)
      }
      const onMessage = (m: unknown) => {
        if (m && typeof m === 'object' && (m as { id?: unknown }).id === job.id) finish(verdictOf(m as CompileAnswer), false)
      }
      // Out of heap: the body is too expensive. Anything else: the check could not run.
      const onError = (err: unknown) => finish(errorCode(err) === 'ERR_WORKER_OUT_OF_MEMORY' ? TOO_COMPLEX : UNAVAILABLE, true)
      const onExit = () => finish(UNAVAILABLE, false)
      const timer = setTimeout(() => finish(TOO_COMPLEX, true), limits.wallMs)
      w.on('message', onMessage)
      w.on('error', onError)
      w.on('exit', onExit)
      try {
        w.postMessage(job)
      } catch {
        finish(UNAVAILABLE, true)
      }
    })
  }

  async function pump(): Promise<void> {
    if (running) return
    const next = queue.shift()
    if (!next) {
      armIdle()
      return
    }
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
    running = true
    clearIdle()
    let verdict: CompileVerdict
    try {
      verdict = await runOne(next.job)
    } catch {
      verdict = UNAVAILABLE
    }
    running = false
    next.resolve(verdict)
    void pump()
  }

  return {
    compile(input, opts = {}) {
      if (closed || queue.length >= limits.queueMax || opts.signal?.aborted) return Promise.resolve(UNAVAILABLE)
      return new Promise<CompileVerdict>((resolve) => {
        const item: Queued = { job: { id: nextId++, body: String(input.body ?? ''), before: input.before ?? null, lang: input.lang ?? null }, resolve, signal: opts.signal }
        if (opts.signal) {
          item.onAbort = () => {
            const at = queue.indexOf(item)
            if (at >= 0) {
              queue.splice(at, 1)
              resolve(UNAVAILABLE)
            }
          }
          opts.signal.addEventListener('abort', item.onAbort, { once: true })
        }
        queue.push(item)
        void pump()
      })
    },
    async close() {
      closed = true
      clearIdle()
      for (const item of queue.splice(0)) item.resolve(UNAVAILABLE)
      await stop(worker)
    },
    stats() {
      return { running: worker !== null, starts, queued: queue.length }
    },
  }
}

const g = globalThis as typeof globalThis & { __aiCompiler?: AiCompiler }

/** The site's one compile worker (on globalThis, so a dev reload does not start another). */
export function compileForAi(input: CompileInput, opts: { signal?: AbortSignal } = {}): Promise<CompileVerdict> {
  g.__aiCompiler ??= createAiCompiler()
  return g.__aiCompiler.compile(input, opts)
}
