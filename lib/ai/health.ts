import { getPublicHost } from '../env'
import { anthropicEnvProblem } from './providers/env'
import { aiKeysSecretStatus } from './secretBox'
import { aiAccess } from './settings'

/**
 * What the admin System panel says about the AI configuration (lib/
 * systemHealth). Server-side text only: the names of server settings never
 * ship in client code (scripts/perf-budget.mjs fails on them).
 */
export function aiHealthWarnings(): string[] {
  const out: string[] = []
  if ((process.env.AI_LOCAL_PROVIDER_ORIGINS ?? '').trim() && getPublicHost() !== null) {
    out.push('AI_LOCAL_PROVIDER_ORIGINS is set, but this site has a public host: local model providers are ignored.')
  }
  const secret = aiKeysSecretStatus()
  if (secret.state === 'invalid') out.push(`AI_KEYS_SECRET is set but unusable (${secret.reason}): model provider keys cannot be stored or opened.`)
  const access = aiAccess()
  if (access.on && access.settings.mcpEnabled && !(process.env.SITE_URL || '').trim()) {
    out.push('Connected apps are allowed, but SITE_URL is not set: /mcp stays closed until it is.')
  }
  const claude = anthropicEnvProblem()
  if (claude) out.push(claude)
  return out
}
