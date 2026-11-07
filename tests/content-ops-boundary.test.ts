/**
 * F1 — what the content services may reach, read from the source:
 *
 *   - the draft-safe writes (lib/contentOps/drafts) have no path to the
 *     public site: no refresh, no posters, no live writer, no route;
 *   - the services never import a route or a client folder, and the module
 *     graph around them has no cycle;
 *   - every capability behind a step-up (requireRecentAuth, requireFreshAuth) is enumerated,
 *     so a later tool for it can be checked against the list;
 *   - the checks a route made before calling the store travelled into the
 *     service with the write, and the routes no longer write past them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { ROOT, cyclesFrom, localImports, reachable, rel } from './helpers/importGraph'

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const parse = (file: string) =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** Every node under `node`, depth first. */
function each(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => each(child, visit))
}

/** Every identifier a module's code names (comments and strings are not code). */
function identifiersOf(file: string): Set<string> {
  const out = new Set<string>()
  each(parse(file), (n) => {
    if (ts.isIdentifier(n)) out.add(n.text)
  })
  return out
}

/** Names of plain function calls (`name(…)`) under `node`; `filter` picks which nodes count. */
function callsUnder(node: ts.Node, filter: (n: ts.CallExpression) => boolean = () => true): string[] {
  const out: string[] = []
  each(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && filter(n)) out.push(n.expression.text)
  })
  return out
}

const SERVICES = ['lib/contentOps/drafts.ts', 'lib/contentOps/items.ts', 'lib/contentOps/media.ts', 'lib/contentOps/refresh.ts', 'lib/contentOps/rules.ts']

test('draft-safe writes have no path to the public site', () => {
  const direct = localImports(path.join(ROOT, 'lib/contentOps/drafts.ts')).map(rel)
  for (const banned of [
    'lib/contentOps/items.ts',
    'lib/contentOps/refresh.ts',
    'lib/collectionApi.ts',
    'lib/revalidate.ts',
    'lib/videoPoster.ts',
    'lib/slugRename.ts',
    'lib/schedule/scheduler.ts',
    'lib/editorialEvents.ts',
    'lib/mailer.ts',
  ]) {
    assert.ok(!direct.includes(banned), `lib/contentOps/drafts.ts must not import ${banned}`)
  }
  assert.ok(direct.every((f) => f.startsWith('lib/')), `drafts imports only lib/: ${direct.join(', ')}`)
  // No writer that publishes, ends a schedule, regenerates a page or changes an address.
  const names = identifiersOf('lib/contentOps/drafts.ts')
  for (const name of [
    'revokeLinksAt',
    'revokeItemLinks',
    'forgetRedirectFrom',
    'removeRedirect',
    'ensurePosters',
    'refreshCollection',
    'revalidatePaths',
    'deletePendingRevision',
    'deleteOne',
    'removeItem',
    'putItem',
    'applySchedule',
    'rearmPublishScheduler',
    'emitEditorialEvent',
    'mdxProblem',
    'compileMdx',
  ]) {
    assert.ok(!names.has(name), `lib/contentOps/drafts.ts names ${name}`)
  }
})

test('what the draft-safe writes load never reaches visitor data, mail or share links', () => {
  // The same list the AI tools' boundary keeps (design §12.1): visitor text, analytics, error reports, logs, backups, mail, CV share links.
  const forbidden = /^lib\/(inbox|analytics\/|errors\/|logBuffer|backup|mailer|cvShare\/)/
  const all = reachable(['lib/contentOps/drafts.ts'])
  const hits = Array.from(all.entries())
    .filter(([f]) => forbidden.test(f))
    .map(([, chain]) => chain.join(' -> '))
  assert.deepEqual(hits, [])
  assert.ok(all.has('lib/mdx-admin.ts') && all.has('lib/review/store.ts'), 'sanity: the walk follows imports')
})

test('the services and the collection API import no route, no client folder, and sit in no import cycle', () => {
  for (const file of [...SERVICES, 'lib/collectionApi.ts', 'lib/mdx-admin.ts', 'lib/cvDocOps.ts', 'lib/frontmatterMerge.ts', 'lib/security/forwardedScheme.ts']) {
    for (const dep of localImports(path.join(ROOT, file)).map(rel)) {
      assert.ok(!dep.startsWith('pages/') && !dep.startsWith('components/'), `${file} imports ${dep}`)
    }
  }
  assert.deepEqual(cyclesFrom([...SERVICES, 'lib/collectionApi.ts', 'lib/mdx-admin.ts', 'lib/apiHandler.ts', 'lib/audit/capture.ts']), [])
})

// ── Step-up capabilities ─────────────────────────────────────────────────────

/** Names a module imports from the repo's own modules as values. */
function localValueNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || st.importClause?.isTypeOnly) continue
    if (!ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue
    const bindings = st.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (!el.isTypeOnly) names.add(el.name.text)
    if (st.importClause?.name) names.add(st.importClause.name.text)
  }
  return names
}

/**
 * The repo functions that can run once a step-up check passed: the calls
 * after it in its statement and in the statements after that one in its
 * block — and when there are none (`if (…) { ctx = requireRecentAuth(…);
 * if (!ctx) return }`), the statements after the block's own statement,
 * one block further out.
 */
function callsAfter(sf: ts.SourceFile, call: ts.CallExpression): string[] {
  const names = localValueNames(sf)
  const keep = (n: ts.CallExpression) => names.has((n.expression as ts.Identifier).text) && n.pos >= call.end
  let node: ts.Node = call
  for (;;) {
    let child: ts.Node = node
    let parent: ts.Node | undefined = node.parent
    while (parent && !ts.isBlock(parent) && !ts.isSourceFile(parent)) {
      child = parent
      parent = parent.parent
    }
    if (!parent) return []
    const statements = (parent as ts.Block | ts.SourceFile).statements
    const found = new Set(callsUnder(child, keep))
    for (const st of statements.slice(statements.indexOf(child as ts.Statement) + 1)) for (const name of callsUnder(st, keep)) found.add(name)
    if (found.size || ts.isSourceFile(parent)) return Array.from(found).sort()
    node = parent
  }
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

function stepUpSites(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const file of [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'pages'))]) {
    const name = rel(file)
    const src = fs.readFileSync(file, 'utf8')
    if (name === 'lib/adminAuth/stepUp.ts' || !(src.includes('requireRecentAuth(') || src.includes('requireFreshAuth('))) continue
    const sf = parse(name)
    let n = 0
    each(sf, (node) => {
      // requireFreshAuth is the stricter gate (a verification within 2 minutes, design §5.2): a step-up all the same.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'requireRecentAuth' || node.expression.text === 'requireFreshAuth'))
        out[`${name}#${++n}`] = callsAfter(sf, node)
    })
  }
  return out
}

/**
 * Every place a write needs a recent sign-in or step-up, what can run past
 * it, and the AI tool that may reach the same capability (null: none may,
 * design §1 non-goals). A new step-up, or a new call behind one, fails here
 * until it is listed — and a tool listed here must be `destructive`.
 */
const STEP_UP: Record<string, { calls: string[]; capability: string; tool: string | string[] | null }> = {
  'lib/collectionApi.ts#1': { calls: ['deleteItem', 'refreshCollection'], capability: 'delete a post or case study', tool: 'propose_delete' },
  // Approving a destructive AI change (an unpublish, a restore, a delete) needs the same recent sign-in as doing it
  // by hand: the tools that can propose one are the destructive kinds (design §4.2, §5.3).
  'pages/api/admin/ai/changes/[id]/approve.ts#1': {
    calls: ['approveChange', 'emitEditorialEvent', 'ownerMail', 'readAdminClaims', 'requestOrigin'],
    capability: 'approve a destructive AI change: unpublish, restore a version, delete',
    tool: ['propose_delete', 'propose_publishing', 'propose_restore'],
  },
  // AI settings and connected apps' tokens: §1 non-goals ("AI settings", "tokens"), so no tool, approved or not.
  // Model provider keys: §1 non-goals ("API keys"), so no tool. Adding or replacing a key (and with it the address it goes to),
  // and Check key / Test with a typed key on a Custom URL (an outbound request a stolen cookie must not get).
  'pages/api/admin/ai/providers/index.ts#1': {
    calls: ['addProvider', 'aiAlert', 'cleanApiKey', 'cleanEffort', 'cleanLabel', 'cleanModel', 'defaultProviderId', 'parseOwnerQuirks', 'providerView', 'recordAdminAudit', 'setDefaultProvider', 'takeTypedProbe', 'typedProbeKey'],
    capability: 'add a model provider key',
    tool: null,
  },
  'pages/api/admin/ai/providers/index.ts#2': {
    calls: ['aiAlert', 'cleanApiKey', 'defaultProviderId', 'presetOf', 'providerView', 'recordAdminAudit', 'replaceKey', 'resolveTarget'],
    capability: 'replace a model provider key, or the address it goes to',
    tool: null,
  },
  'pages/api/admin/ai/providers/models.ts#1': {
    calls: ['anthropicEnvProblem', 'createAdapter', 'openRowKey', 'quirksFor', 'quirksOf', 'takeMemory'],
    capability: 'list a Custom provider’s models with a typed key',
    tool: null,
  },
  'pages/api/admin/ai/providers/test.ts#1': {
    calls: ['anthropicEnvProblem', 'assistantTools', 'createAdapter', 'createScrubber', 'openRowKey', 'probeProvider', 'quirksFor', 'quirksOf', 'recordTest', 'rememberTypedProbe', 'takeMemory', 'typedProbeKey'],
    capability: 'test a Custom provider with a typed key',
    tool: null,
  },
  'pages/api/admin/ai/settings.ts#1': {
    calls: ['accessState', 'aiAlert', 'readAdminContext', 'recordAdminAudit', 'recordAuthEvent', 'requestOrigin', 'revokeGrants', 'stepUpRequired', 'stopAllRuns', 'writeAiSettings'],
    capability: 'turn on AI access or connected apps, or loosen an AI limit',
    tool: null,
  },
  'pages/api/admin/ai/tokens.ts#1': {
    calls: ['accessState', 'canonicalResource', 'createPersonalToken', 'recordAdminAudit', 'recordAuthEvent', 'requestOrigin'],
    capability: 'make a personal token for a connected app (a verification within 2 minutes)',
    tool: null,
  },
  // OAuth (stage M5): opening the pairing window loosens access (§5.2); allowing a consent issues a code
  // (a verification within 2 minutes, §6.4). Both are §1 non-goals for tools ("tokens", "AI settings").
  'pages/api/admin/ai/oauth/consent.ts#1': {
    calls: ['aiPublicOpen', 'checkAuthorizeRequest', 'isAccessLevel', 'issueCode', 'recordAdminAudit', 'typedHostMatches'],
    capability: 'allow an app to connect over OAuth (a verification within 2 minutes)',
    tool: null,
  },
  'pages/api/admin/ai/pairing.ts#1': {
    calls: ['accessState', 'openPairingWindow', 'recordAdminAudit', 'stepUpRequired'],
    capability: 'open the 10-minute window for one new OAuth connection',
    tool: null,
  },
  'pages/api/admin/cv-share-links.ts#1': { calls: ['createShareLink', 'recordAdminAudit', 'sharePagePath'], capability: 'make a CV share link', tool: null },
  'pages/api/admin/cv-share-links.ts#2': { calls: ['editShareLink', 'recordAdminAudit'], capability: 'extend a CV share link', tool: null },
  // The step-up guards only `purge`; moving to the trash and restoring share the branch without it. Purging is
  // last-copy destruction, a design non-goal (§1): no tool, approved or not. (propose_delete's image case moves an
  // upload to the trash, the restorable step that needs no step-up.)
  'pages/api/admin/media/index.ts#1': {
    calls: ['listLibrary', 'moveToTrash', 'purgeFromTrash', 'recordAdminAudit', 'restoreFromTrash'],
    capability: 'delete uploads for good (purge; the branch also trashes and restores)',
    tool: null,
  },
  'pages/api/admin/security/confirm.ts#1': { calls: ['recentAuthWindowMs'], capability: 'confirm a step-up', tool: null },
  'pages/api/admin/security/passkeys.ts#1': {
    calls: ['generateRecoveryCodes', 'passkeyCount', 'rateLimit', 'readAdmin', 'recordAuthEvent', 'recoveryStatus', 'registrationOptions', 'relyingPartyFor', 'requestOrigin', 'verifyRegistration'],
    capability: 'add a passkey',
    tool: null,
  },
  'pages/api/admin/security/passkeys.ts#2': {
    calls: ['deletePasskey', 'getPasskey', 'isPasskeyRequired', 'passkeyCount', 'recordAuthEvent', 'requestOrigin'],
    capability: 'remove a passkey',
    tool: null,
  },
  'pages/api/admin/security/password.ts#1': { calls: ['changePassword', 'moveCreatedSession'], capability: 'change the admin password', tool: null },
  'pages/api/admin/security/policy.ts#1': {
    calls: ['generateRecoveryCodes', 'isPasskeyRequired', 'passkeyCount', 'recordAuthEvent', 'recoveryStatus', 'requestOrigin', 'setPasskeyRequired'],
    capability: 'change the sign-in policy',
    tool: null,
  },
  'pages/api/admin/security/recovery-codes.ts#1': { calls: ['generateRecoveryCodes', 'recordAuthEvent', 'requestOrigin'], capability: 'make new recovery codes', tool: null },
  'pages/api/admin/security/sessions.ts#1': { calls: ['clearAdminCookies', 'endLegacyTokens', 'recordAuthEvent', 'revokeSession'], capability: 'sign out another browser', tool: null },
  'pages/api/admin/security/sessions.ts#2': {
    calls: ['bumpSessionVersion', 'clearAdminCookies', 'endLegacyTokens', 'listLiveSessions', 'recordAuthEvent', 'revokeSessionsExcept'],
    capability: 'sign out every browser',
    tool: null,
  },
  'pages/api/admin/storage/pull.ts#1': { calls: ['isR2Configured', 'restoreLatestFromR2', 'restoreLocalSnapshot', 'revalidatePaths'], capability: 'restore the site from a backup', tool: null },
  'pages/api/mongo.ts#1': {
    calls: [
      'collectionPaths',
      'getPage',
      'listItems',
      'putItem',
      'putPage',
      'readCvData',
      'readHome',
      'redactMongoSecrets',
      'refreshGithubData',
      'resolveMongoSrvUrl',
      'revalidatePaths',
      'saveHomeSnapshot',
      'saveSnapshot',
      'writeCvData',
      'writeHome',
    ],
    capability: 'change, restore from or send to a MongoDB backup target',
    tool: null,
  },
}

test('every capability behind a step-up is listed, with what runs past the check', () => {
  const found = stepUpSites()
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).sort()),
    Object.fromEntries(Object.entries(STEP_UP).map(([k, v]) => [k, v.calls]).sort()),
    'a step-up was added, moved or now guards other calls: update STEP_UP (and check the tool, if any, is destructive)',
  )
  // The tools named here are the design's destructive kinds (§4.2: propose_delete and propose_restore are
  // destructive, and propose_publishing's unpublish): deleting a post or case study by hand, and approving such a
  // change. Every other capability behind a step-up has no tool at all (§1 non-goals).
  const withTool = Object.entries(STEP_UP).filter(([, { tool }]) => tool !== null).map(([site, { tool }]) => [site, tool])
  assert.deepEqual(withTool, [
    ['lib/collectionApi.ts#1', 'propose_delete'],
    ['pages/api/admin/ai/changes/[id]/approve.ts#1', ['propose_delete', 'propose_publishing', 'propose_restore']],
  ])
  assert.equal(STEP_UP['pages/api/admin/media/index.ts#1'].tool, null, 'purging uploads has no tool')
})

// ── Checks that travelled with the writes ────────────────────────────────────

/** Names `fn` calls, directly or through the module's own function declarations it calls. */
function callsOf(file: string, fn: string): Set<string> {
  const sf = parse(file)
  const fns = new Map<string, ts.FunctionDeclaration>()
  for (const st of sf.statements) if (ts.isFunctionDeclaration(st) && st.name) fns.set(st.name.text, st)
  const calls = new Set<string>()
  const seen = new Set<string>()
  const visit = (name: string) => {
    const decl = fns.get(name)
    if (!decl || seen.has(name)) return
    seen.add(name)
    for (const called of callsUnder(decl)) {
      calls.add(called)
      visit(called)
    }
  }
  visit(fn)
  assert.ok(seen.has(fn), `${file} declares ${fn}`)
  return calls
}

/**
 * Each service and the checks it makes before writing — the checks its
 * route made before the extraction, and the ones its own guarantees need.
 * A tool built on a service gets them by calling it.
 */
const CARRIED: Array<{ file: string; fn: string; checks: string[] }> = [
  { file: 'lib/contentOps/items.ts', fn: 'saveItem', checks: ['isSafeSlug', 'mdxProblem', 'readOne', 'itemIfMatchAllows', 'isDraftFrontmatter', 'carryScheduleOnSave'] },
  { file: 'lib/contentOps/items.ts', fn: 'publishItem', checks: ['isSafeSlug', 'versionMissing', 'isDraftFrontmatter', 'saveItem'] },
  { file: 'lib/contentOps/items.ts', fn: 'unpublishItem', checks: ['isSafeSlug', 'versionMissing', 'isDraftFrontmatter', 'saveItem'] },
  { file: 'lib/contentOps/items.ts', fn: 'discardPending', checks: ['isSafeSlug', 'readOne', 'itemIfMatchAllows'] },
  { file: 'lib/contentOps/items.ts', fn: 'deleteItem', checks: ['isSafeSlug', 'itemIfMatchAllows'] },
  { file: 'lib/contentOps/media.ts', fn: 'saveMediaText', checks: ['isValidUploadName', 'isVariantName', 'assetExists'] },
  { file: 'lib/contentOps/drafts.ts', fn: 'createDraftItem', checks: ['isSafeSlug', 'missingField', 'readOne', 'redirectTarget', 'listReviewLinks', 'hasItemSnapshots'] },
  { file: 'lib/contentOps/drafts.ts', fn: 'saveDraftEdit', checks: ['isSafeSlug', 'missingField', 'itemEtag', 'heldReason', 'scheduleOf', 'listReviewLinks', 'carryScheduleOnSave'] },
]

test('the route-level checks travelled into the services', () => {
  for (const { file, fn, checks } of CARRIED) {
    const calls = callsOf(file, fn)
    for (const check of checks) assert.ok(calls.has(check), `${file} ${fn} calls ${check}`)
  }
})

test('the routes write items and image texts only through the services', () => {
  const api = identifiersOf('lib/collectionApi.ts')
  for (const writer of ['writeOne', 'deleteOne', 'putPendingRevision', 'deletePendingRevision', 'mdxProblem', 'ensurePosters', 'carryScheduleOnSave']) {
    assert.ok(!api.has(writer), `lib/collectionApi.ts calls ${writer} itself`)
  }
  const apiCalls = callsUnder(parse('lib/collectionApi.ts'))
  for (const call of ['saveItem', 'discardPending', 'deleteItem', 'refreshCollection']) assert.ok(apiCalls.includes(call), call)
  const media = identifiersOf('pages/api/admin/media/index.ts')
  assert.ok(!media.has('saveMediaMeta') && !media.has('assetExists'), 'the media route saves texts through saveMediaText only')
  assert.match(read('pages/api/admin/media/index.ts'), /saveMediaText\(\{ name, texts: body, expectedUpdatedAt: body\.expectedUpdatedAt \}\)/)
})
