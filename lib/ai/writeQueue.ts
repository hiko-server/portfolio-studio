/**
 * The single AI-write queue (SERVER-ONLY, design §4.1 step 10): one AI
 * write at a time in this process — a draft saved by a tool, a proposal
 * stored, an approval executed (lib/ai/apply) — so budgets, change rows,
 * activity rows and content writes of two of them never interleave, and an
 * approval's re-plan and its write see the same content.
 */

const g = globalThis as typeof globalThis & { __aiWriteQueue?: Promise<unknown> }

export function inWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
  const before = g.__aiWriteQueue ?? Promise.resolve()
  const run = before.then(fn, fn)
  g.__aiWriteQueue = run.catch(() => undefined)
  return run
}
