import crypto from 'node:crypto'
import * as z from 'zod'
import { stableStringify } from '../contentStore'
import { getChange, listMyChanges } from './tools/changes'
import { getContent, searchContent } from './tools/content'
import { getAuthoringGuide } from './tools/guide'
import { getContentHealth } from './tools/health'
import { listMedia } from './tools/media'
import { getSiteOverview } from './tools/overview'
import { getCv, getHome } from './tools/profile'
import { listVersions } from './tools/versions'
import { createDraft, editContent, setMediaText } from './tools/writes'
import { SCOPES, type Scope, type ToolAnnotations, type ToolDef } from './toolTypes'

/**
 * The tool registry (SERVER-ONLY, design §4.1): one sorted list of tool
 * definitions, and the one wire form of each — the same JSON Schema for MCP
 * `tools/list` and for every model provider's tool calling.
 *
 * Wire schema profile: root `type: object` with `additionalProperties:
 * false`; below it only `type`, `properties`, `required`, `enum`, `items`
 * and `description`. No `$ref`, `oneOf`, `allOf`, `format`, `pattern`,
 * nullable unions, numeric or length bounds: providers reject them in
 * different ways, so the bounds live in the Zod validator (which every call
 * passes) and are restated in the descriptions. Computed once at load from
 * the Zod inputs, checked against the profile (a tool outside it fails the
 * load, and tests/ai-tools walks every schema), never sent with `strict`.
 *
 * `tool_list_hash` (SHA-256 of the sorted wire list) goes into every audit
 * row of an AI write, so a log line names the exact tool set a model saw.
 */

export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: Array<string | number | boolean>
  items?: JsonSchema
  description?: string
  additionalProperties?: false
}

export type WireTool = {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema & { type: 'object'; properties: Record<string, JsonSchema>; additionalProperties: false }
  annotations: ToolAnnotations & { title: string }
}

export type RegisteredTool = ToolDef & { wire: WireTool }

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/

const PROFILE_KEYS = new Set(['type', 'properties', 'required', 'enum', 'items', 'description'])
const PROFILE_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** Keep only the profile's keywords, at every depth; the root also closes its properties. */
function toProfile(node: Record<string, unknown>, root: boolean): JsonSchema {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (!PROFILE_KEYS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([k, v]) => [k, toProfile(v, false)]))
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.items = toProfile(value as Record<string, unknown>, false)
    } else out[key] = value
  }
  if (root) {
    if (!out.properties) out.properties = {}
    out.additionalProperties = false
  }
  return out as JsonSchema
}

/** Where `schema` leaves the wire profile; empty when it is inside it. */
export function wireProfileProblems(schema: unknown, path = '$', root = true): string[] {
  const problems: string[] = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path}: not an object`]
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (PROFILE_KEYS.has(key)) continue
    if (root && key === 'additionalProperties' && node[key] === false) continue
    problems.push(`${path}: keyword ${key} is outside the profile`)
  }
  if (typeof node.type !== 'string' || !PROFILE_TYPES.has(node.type)) problems.push(`${path}: type must be one of ${[...PROFILE_TYPES].join(', ')}`)
  if (root && (node.type !== 'object' || node.additionalProperties !== false)) problems.push(`${path}: the root must be an object with additionalProperties false`)
  if (node.description !== undefined && typeof node.description !== 'string') problems.push(`${path}: description must be a string`)
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || !node.enum.every((v) => typeof v === 'string')) problems.push(`${path}: enum must list strings`)
  }
  if (node.type === 'object') {
    const props = node.properties
    if (!props || typeof props !== 'object' || Array.isArray(props)) problems.push(`${path}: an object needs properties`)
    else for (const [k, v] of Object.entries(props)) problems.push(...wireProfileProblems(v, `${path}.${k}`, false))
    if (node.required !== undefined) {
      const keys = props && typeof props === 'object' ? Object.keys(props) : []
      if (!Array.isArray(node.required) || !node.required.every((r) => typeof r === 'string' && keys.includes(r))) problems.push(`${path}: required must name its properties`)
    }
  } else if (node.properties !== undefined || node.required !== undefined) problems.push(`${path}: properties on a non-object`)
  if (node.type === 'array') {
    if (!node.items) problems.push(`${path}: an array needs items`)
    else problems.push(...wireProfileProblems(node.items, `${path}[]`, false))
  } else if (node.items !== undefined) problems.push(`${path}: items on a non-array`)
  return problems
}

/** The wire form of one tool, checked against the profile and the metadata rules. */
export function wireOf(def: ToolDef): WireTool {
  if (!TOOL_NAME_RE.test(def.name)) throw new Error(`AI tool name ${JSON.stringify(def.name)} is not ^[a-z][a-z0-9_]{0,47}$`)
  const inputSchema = toProfile(z.toJSONSchema(def.input, { io: 'input' }) as Record<string, unknown>, true) as WireTool['inputSchema']
  const problems = wireProfileProblems(inputSchema)
  if (problems.length) throw new Error(`AI tool ${def.name}: input schema outside the wire profile: ${problems.join('; ')}`)
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema,
    annotations: { title: def.title, ...def.annotations },
  }
}

const DEFINITIONS: readonly ToolDef[] = [
  createDraft,
  editContent,
  getAuthoringGuide,
  getChange,
  getContent,
  getContentHealth,
  getCv,
  getHome,
  getSiteOverview,
  listMedia,
  listMyChanges,
  listVersions,
  searchContent,
  setMediaText,
]

/** Every tool, sorted by name, each with its wire form. */
export const TOOLS: readonly RegisteredTool[] = Object.freeze(
  [...DEFINITIONS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((def) => Object.freeze({ ...def, wire: wireOf(def) })),
)

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
if (BY_NAME.size !== TOOLS.length) throw new Error('AI tool names must be unique')

export function toolByName(name: unknown): RegisteredTool | null {
  return typeof name === 'string' ? (BY_NAME.get(name) ?? null) : null
}

/** The tools a set of scopes may call (tools/list is filtered by the request's token, §5.1). */
export function toolsFor(scopes: ReadonlySet<Scope>): RegisteredTool[] {
  return TOOLS.filter((t) => scopes.has(t.scope))
}

/** The wire list for a set of scopes, in registry order. */
export function wireToolsFor(scopes: ReadonlySet<Scope>): WireTool[] {
  return toolsFor(scopes).map((t) => t.wire)
}

/** SHA-256 (hex) of the full sorted wire list: which tool set an audit row's model saw. */
export const TOOL_LIST_HASH: string = crypto.createHash('sha256').update(stableStringify(TOOLS.map((t) => t.wire))).digest('hex')

/** The scopes a caller lacks for `tool`, with the scope it needs (for an insufficient_scope challenge). */
export function missingScope(tool: RegisteredTool, scopes: ReadonlySet<Scope>): Scope | null {
  return scopes.has(tool.scope) ? null : tool.scope
}

/** The catalogue as the admin pages show it: every tool, its level and risk, never a schema. */
export function catalogueView() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    scope: t.scope,
    level: SCOPES.indexOf(t.scope) + 1,
    risk: t.risk,
    cost: t.cost,
    annotations: t.annotations,
  }))
}
