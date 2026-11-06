/**
 * Pure helpers of Admin → AI → Connections (unit tested in tests/ai-admin-ui).
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** True for a page served from this computer (the localhost banner, design §8.5). */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return LOOPBACK.has(h) || h.endsWith('.localhost')
}

/**
 * The short name an app files this server under: the site's first host label
 * ("example-site" for https://www.example-site.com/mcp), "site-local" for a
 * loopback address, "site" when nothing usable remains.
 */
export function serverName(server: string | null): string {
  if (!server) return 'site'
  let host: string
  try {
    host = new URL(server).hostname.toLowerCase()
  } catch {
    return 'site'
  }
  if (isLocalHostname(host)) return 'site-local'
  const label = host.replace(/^www\./, '').split('.')[0] || ''
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(label) && !/^\d+$/.test(label) ? label : 'site'
}

/** The environment variable a token goes in, from the server name ("SITE_LOCAL_MCP_TOKEN"). */
export function tokenEnvVar(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MCP_TOKEN`
}

/**
 * The Claude Code command that adds this server with a bearer header
 * (design §13 step 5). `token` is the token itself (the one-time view) or a
 * shell reference to the variable holding it.
 */
export function claudeCodeCommand(name: string, server: string, token: string): string {
  return `claude mcp add --transport http --scope local ${name} ${server} --header "Authorization: Bearer ${token}"`
}

/** A shell reference to an environment variable ("$SITE_LOCAL_MCP_TOKEN"). */
export function shellRef(name: string): string {
  return '$' + name
}

/** The header any other app sends. */
export function bearerHeader(token: string): string {
  return `Authorization: Bearer ${token}`
}

/** The Claude Code command that adds this server with no header, so Claude Code signs in over OAuth (/mcp in Claude Code). */
export function claudeCodeOAuthCommand(name: string, server: string): string {
  return `claude mcp add --transport http --scope local ${name} ${server}`
}

/** Cursor's mcp.json entry for this server: OAuth, or with `envVar` a personal token read from the environment. */
export function cursorConfig(name: string, server: string, envVar?: string): string {
  const entry: Record<string, unknown> = { url: server }
  if (envVar) entry.headers = { Authorization: `Bearer \${env:${envVar}}` }
  return JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)
}

/** Codex: add the server, then sign in to it (OAuth). */
export function codexCommands(name: string, server: string): string {
  return `codex mcp add ${name} --url ${server}\ncodex mcp login ${name}`
}

/** A host as the owner might type it, compared as the server compares it: case, spaces, a trailing dot and IPv6 brackets aside. */
export function sameHost(typed: string, host: string): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  const t = norm(typed)
  if (!t) return false
  let ascii = t
  try {
    ascii = new URL(`http://${t.includes(':') ? `[${t}]` : t}/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return ascii === norm(host)
}

/** Minutes and seconds left until `at` ("9:41"), never below 0:00. */
export function timeLeft(at: number, now: number): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Is `href` a web address this page may send the browser to (an app's https or loopback http redirect)? */
export function isWebRedirect(href: unknown): href is string {
  if (typeof href !== 'string') return false
  try {
    const u = new URL(href)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}
