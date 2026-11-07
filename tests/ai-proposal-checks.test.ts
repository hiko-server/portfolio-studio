/**
 * Proposals that the card shows must be the ones an approval can apply and
 * must list what they bring (design §4.4, §4.5, §5.3):
 *
 *   - propose_cv_edit checks what the approval will save. The approval saves
 *     both languages and the save checks every language it is given
 *     (lib/contentOps/cv saveCvDoc); so when the language the ops leave
 *     alone holds an older value the CV check now refuses, the proposal is
 *     refused at once (INVALID_CV, naming the language and nothing of its
 *     content) instead of waiting on a card no approval can apply. Once the
 *     owner fixes that value, the same proposal waits and applies.
 *   - A home-page restore lists every external link it brings back, in
 *     full and flagged, as a CV restore and every other write do.
 *
 * The real tools through executeTool, the real change routes, the
 * editorial harness's throw-away store.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-proposal-checks', 'ai-proposal-checks-secret-0123456789abcdef0123456')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>
let w: Awaited<ReturnType<typeof storeWriters>>

const PERSONAL = { sessionName: 'personalInformation', headerName: 'Personal', firstName: 'Example', lastName: 'Person', introduction: 'Builds things.' }
const job = (uid: string, startDate: string) => ({ uid, jobTitle: 'Engineer', companyName: 'Example Co', startDate, endDate: '', jobDescription: 'Built things.', features: [], relatedSkills: [] })
const CV_VALID = {
  en: [PERSONAL, { sessionName: 'workExperience', headerName: 'Work', experiences: [job('job-a', '2024-01')] }],
  zh: [{ ...PERSONAL, headerName: '个人信息' }, { sessionName: 'workExperience', headerName: '工作', experiences: [job('job-z', '2023-05')] }],
}
// An older Chinese entry, hidden from visitors, whose start date the CV check of today refuses.
const CV_LEGACY_ZH = {
  ...CV_VALID,
  zh: [CV_VALID.zh[0], { ...CV_VALID.zh[1], experiences: [job('job-z', '2023-05'), { ...job('job-old', 'spring 2019'), isVisible: false }] }],
}

const HOME = {
  hero: { welcome: 'Hello', brand: 'Example Person', tagline: 'Builder', avatarUrl: '/uploads/avatar.webp' },
  socials: { github: 'https://github.com/example' },
  brands: [],
  quickAccess: [{ label: 'Blog', url: '/blog' }],
  photos: [],
}

before(async () => {
  await h.setup()
  w = await storeWriters()
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

const titleEdit = (version: string) => ({
  ops: [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Senior engineer"' }],
  base_version: version,
  rationale: 'The owner asked for the new title.',
})

test('propose_cv_edit is refused at once when the language it leaves alone holds a value the CV check refuses, since every approval saves both and would fail; fixed, it waits and applies', async () => {
  const store = await import('../lib/contentStore')
  await w.kv('cvdata', CV_LEGACY_ZH)
  const before = JSON.stringify(store.getKv('cvdata'))
  const { getAiDb } = await import('../lib/ai/db')
  const rows = () => (getAiDb().prepare("SELECT count(*) AS n FROM ai_changes WHERE kind = 'cv.edit'").get() as { n: number }).n
  const rowsBefore = rows()
  // The save the approval runs would refuse this document: proof the old card could never apply.
  const { saveCvDoc } = await import('../lib/contentOps/cv')
  const merged = JSON.parse(before) as { en: Array<Record<string, any>>; zh: Array<Record<string, any>> }
  merged.en[1] = { ...merged.en[1], experiences: [{ ...merged.en[1].experiences[0], jobTitle: 'Senior engineer' }] }
  const save = await saveCvDoc({ en: merged.en, zh: merged.zh }, { version: (await tools.data('get_cv', {}, 'draft')).version }, { log: (await import('../lib/log')).log })
  assert.deepEqual([save.ok, save.ok ? null : save.code], [false, 'INVALID_CV'], 'the approval’s save refuses it')
  assert.equal(JSON.stringify(store.getKv('cvdata')), before)

  const refused = await tools.call('propose_cv_edit', titleEdit((await tools.data('get_cv', {}, 'propose')).version), 'propose', { grant: tools.grantAt('propose') })
  assert.equal(refused.code, 'INVALID_CV', refused.text)
  assert.equal(refused.json.error.language, 'zh')
  assert.match(refused.json.error.message, /^The Chinese CV, which this change does not touch, holds a value the CV check now refuses\. An approval saves both languages/)
  assert.doesNotMatch(refused.text, /spring 2019|job-old|#2|Start date/i, 'nothing of the untouched language’s content, hidden entries included')
  assert.equal(rows(), rowsBefore, 'no card')
  assert.equal(JSON.stringify(store.getKv('cvdata')), before, 'nothing written')

  // The owner fixes the old entry: the same proposal waits, and the approval applies it.
  await w.kv('cvdata', { ...CV_LEGACY_ZH, zh: [CV_LEGACY_ZH.zh[0], { ...CV_LEGACY_ZH.zh[1], experiences: [job('job-z', '2023-05'), { ...job('job-old', '2019-03'), isVisible: false }] }] })
  const waiting = await tools.call('propose_cv_edit', titleEdit((await tools.data('get_cv', {}, 'propose')).version), 'propose', { grant: tools.grantAt('propose') })
  assert.equal(waiting.json?.status, 'waiting_for_owner', waiting.text)
  const approved = await routes.approve(waiting.json.change_id)
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body))
  const saved = store.getKv('cvdata') as { en: Array<Record<string, any>> }
  assert.equal(saved.en[1].experiences[0].jobTitle, 'Senior engineer')

  // The language it touches is checked as before, with its own words.
  const bad = await tools.call(
    'propose_cv_edit',
    { ops: [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'startDate', value_json: '"next year"' }], base_version: (await tools.data('get_cv', {}, 'propose')).version, rationale: 'r' },
    'propose',
    { grant: tools.grantAt('propose') },
  )
  assert.equal(bad.code, 'INVALID_CV', bad.text)
  assert.equal(bad.json.error.language, undefined)
})

test('a home-page restore lists every external link it brings back, in full and flagged, and the card shows it', async () => {
  const store = await import('../lib/contentStore')
  const home = await import('../lib/home')
  // The version in the history had a booking link and a quick link the current home page no longer has.
  await w.kv('home', { ...HOME, quickAccess: [...HOME.quickAccess, { label: 'Talk', url: 'https://calendar.example.com/book?ref=old-campaign' }], socials: { github: 'https://github.com/example', gitlab: 'gitlab.example.com/someone' } })
  const file = home.saveHomeSnapshot()
  await store.putKv('home', HOME)
  const out = await tools.call('propose_restore', { collection: 'home', filename: file, base_version: (await tools.data('get_home', {}, 'propose')).version, rationale: 'Bring the old page back.' }, 'propose', { grant: tools.grantAt('propose') })
  assert.equal(out.json?.status, 'waiting_for_owner', out.text)
  assert.equal(out.json.new_links, 2)
  const card = await routes.card(out.json.change_id)
  assert.equal(card.statusCode, 200)
  assert.deepEqual(
    card.body.preview.newLinks.map((l: { url: string; flags: string[] }) => [l.url, l.flags.includes('query')]).sort(),
    [
      ['https://calendar.example.com/book?ref=old-campaign', true],
      ['https://gitlab.example.com/someone', false],
    ],
  )
  // A link the page already has is not new.
  assert.equal(card.body.preview.newLinks.some((l: { url: string }) => l.url === 'https://github.com/example'), false)
})
