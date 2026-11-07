/**
 * The merge of M4 (the assistant) with M2/M3 (writes, proposals, approval):
 * the assistant's writes go through the same sinks and the same approval
 * routes as a connected app's, and its changes belong to its conversation.
 *
 *   - A draft and a proposal written by a run are ai_changes rows with the
 *     conversation, the provider (the owner's label for the key), the model
 *     and the session that started the run; the proposal waits, its
 *     review_url is the admin page, and the run's stream announces it.
 *   - The owner approves it through POST /api/admin/ai/changes/<id>/approve,
 *     exactly as an app's: the draft goes live.
 *   - A later run of the same conversation sees both changes through
 *     get_change and list_my_changes, and is told of the decision once;
 *     another conversation gets the answer an unknown id gets.
 *   - The caps on waiting changes and created drafts count per conversation,
 *     whichever run made them.
 *   - Under "Don't keep", starting another conversation deletes this one:
 *     its waiting proposal stays approvable (the row names its issuer), the
 *     model's rationale goes with the conversation, and signing out the
 *     browser that issued it still voids it.
 *   - A change that expired is told once, whether or not a read stored the
 *     expiry first.
 *
 * tests/helpers/fake-llm.mjs as an ordinary Custom provider, the real tools
 * through the real loop, the real change routes on the editorial harness.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { assistantHarness } from './helpers/assistantHarness'
import { storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const A = assistantHarness('ai-assistant-changes')
let runs: typeof import('../lib/ai/runs')
let bus: typeof import('../lib/ai/bus')
let settings: typeof import('../lib/ai/settings')
let aiDb: typeof import('../lib/ai/db')
let routes: Awaited<ReturnType<typeof changeRoutes>>

const PROVIDER_LABEL = 'Test model (scripted)'
const ALL = new Set(['content:read', 'content:draft', 'content:propose'] as const)

before(async () => {
  await A.setup()
  runs = await import('../lib/ai/runs')
  bus = await import('../lib/ai/bus')
  settings = await import('../lib/ai/settings')
  aiDb = await import('../lib/ai/db')
  const w = await storeWriters()
  await w.page('now', { title: 'Now' }, 'Doing things.')
  routes = await changeRoutes(A.h)
})
after(async () => {
  await A.teardown()
})
beforeEach(async () => {
  A.fake.reset()
  settings.writeAiSettings({ enabled: true, autoApplyDrafts: true, keepConversationsDays: 90 }, { steppedUp: true })
  await runs.activeRun()?.done
})

type Ev = { seq: number; type: string; data: Record<string, any> }

async function run(input: Partial<import('../lib/ai/runs').StartInput>) {
  const started = await runs.startRun({ session: A.session(), message: 'Hello', ...input })
  assert.ok(started.ok, JSON.stringify(started))
  const events: Ev[] = []
  const sub = bus.subscribe(started.run.id, 0, (e) => events.push(e as Ev))
  for (const e of sub!.replay) events.push(e as Ev)
  await started.run.done
  sub!.stop()
  return { runId: started.run.id, conversationId: started.conversation.id, events, end: events.find((e) => e.type === 'run_end') }
}

type Msg = { role: string; content: unknown; tool_call_id?: string }

/** The tool results the model was sent in a request, parsed. */
function toolResults(req: { body: unknown }): any[] {
  return ((req.body as { messages: Msg[] }).messages ?? []).filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)))
}

/** The last user turn's text in a request (the server's site facts, then the owner's words). */
function lastUserText(req: { body: unknown }): string {
  const msgs = (req.body as { messages: Msg[] }).messages
  return String(msgs.filter((m) => m.role === 'user').at(-1)!.content)
}

function rowOf(id: string) {
  return aiDb
    .getAiDb()
    .prepare('SELECT id, state, kind, tool, actor_kind, actor_id, actor_label, provider, model, conversation_id, issuer_session, rationale, error_code FROM ai_changes WHERE id = ?')
    .get(id) as Record<string, any>
}

test('an assistant’s draft and proposal are its conversation’s rows; the owner approves the proposal through the same route as an app’s; the next run sees both and hears the decision once', async () => {
  // Run 1: a draft, applied at once.
  A.fake.enqueue(
    { toolCalls: [{ name: 'create_draft', args: { collection: 'blog', slug: 'assistant-notes', frontmatter: { title: 'Assistant notes', date: '2026-06-01' }, body: 'Notes the assistant drafted.' } }] },
    { text: 'Drafted.' },
  )
  const first = await run({ message: 'Draft a short post.' })
  assert.equal(first.end?.data.state, 'finished', JSON.stringify(first.end))
  const draft = toolResults(A.fake.requests.at(-1)!)[0]
  assert.match(draft.change_id, /^ch_[a-z2-7]{16}$/, JSON.stringify(draft))
  const draftRow = rowOf(draft.change_id)
  assert.deepEqual(
    [draftRow.state, draftRow.kind, draftRow.actor_kind, draftRow.actor_id, draftRow.conversation_id, draftRow.provider, draftRow.model, draftRow.issuer_session, draftRow.actor_label],
    ['applied', 'item.create', 'assistant', first.runId, first.conversationId, PROVIDER_LABEL, 'fake-model', A.sessionId, `${PROVIDER_LABEL} · fake-model`],
  )
  assert.ok(first.events.some((e) => e.type === 'change' && e.data.id === draft.change_id), 'the stream names the change')

  // Run 2, same conversation: the model proposes publishing it with the version the draft returned.
  A.fake.enqueue(
    (req: { body: unknown }) => {
      const version = toolResults(req).find((r) => r.change_id === draft.change_id)?.version
      return { toolCalls: [{ name: 'propose_publishing', args: { collection: 'blog', slug: 'assistant-notes', action: 'publish', base_version: version, rationale: 'The owner asked to publish it.' } }] }
    },
    { text: 'Proposed: it waits for you.' },
  )
  const second = await run({ conversationId: first.conversationId, message: 'Publish it.' })
  assert.equal(second.end?.data.state, 'finished', JSON.stringify(second.end))
  const proposal = toolResults(A.fake.requests.at(-1)!).at(-1)
  assert.equal(proposal.status, 'waiting_for_owner', JSON.stringify(proposal))
  assert.equal(proposal.review_url, `/admin/ai/change/${proposal.change_id}`, 'the assistant’s review link is the admin page')
  const change = second.events.find((e) => e.type === 'change' && e.data.id === proposal.change_id)
  assert.deepEqual(change?.data, { id: proposal.change_id, status: 'waiting_for_owner', tool: 'propose_publishing' })
  const waiting = rowOf(proposal.change_id)
  assert.deepEqual(
    [waiting.state, waiting.kind, waiting.actor_id, waiting.conversation_id, waiting.provider, waiting.model, waiting.issuer_session, waiting.rationale],
    ['waiting', 'item.publish', second.runId, first.conversationId, PROVIDER_LABEL, 'fake-model', A.sessionId, 'The owner asked to publish it.'],
  )
  const { readOne } = await import('../lib/mdx-admin')
  assert.equal(readOne('blog', 'assistant-notes')?.frontmatter.draft, true, 'nothing public until the owner approves')

  // The owner's card and approval: the same route as an app's change.
  const card = await routes.card(proposal.change_id)
  assert.equal(card.statusCode, 200)
  assert.deepEqual([card.body.actor.kind, card.body.actor.provider, card.body.actor.model], ['assistant', PROVIDER_LABEL, 'fake-model'])
  assert.equal('issuer_session' in card.body, false, 'the browser never sees a session id')
  const approved = await routes.approve(proposal.change_id)
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body))
  assert.equal(rowOf(proposal.change_id).state, 'applied')
  assert.notEqual(readOne('blog', 'assistant-notes')?.frontmatter.draft, true, 'live now')

  // Run 3, same conversation: both changes are its own, and the decision is told once.
  A.fake.enqueue({ toolCalls: [{ name: 'list_my_changes', args: {} }, { name: 'get_change', args: { change_id: proposal.change_id } }] }, { text: 'Both done.' })
  const third = await run({ conversationId: first.conversationId, message: 'What became of it?' })
  assert.equal(third.end?.data.state, 'finished')
  const firstOfThird = A.fake.requests.at(-2)!
  assert.match(lastUserText(firstOfThird), new RegExp(`Change ${proposal.change_id} \\(Publish post assistant-notes\\) was applied\\.`))
  const [list, got] = toolResults(A.fake.requests.at(-1)!).slice(-2)
  assert.deepEqual(
    list.items.map((r: any) => [r.change_id, r.state, r.action]),
    [
      [proposal.change_id, 'applied', 'item.publish'],
      [draft.change_id, 'applied', 'item.create'],
    ],
  )
  assert.deepEqual([got.change_id, got.state, got.public_urls.includes('/blog/assistant-notes')], [proposal.change_id, 'applied', true])

  // Run 4: told once only.
  A.fake.enqueue({ text: 'Nothing new.' })
  await run({ conversationId: first.conversationId, message: 'Anything else?' })
  assert.doesNotMatch(lastUserText(A.fake.requests.at(-1)!), new RegExp(proposal.change_id))

  // Another conversation: the same answer as an unknown id, byte for byte.
  A.fake.enqueue({ toolCalls: [{ name: 'get_change', args: { change_id: proposal.change_id } }, { name: 'get_change', args: { change_id: 'ch_aaaaaaaaaaaaaaaa' } }] }, { text: 'Not mine.' })
  const other = await run({ message: 'Look up that change.' })
  assert.notEqual(other.conversationId, first.conversationId)
  const msgs = (A.fake.requests.at(-1)!.body as { messages: Msg[] }).messages.filter((m) => m.role === 'tool')
  assert.equal(msgs.length, 2)
  assert.equal(JSON.parse(String(msgs[0].content)).error.code, 'NOT_FOUND')
  assert.equal(msgs[0].content, msgs[1].content, 'a change of another conversation answers like an unknown id')
})

test('the caps on waiting changes and created drafts count per conversation, whichever run made them', async () => {
  const { executeTool } = await import('../lib/ai/execute')
  const actor = (runId: string, conversationId: string) => ({ kind: 'assistant' as const, runId, conversationId, sessionId: A.sessionId, provider: PROVIDER_LABEL, model: 'fake-model' })
  const call = async (name: string, args: Record<string, unknown>, who: ReturnType<typeof actor>) =>
    JSON.parse((await executeTool(name, args, { actor: who, scopes: ALL, origin: { ipPrefix: null, country: null }, era: null, requestId: null, signal: new AbortController().signal })).text)
  const db = aiDb.getAiDb()
  db.prepare("UPDATE ai_changes SET state = 'rejected' WHERE state = 'waiting'").run()
  const version = (await call('get_content', { collection: 'page', ref: 'now', include_body: false }, actor('r_capprobe', 'c_capprobe'))).version
  assert.equal(typeof version, 'string')
  // Ten waiting changes, each from another run of one conversation.
  for (let i = 0; i < 10; i++) {
    const out = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: `Version ${i}.` }, base_version: version, rationale: 'r' }, actor(`r_cap_${i}`, 'c_cap_one'))
    assert.equal(out.status, 'waiting_for_owner', JSON.stringify(out))
  }
  const eleventh = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Eleventh.' }, base_version: version, rationale: 'r' }, actor('r_cap_new', 'c_cap_one'))
  assert.deepEqual([eleventh.error?.code, eleventh.error?.budget], ['BUDGET', 'waitingPerGrant'], 'a new run of the same conversation shares its cap')
  const otherConversation = await call('propose_page_edit', { name: 'now', frontmatter_patch: { description: 'Elsewhere.' }, base_version: version, rationale: 'r' }, actor('r_cap_other', 'c_cap_two'))
  assert.equal(otherConversation.status, 'waiting_for_owner', 'another conversation has its own')
  db.prepare("UPDATE ai_changes SET state = 'rejected' WHERE state = 'waiting'").run()
  // Created drafts: the conversation's, whichever run made them (the cap reads the same rows).
  const { createdDraftTargets } = await import('../lib/ai/changes')
  const made = await call('create_draft', { collection: 'blog', slug: 'cap-draft-a', frontmatter: { title: 'A', date: '2026-06-01' }, body: 'A.' }, actor('r_cap_d1', 'c_cap_three'))
  assert.equal(typeof made.change_id, 'string', JSON.stringify(made))
  assert.deepEqual(createdDraftTargets(actor('r_cap_d2', 'c_cap_three')), [{ collection: 'blog', slug: 'cap-draft-a' }])
  assert.deepEqual(createdDraftTargets(actor('r_cap_d1', 'c_cap_four')), [])
})

test('"Don’t keep": the next conversation deletes this one, yet its waiting proposal stays approvable without the model’s rationale; signing out the browser that issued one voids it', async () => {
  // A proposal from conversation one.
  const pageEdit = async (description: string) => {
    A.fake.enqueue({ toolCalls: [{ name: 'get_content', args: { collection: 'page', ref: 'now', include_body: false } }] }, (req: { body: unknown }) => {
      const version = toolResults(req).at(-1).version
      return { toolCalls: [{ name: 'propose_page_edit', args: { name: 'now', frontmatter_patch: { description }, base_version: version, rationale: `Because: ${description}` } }] }
    }, { text: 'Proposed.' })
    const r = await run({ message: `Set the description to ${description}` })
    const out = toolResults(A.fake.requests.at(-1)!).at(-1)
    assert.equal(out.status, 'waiting_for_owner', JSON.stringify(out))
    return { ...r, changeId: out.change_id as string }
  }
  const one = await pageEdit('Kept after the chat is gone.')
  settings.writeAiSettings({ keepConversationsDays: 0 }, { steppedUp: false })
  A.fake.enqueue({ text: 'Fresh start.' })
  const two = await run({ message: 'Something else.' })
  const conversations = await import('../lib/ai/conversations')
  assert.equal(conversations.getConversation(one.conversationId), null, 'conversation one is gone')
  assert.equal((aiDb.getAiDb().prepare('SELECT count(*) AS n FROM ai_runs WHERE conversation_id = ?').get(one.conversationId) as { n: number }).n, 0, 'with its runs')
  const kept = rowOf(one.changeId)
  assert.deepEqual([kept.state, kept.conversation_id, kept.issuer_session, kept.rationale], ['waiting', one.conversationId, A.sessionId, null])
  const approved = await routes.approve(one.changeId)
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body))
  assert.equal(rowOf(one.changeId).state, 'applied')
  const { readPage } = await import('../lib/mdx-admin')
  assert.equal(readPage('now').frontmatter.description, 'Kept after the chat is gone.')

  // A proposal whose issuing browser is signed out is voided at approval, conversation or not.
  settings.writeAiSettings({ keepConversationsDays: 90 }, { steppedUp: true })
  const three = await pageEdit('Never applied.')
  assert.notEqual(three.conversationId, two.conversationId)
  const sessions = await import('../lib/adminAuth/sessions')
  const other = sessions.createSession({ method: 'password', ttlMs: 3_600_000, device: 'Firefox on Linux', ipPrefix: '192.0.2.0/24', country: 'NL' })
  aiDb.getAiDb().prepare('UPDATE ai_changes SET issuer_session = ? WHERE id = ?').run(other.id, three.changeId)
  sessions.revokeSession(other.id, 'test')
  const refused = await routes.approve(three.changeId)
  assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
  assert.deepEqual([rowOf(three.changeId).state, rowOf(three.changeId).error_code], ['voided', 'ISSUER_ENDED'])
  assert.equal(readPage('now').frontmatter.description, 'Kept after the chat is gone.')
})

test('a change that ran out is told once in the next turn, whether or not a read stored the expiry first', async () => {
  A.fake.enqueue({ text: 'Hello.' })
  const first = await run({ message: 'Start.' })
  const db = aiDb.getAiDb()
  const insert = db.prepare(
    `INSERT INTO ai_changes (id, state, risk, tool, kind, actor_kind, actor_id, actor_label, issuer_version, conversation_id, target_kind, target_ref, title, args_sha256, preview_sha256, created_at, expires_at)
     VALUES (?, 'waiting', 'live', 'propose_page_edit', 'page.edit', 'assistant', ?, 'x', 0, ?, 'page', 'now', ?, 'a', 'b', ?, ?)`,
  )
  const now = Date.now()
  insert.run('ch_expiredreadbyowner', first.runId, first.conversationId, 'Edit page now (read)', now - 1000, now + 5)
  insert.run('ch_expiredneverreadd', first.runId, first.conversationId, 'Edit page now (unread)', now - 1000, now + 5)
  await new Promise((r) => setTimeout(r, 20))
  // The owner opened one card after it ran out: the read stored `expired`.
  const { expireIfDue } = await import('../lib/ai/changes')
  assert.equal(expireIfDue('ch_expiredreadbyowner'), true)
  A.fake.enqueue({ text: 'Noted.' })
  await run({ conversationId: first.conversationId, message: 'Next.' })
  const told = lastUserText(A.fake.requests.at(-1)!)
  assert.match(told, /Change ch_expiredreadbyowner \(Edit page now \(read\)\) expired without a decision\./)
  assert.match(told, /Change ch_expiredneverreadd \(Edit page now \(unread\)\) expired without a decision\./)
  // Stored later or not, neither is told again.
  assert.equal(expireIfDue('ch_expiredneverreadd'), true)
  A.fake.enqueue({ text: 'Quiet.' })
  await run({ conversationId: first.conversationId, message: 'And now?' })
  assert.doesNotMatch(lastUserText(A.fake.requests.at(-1)!), /ch_expired/)
  db.prepare("DELETE FROM ai_changes WHERE id LIKE 'ch_expired%'").run()
})
