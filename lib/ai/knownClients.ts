import type { PairingApp } from './settings'

/**
 * Known OAuth clients (SERVER-ONLY, design §6.4): exact
 * (client_id, redirect_uri) pairs, each added only after a real run of that
 * client showed it. A pair here lets the consent page skip the typed
 * hostname, and an app with pairs here owns its pairing window: a window
 * opened for that app accepts no other client_id.
 *
 * Exact pairs, never hosts: a host-level list would pass any open redirect
 * or relay on that host (`https://vscode.dev/redirect` is one, and stays
 * out), and under DCR the requester writes the redirect list itself, so a
 * DCR client is never known. Loopback redirect URIs match on any port
 * (lib/ai/oauth redirectMatches), as RFC 8252 asks for native apps.
 *
 * Ships with one entry, Claude Code: its client document at
 * https://claude.ai/oauth/claude-code-client-metadata (fetched and matched,
 * 317 bytes, auth method `none`) lists exactly these two redirect URIs.
 * Pairs for claude.ai, ChatGPT and VS Code's loopback URI are added at the
 * first hosted test (§12.5), from what those clients actually send; until
 * then they take the typed-host path.
 */

export type KnownClient = {
  /** Which setup tab (and pairing window) the client belongs to. */
  app: PairingApp
  /** The name Connections and the consent page give it. */
  label: string
  clientId: string
  redirectUris: readonly string[]
}

export const KNOWN_CLIENTS: readonly KnownClient[] = Object.freeze([
  Object.freeze({
    app: 'claude-code',
    label: 'Claude Code',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirectUris: Object.freeze(['http://localhost/callback', 'http://127.0.0.1/callback']),
  }),
])

/** The known clients of a setup tab: when there are any, its window takes no other client_id. */
export function knownClientsFor(app: PairingApp): readonly KnownClient[] {
  return KNOWN_CLIENTS.filter((c) => c.app === app)
}

/** The known client with exactly this client_id, or null. */
export function knownClient(clientId: string): KnownClient | null {
  return KNOWN_CLIENTS.find((c) => c.clientId === clientId) ?? null
}
