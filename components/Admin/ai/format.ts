import { relativeTime } from '../security/securityFormat'

/**
 * Pure helpers of Admin → AI → Connections (unit tested in tests/ai-admin-ui).
 */

/**
 * How long ago a past moment was ("just now", "5 min. ago"). The server
 * stamps a moment a little after the page last read its own clock (a token
 * made a second ago), or on a clock slightly ahead of this browser's: a
 * past moment never reads as the future ("in a moment").
 */
export function sinceTime(at: number, now: number): string {
  return relativeTime(at, Math.max(now, at))
}

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
