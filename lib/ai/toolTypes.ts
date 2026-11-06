import type { ZodType } from 'zod'
import type { Logger } from '../log'
import type { AiActor } from './audit'
import type { WritePlan } from './plans/types'

/**
 * The shapes of the AI tool layer (SERVER-ONLY, design §4.1): one
 * definition per tool, read by both surfaces — the MCP endpoint and the
 * admin assistant — through lib/ai/execute executeTool, the only way any
 * surface reaches a tool. Types and pure helpers only, so a tool module and
 * the registry can both import it without an import cycle.
 */

/** The three OAuth scopes (§5.1), cumulative: no wildcard, no admin scope. */
export const SCOPES = ['content:read', 'content:draft', 'content:propose'] as const
export type Scope = (typeof SCOPES)[number]

export function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
}

/** The scopes a space-separated list names, in catalogue order; unknown names are dropped. */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const named = new Set(String(raw ?? '').split(/\s+/).filter(Boolean))
  return SCOPES.filter((s) => named.has(s))
}

export type Risk = 'read' | 'draft' | 'live' | 'destructive'

export type ToolAnnotations = {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** Every risk `read` tool: read-only, not destructive, idempotent, closed world (§4.2). */
export const READ_ANNOTATIONS: ToolAnnotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })

export type ToolTags = {
  /** Returns owner-only data (drafts, unpublished changes, versions, changes). */
  readsPrivate: boolean
  /** Returns text a third party controls (none in v1: the tag exists so taint can be added when a tool needs it). */
  untrustedOutput: boolean
  /** Its effect can reach the public site (only through the owner's approval). */
  publicEffect: boolean
  /** Can make the server contact another host. */
  egress: boolean
}

/** What a tool's code may use. Built by executeTool from a verified actor, never by a tool. */
export type ToolContext = {
  /** Verified: a live grant row, or a live session with its provider and model. */
  actor: AiActor
  scopes: ReadonlySet<Scope>
  /** A scrubbing logger. Never log arguments, results or prompts. */
  log: Logger
  signal: AbortSignal
  requestId: string | null
  /** The clock of this call (ms). */
  now: number
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; code: ToolCode; message: string; data?: Record<string, unknown> }

/**
 * Stable result codes (§4.1): an execution failure is a result a model can
 * act on, never a protocol error.
 */
export type ToolCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'BUDGET'
  | 'ACCESS_OFF'
  | 'INSUFFICIENT_SCOPE'
  | 'LOOP_STOPPED'
  | 'UNAVAILABLE'
  // Writes (stage M2): the body, the frontmatter and the target.
  | 'MDX_INVALID'
  | 'MDX_TOO_COMPLEX'
  | 'CHECK_UNAVAILABLE'
  | 'VERSION_CONFLICT'
  | 'SLUG_EXISTS'
  | 'SLUG_RESERVED'
  | 'ITEM_SCHEDULED'
  | 'ITEM_IN_REVIEW'
  | 'REMOTE_IMAGE'
  | 'INVISIBLE_CHARS'
  | 'FIELD_NOT_EDITABLE'
  | 'NO_VISIBLE_CHANGE'
  | 'EDIT_NOT_FOUND'
  | 'EDIT_AMBIGUOUS'
  | 'EDIT_TOO_LARGE'
  | 'AUDIT_UNAVAILABLE'
  | 'APPROVAL_REQUIRED'

/** A tool's refusal: the same shape as a failed outcome. */
export type ToolRefusal = Extract<ToolOutcome, { ok: false }>

export type ToolTarget = { kind: string; ref: string }

type ToolBase<I> = {
  /** `^[a-z][a-z0-9_]{0,47}$`, no server prefix: clients namespace. */
  name: string
  /** UI and MCP title; the UI's tool rows use this, never model text. */
  title: string
  /** Static ASCII constant that says when to call it. Never interpolated. */
  description: string
  scope: Scope
  /** Expensive reads share a site-wide budget and a 60 s cache (§5.5). */
  cost: 'cheap' | 'expensive'
  risk: Risk
  annotations: ToolAnnotations
  tags: ToolTags
  /** The validator for every call from every surface. */
  input: ZodType<I>
  /** The slug or page name a call is about, for the call log (never bodies or addresses). */
  targetOf(args: I): ToolTarget | null
}

/** A read tool: runs at once. */
export type ReadToolDef<I> = ToolBase<I> & { read(args: I, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome> }

/**
 * A write tool: its `plan` is pure — it reads the content as it is and
 * writes nothing — and lib/ai/execute decides where the write goes
 * (§4.1 steps 8 to 10).
 */
export type WriteToolDef<I> = ToolBase<I> & {
  plan(args: I, ctx: ToolContext): WritePlan | ToolRefusal | Promise<WritePlan | ToolRefusal>
  /**
   * Arguments that are maps of named fields (frontmatter): a key outside the
   * map's schema is FIELD_NOT_EDITABLE (naming the key), not INVALID_INPUT.
   */
  fieldMaps?: readonly string[]
}

export type ToolDef<I = any> = ReadToolDef<I> | WriteToolDef<I>

/** A read tool definition, checked by the type system. */
export function defineTool<I>(def: ReadToolDef<I>): ReadToolDef<I> {
  return def
}

/** A write tool definition, checked by the type system. */
export function defineWriteTool<I>(def: WriteToolDef<I>): WriteToolDef<I> {
  return def
}

export const isWriteTool = <I>(def: ToolDef<I>): def is WriteToolDef<I> => 'plan' in def && typeof (def as WriteToolDef<I>).plan === 'function'

export const ok = (data: unknown): ToolOutcome => ({ ok: true, data })
export const refuse = (code: ToolCode, message: string, data?: Record<string, unknown>): ToolOutcome => ({ ok: false, code, message, ...(data ? { data } : {}) })

/** Every tool result is at most this many bytes of UTF-8 (§4.1); tools page beyond it. */
export const RESULT_MAX_BYTES = 64 * 1024
/** What a page of results may take, leaving room for the fields around it. */
export const PAGE_BUDGET_BYTES = 56 * 1024

export const byteLength = (v: unknown) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v) ?? '', 'utf8')

/**
 * The longest leading run of `items` whose JSON fits in `budget` bytes (at
 * least one, so a page always moves on: a single item over budget is the
 * caller's to shorten).
 */
export function fitItems<T>(items: readonly T[], budget = PAGE_BUDGET_BYTES): T[] {
  const out: T[] = []
  let used = 2
  for (const item of items) {
    const size = byteLength(item) + 1
    if (out.length && used + size > budget) break
    out.push(item)
    used += size
  }
  return out
}

/** Bytes a character takes inside a JSON string (JSON.stringify's escaping; lone surrogates count as escaped). */
function jsonCharBytes(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code >= 0xd800 && code <= 0xdfff) return 6
  return code < 0x10000 ? 3 : 4
}

/**
 * The window of `text` from character `offset` that fits in `budget` bytes
 * once written as a JSON string, never splitting a surrogate pair, with
 * where the next window starts (null at the end).
 */
export function textWindow(text: string, offset: number, budget: number): { text: string; nextOffset: number | null } {
  const start = Math.min(Math.max(0, offset), text.length)
  let used = 0
  let end = start
  while (end < text.length) {
    const code = text.codePointAt(end) as number
    const bytes = jsonCharBytes(code)
    if (used + bytes > budget) break
    used += bytes
    end += code > 0xffff ? 2 : 1
  }
  return { text: text.slice(start, end), nextOffset: end < text.length ? end : null }
}

/** An opaque page cursor (`o<offset>`), and its reading: null for anything that is not one. */
export const cursorOf = (offset: number) => `o${offset}`
export function offsetOfCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0
  const m = /^o(\d{1,7})$/.exec(cursor)
  return m ? Number(m[1]) : null
}

/** A page of `rows` from `cursor`, `limit` at most and inside the byte budget, with the next cursor. */
export function pageOf<T>(rows: readonly T[], cursor: string | undefined, limit: number): { items: T[]; next_cursor: string | null } | null {
  const offset = offsetOfCursor(cursor)
  if (offset === null) return null
  const items = fitItems(rows.slice(offset, offset + limit))
  const next = offset + items.length
  return { items, next_cursor: next < rows.length ? cursorOf(next) : null }
}
