import type { AccessState, CatalogueTool, Risk } from './types'

/**
 * The words of Admin → AI (design §8, PRODUCT §9). English, like the rest
 * of the admin; kept here, in the shape of lib/ask/copy.ts, so a Chinese
 * admin is one file away. Voice: plain second person, curly quotes, no
 * exclamation marks; failure toasts are titled by outcome.
 *
 * Nothing here describes a capability the site does not have: what an access
 * level allows is worded from the live tool catalogue (levelSummary).
 */

export type AiLang = 'en'

/** The access levels of §5.1, by number (1 Read published … 3 Read, draft and propose). */
const LEVEL_NAMES = ['Read published', 'Read and draft', 'Read, draft and propose'] as const

export const AI_COPY = {
  lang: 'en' as const,
  page: {
    headTitle: 'Admin · AI',
    eyebrow: '[admin]',
    title: 'AI',
    loading: 'Loading AI access',
  },
  loadError: (detail: string) => `Couldn’t load AI access (${detail}).`,
  retry: 'Retry',
  copy: 'Copy',
  copied: 'Copied',
  copiedAnnouncement: (what: string) => `${what} copied to the clipboard.`,
  copyFailed: 'Couldn’t copy. The text is selected: copy it yourself.',

  strip: {
    label: 'AI status',
    access: 'Access',
    apps: 'Connected apps',
    on: 'On',
    off: 'Off',
    accessSub(a: AccessState): string {
      if (a.blocked === 'env') return 'held off on the server'
      if (a.blocked === 'unreadable') return 'settings can’t be read'
      if (!a.enabled) return 'nothing reaches the site through AI'
      if (!a.mcpEnabled) return 'connected apps aren’t allowed'
      if (!a.siteUrl) return 'SITE_URL isn’t set'
      return 'connected apps can read the site'
    },
    appsSub: (connected: number, lastUsedAgo: string | null) =>
      connected === 0 ? 'none yet' : lastUsedAgo ? `last call ${lastUsedAgo}` : 'no call yet',
  },

  access: {
    title: 'Access',
    hint: 'Nothing reaches the site through AI until you turn this on. Turning something on asks you to confirm it’s you; turning it off never does.',
    master: 'AI access',
    masterHelp:
      'The master switch. While it is off, nothing can read or change the site through AI, and the MCP address answers like a page that doesn’t exist.',
    apps: 'Allow connected apps',
    appsHelp: 'Apps such as Claude Code, Cursor or VS Code connect with a token you make below. While this is off, the MCP address doesn’t exist.',
    appsNeedsMaster: 'Turn on AI access first.',
    appsNeedsSiteUrl: 'Needs SITE_URL on the server.',
    stepUpMaster: 'Turning on AI access lets connected apps reach your content.',
    stepUpApps: 'Allowing connected apps opens the MCP address to anyone holding one of your tokens.',
    env: 'AI_DISABLED is set in the server’s environment, so AI access stays off whatever these switches say. Remove it from the server’s .env and restart to use them.',
    unreadable: 'The AI settings can’t be read right now, so AI access counts as off. The server log has the reason.',
    noSiteUrl:
      'SITE_URL isn’t set in the server’s environment. The MCP address and every token are tied to it, so connected apps stay closed until it is set.',
    turnedOn: 'AI access is on',
    turnedOff: 'AI access is off',
    appsAllowed: 'Connected apps allowed',
    appsStopped: 'Connected apps stopped',
    notChanged: 'Not changed',
    endedWith: (n: number) => (n === 1 ? 'The connected app was revoked.' : `All ${n} connected apps were revoked.`),
    endFailed:
      'The connected apps couldn’t be revoked. They’re refused while this is off, but would work again if you turned it back on: revoke them under Connected apps first.',
    offDialog: {
      title: 'Turn off AI access?',
      body: 'Connected apps are refused from their next request, and the MCP address answers like a page that doesn’t exist. Their tokens are kept: they work again when you turn AI access back on.',
      endApps: 'Also revoke every connected app',
      endAppsHelp: (n: number) =>
        `Ends ${n === 1 ? 'the connected app’s token' : `the tokens of all ${n} connected apps`} for good. To reconnect, make a new token.`,
      confirm: 'Turn off',
      cancel: 'Cancel',
    },
  },

  connect: {
    title: 'Connect an app',
    hint: 'Any app that speaks MCP over HTTP and can send a header connects with a personal token.',
    server: 'Server address',
    transport: 'Streamable HTTP',
    noServer: 'No address yet: SITE_URL isn’t set on the server.',
    localBanner:
      'This server is only reachable from this computer. Claude and ChatGPT connect from their clouds, so they can only reach this site once it is deployed. Claude Code, Cursor, VS Code and Codex can connect from here.',
    closed: 'Turn on AI access and allow connected apps above, then make a token here.',
    step1: 'Make a personal token for the app. It is shown once.',
    step2: (envVar: string) => `Add the server to your app with the token. For Claude Code, with the token in ${envVar}:`,
    step2Other: 'Any other app: the server address above, with the header',
    headerShape: 'Authorization: Bearer <token>',
    step3: 'Ask it “What’s on my site?”',
    newToken: 'New token',
    commandLabel: 'Claude Code command',
    waiting: (name: string) => `Waiting for the first call from “${name}”…`,
    connected: 'Connected.',
    firstCall: (ago: string) => `First call ${ago}.`,
    saysItIs: (name: string) => ` It says it is “${name}”.`,
  },

  apps: {
    title: 'Connected apps',
    hint: 'Every app that can reach the site with a token you made. Revoking works on its next request and never asks you to confirm it’s you.',
    empty: 'No apps connected yet.',
    revokeAll: 'Revoke all',
    token: 'Token',
    oauth: 'OAuth',
    tokenHint: (hint: string) => `pst_…${hint}`,
    saysItIs: (name: string) => `says it is “${name}”`,
    nameChanged: 'The name it gives itself changed',
    nameChangedWhy: '. Apps report their own names, so a change can mean another app is using this token.',
    lastUsed: 'last used',
    notUsed: 'not used yet',
    callsThisWeek: (n: number) => `${n.toLocaleString('en')} tool ${n === 1 ? 'call' : 'calls'} this week`,
    expires: 'expires',
    made: 'made',
    madeOn: (device: string | null, here: boolean) => ` on ${device || 'an unknown browser'}${here ? ', this browser' : ''}`,
    rename: 'Rename',
    revoke: 'Revoke',
    renameTitle: 'Rename app',
    nameLabel: 'Name',
    nameHelp: 'For example “Laptop” or “Cursor”.',
    save: 'Save',
    cancel: 'Cancel',
    revokeTitle: (name: string) => `Revoke “${name}”?`,
    revokeBody: 'It stops working on its next request and can’t be turned back on. To reconnect the app, make a new token.',
    revokeAllTitle: 'Revoke every connected app?',
    revokeAllBody: (n: number) =>
      `${n === 1 ? 'The app stops' : `All ${n} apps stop`} working on the next request. To reconnect one, make a new token.`,
    revoked: 'Token revoked',
    revokedAll: (n: number) => (n === 1 ? '1 app revoked' : `${n} apps revoked`),
    notRevoked: 'Not revoked',
    renamed: 'Renamed',
    notRenamed: 'Not renamed',
    firstCall: (name: string) => `“${name}” made its first call.`,
  },

  newToken: {
    eyebrow: '[new token]',
    title: 'New personal token',
    name: 'Name',
    nameHelp: 'For example “Laptop” or “Cursor”.',
    access: 'Access',
    expires: 'Expires after',
    expiresHelp: 'There is no “never”: make a new token when this one ends.',
    days: (n: number) => `${n} days`,
    defaultMark: ' (default)',
    create: 'Create token',
    creating: 'Creating…',
    cancel: 'Cancel',
    stepUp: 'A new token is a new way into the admin.',
    nameMissing: 'Give the token a name.',
    cancelled: 'Not created: the confirmation was closed. Your choices are still here.',
    headerLabel: 'Header',
    notCreated: 'Token not created',
    doneEyebrow: '[token]',
    doneTitle: 'Copy your token',
    once: 'This token is shown once. Only its fingerprint is stored here.',
    tokenLabel: 'Token',
    copyToken: 'Copy token',
    forClaudeCode: 'For Claude Code',
    copyCommand: 'Copy command',
    forOther: 'Any other app',
    otherHow: (server: string) => `Connect to ${server} with the header`,
    saved: 'I have saved this token somewhere safe',
    done: 'Done',
  },

  catalogue: {
    title: 'What apps can do',
    hint: 'The tools this server offers, from its own catalogue. An app sees only the tools its access level includes.',
    filter: 'Show tools for',
    everyLevel: 'Every level',
    tools: (n: number) => `${n} ${n === 1 ? 'tool' : 'tools'}`,
    fromLevel: (level: number) => `from ${levelName(level)}`,
    never:
      'No tool exists for security settings, sessions, passkeys, passwords, tokens, AI settings, API keys, backups, restoring from storage, MongoDB, the inbox, analytics, error reports, e-mail or the source code. An app can’t call what isn’t there.',
    empty: 'No tool at this level.',
  },
}

export type AiCopy = typeof AI_COPY

export function levelName(level: number): string {
  return LEVEL_NAMES[Math.min(LEVEL_NAMES.length, Math.max(1, level)) - 1]
}

/** Each risk as a group heading and what it means for the owner. */
export const RISK_COPY: Record<Risk, { title: string; means: string }> = {
  read: { title: 'Reading', means: 'Runs at once and changes nothing.' },
  draft: { title: 'Drafts', means: 'Applies at once, to drafts and unpublished changes only, with Undo. Visitors see nothing.' },
  live: { title: 'Proposals', means: 'Changes nothing until you approve it here.' },
  destructive: { title: 'Proposals that delete', means: 'Changes nothing until you approve it here, and asks you to confirm it’s you.' },
}

/**
 * What one access level lets an app do, worded from the tools that exist at
 * that level (never a capability the catalogue does not have), with the
 * count of tools an app at that level sees.
 */
export function levelSummary(level: number, tools: readonly CatalogueTool[]): { name: string; text: string; count: number } {
  const at = tools.filter((t) => t.level <= level)
  const added = tools.filter((t) => t.level === level)
  const has = (risks: Risk[]) => added.some((t) => risks.includes(t.risk))
  let text: string
  if (level <= 1) {
    text = 'Reads what visitors can see: posts, case studies, pages, the home page, the CV and media. Can’t change anything.'
  } else if (level === 2) {
    text = has(['draft'])
      ? 'Also reads drafts and unpublished changes, and saves drafts and unpublished changes. Visitors see nothing until you publish.'
      : 'Also reads drafts and unpublished changes. Visitors and review-link holders see none of it.'
  } else {
    text = has(['live', 'destructive'])
      ? 'Also proposes live changes. Each one waits for your approval here.'
      : 'Also allowed to propose live changes, but this site has no proposal tools yet: for now it is the same as Read and draft.'
  }
  return { name: levelName(level), text, count: at.length }
}
