import type { NextApiRequest } from 'next'
import { clientKey, ipFromReq } from '../rateLimit'
import { ipv6Network48 } from '../security/ipNetwork'
import { sharedLimiter } from '../security/rateLimitCore'
import { getAiDb } from './db'

/**
 * The AI budgets (SERVER-ONLY, design §5.5).
 *
 * Request rates live in memory, in a limiter of their own
 * (`sharedLimiter('ai-mcp', 2000)`), so a flood of AI traffic can never push
 * the site's other windows out of the general limiter, and the reverse.
 * Anything that must survive a restart — writes and bytes per grant, writes
 * per item — is counted in ai.db `ai_counters`, in fixed windows aligned to
 * the UTC hour and day, checked and charged in one transaction.
 *
 * The failed-authentication bucket of /mcp is charged ONLY on a failure and
 * read with `peek` before verification: hosted clients share egress
 * addresses, so valid traffic must never spend it.
 */

export type BudgetRule = { readonly limit: number; readonly windowMs: number }

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Request-rate budgets, in memory (reset on restart). */
export const MEMORY_BUDGETS = {
  /** Failed authentication on /mcp, per client (IPv4, IPv6 /64) — and per IPv6 /48 network. */
  failedAuth: { limit: 60, windowMs: 10 * MIN },
  failedAuthNetwork: { limit: 60, windowMs: 10 * MIN },
  /** /mcp requests per grant. */
  mcpPerGrantMinute: { limit: 60, windowMs: MIN },
  mcpPerGrantHour: { limit: 600, windowMs: HOUR },
  /** Tool calls per grant, inside executeTool (a batch can never multiply it). */
  toolCallsPerGrant: { limit: 60, windowMs: MIN },
  /** Expensive reads, site-wide (results are cached 60 s). */
  expensiveReadsSite: { limit: 6, windowMs: MIN },
  /** AI writes, site-wide. */
  aiWritesSite: { limit: 60, windowMs: 10 * MIN },
  /** /oauth/authorize and /oauth/token, per client network. */
  oauthPerNetwork: { limit: 30, windowMs: 10 * MIN },
  /** /oauth/register, per client network, open or closed. */
  registerPerNetwork: { limit: 5, windowMs: HOUR },
  /** "Check key" and "Test" of a model provider. */
  providerCheck: { limit: 10, windowMs: 10 * MIN },
} as const satisfies Record<string, BudgetRule>

/** Budgets that survive a restart, in ai.db. */
export const PERSISTED_BUDGETS = {
  grantWritesHour: { limit: 30, windowMs: HOUR },
  grantWritesDay: { limit: 200, windowMs: DAY },
  /** Argument bytes written per grant per UTC day. */
  grantBytesDay: { limit: 20 * 1024 * 1024, windowMs: DAY },
  /** Writes per item by any AI actor. */
  itemWritesHour: { limit: 30, windowMs: HOUR },
  itemWritesDay: { limit: 100, windowMs: DAY },
} as const satisfies Record<string, BudgetRule>

/** Counted from the stores, not counters (§5.5). */
export const QUERY_BUDGETS = {
  /** AI-created drafts still existing, per grant. */
  aiDraftsPerGrant: 50,
  /** Waiting changes: per grant; site-wide, of which the last few only the assistant may use. */
  waitingPerGrant: 10,
  waitingSite: 20,
  waitingReservedForAssistant: 5,
} as const

/**
 * A connected app past 80 % of a daily write budget (§5.4 alerts): the
 * owner hears of it once a day per grant, before the budget refuses.
 */
export type BudgetEvent = { type: 'write-budget'; grantId: string; label: string; budget: 'writes' | 'bytes' }

/** The share of a daily budget that warns the owner. */
export const BUDGET_ALERT_SHARE = 0.8

export type MemoryBudget = keyof typeof MEMORY_BUDGETS
export type PersistedBudget = keyof typeof PERSISTED_BUDGETS

export type BudgetVerdict = { ok: true } | { ok: false; budget: string; retryAfterS: number }

const limiter = () => sharedLimiter('ai-mcp', 2000)

const retryAfter = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000))

/** Spend one unit of a memory budget for `subject` (a grant id, a network, 'site'). */
export function takeMemory(name: MemoryBudget, subject: string, now = Date.now()): BudgetVerdict {
  const rule = MEMORY_BUDGETS[name]
  const hit = limiter().hit(`${name}|${subject}`, rule.limit, rule.windowMs, now)
  return hit.allowed ? { ok: true } : { ok: false, budget: name, retryAfterS: retryAfter(hit.resetAt, now) }
}

/** Whether a memory budget would allow one more unit, without spending it. */
export function peekMemory(name: MemoryBudget, subject: string, now = Date.now()): BudgetVerdict {
  const rule = MEMORY_BUDGETS[name]
  const p = limiter().peek(`${name}|${subject}`, rule.limit, now)
  return p.allowed ? { ok: true } : { ok: false, budget: name, retryAfterS: retryAfter(p.resetAt, now) }
}

function failedAuthSubjects(req: NextApiRequest): Array<{ name: MemoryBudget; subject: string }> {
  const out: Array<{ name: MemoryBudget; subject: string }> = [{ name: 'failedAuth', subject: clientKey(req) }]
  const net = ipv6Network48(ipFromReq(req))
  if (net) out.push({ name: 'failedAuthNetwork', subject: net })
  return out
}

/** Before verifying a bearer token: is this client (or its /48) blocked by earlier failures? Spends nothing. */
export function failedAuthBlocked(req: NextApiRequest, now = Date.now()): BudgetVerdict {
  for (const { name, subject } of failedAuthSubjects(req)) {
    const v = peekMemory(name, subject, now)
    if (!v.ok) return v
  }
  return { ok: true }
}

/** After a failed verification (missing excluded): charge the client and its network. */
export function chargeFailedAuth(req: NextApiRequest, now = Date.now()): void {
  for (const { name, subject } of failedAuthSubjects(req)) takeMemory(name, subject, now)
}

// ── Persisted counters (ai.db ai_counters) ────────────────────────────────

export type PersistedCharge = { budget: PersistedBudget; subject: string; amount?: number }

const counterKey = (budget: PersistedBudget, subject: string) => `${budget}|${subject}`
const windowStart = (rule: BudgetRule, now: number) => Math.floor(now / rule.windowMs) * rule.windowMs

/**
 * Charge every budget in `charges` at once, or none: if any one would go
 * past its limit, nothing is written and the first one that is full is named.
 * One transaction (BEGIN IMMEDIATE), so two processes never both pass the
 * last unit.
 */
export function takePersisted(charges: readonly PersistedCharge[], now = Date.now()): BudgetVerdict {
  const db = getAiDb()
  return db.transaction((): BudgetVerdict => {
    const read = db.prepare('SELECT n FROM ai_counters WHERE key = ? AND window_start = ?')
    const planned = charges.map((c) => {
      const rule = PERSISTED_BUDGETS[c.budget]
      const amount = Math.max(0, Math.trunc(c.amount ?? 1))
      const start = windowStart(rule, now)
      const used = Number((read.get(counterKey(c.budget, c.subject), start) as { n: number } | undefined)?.n ?? 0)
      return { c, rule, amount, start, used }
    })
    for (const p of planned) {
      if (p.used + p.amount > p.rule.limit) return { ok: false, budget: p.c.budget, retryAfterS: retryAfter(p.start + p.rule.windowMs, now) }
    }
    const add = db.prepare('INSERT INTO ai_counters (key, window_start, n) VALUES (?, ?, ?) ON CONFLICT (key, window_start) DO UPDATE SET n = n + excluded.n')
    for (const p of planned) if (p.amount > 0) add.run(counterKey(p.c.budget, p.c.subject), p.start, p.amount)
    return { ok: true }
  }).immediate()
}

/** How much of a persisted budget `subject` has used in the current window (for the 80 % alert). */
export function persistedUsage(budget: PersistedBudget, subject: string, now = Date.now()): { used: number; limit: number; resetAt: number } {
  const rule = PERSISTED_BUDGETS[budget]
  const start = windowStart(rule, now)
  const row = getAiDb().prepare('SELECT n FROM ai_counters WHERE key = ? AND window_start = ?').get(counterKey(budget, subject), start) as { n: number } | undefined
  return { used: Number(row?.n ?? 0), limit: rule.limit, resetAt: start + rule.windowMs }
}

/** Drop windows that ended (the longest window is a day); returns how many rows went. */
export function prunePersistedCounters(now = Date.now()): number {
  const longest = Math.max(...Object.values(PERSISTED_BUDGETS).map((r) => r.windowMs))
  return getAiDb().prepare('DELETE FROM ai_counters WHERE window_start + ? <= ?').run(longest, now).changes
}
