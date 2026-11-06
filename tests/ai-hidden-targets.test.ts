/**
 * M3 — proposals can only target what the public view shows (design §4.3,
 * §4.4, §5.7, §12.1 ai-hidden-targets).
 *
 *   - A hidden photo and a hidden CV entry (with the predictable uid an entry
 *     stored without one gets) are not targets: the answer is exactly the
 *     answer to an unknown position or uid, and nothing is stored.
 *   - Lists with hidden items, a hidden author, the hidden-item mark itself,
 *     a hidden field, the contact fields no tool reads, visibility keys:
 *     refused.
 *   - Every approved home and CV change leaves every hidden value byte for
 *     byte as it was.
 *   - A change visitors would not see is refused (NO_VISIBLE_CHANGE); the
 *     whole highlights list only while every stored highlight is shown.
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { editorialHarness } from './editorialHarness'
import { aiToolCaller, storeWriters } from './helpers/aiTools'
import { changeRoutes } from './helpers/aiChanges'

const h = editorialHarness('ai-hidden-targets', 'ai-hidden-targets-secret-0123456789abcdef012345678')
let tools: Awaited<ReturnType<typeof aiToolCaller>>
let routes: Awaited<ReturnType<typeof changeRoutes>>

const HIDDEN_PHOTO = { url: '/uploads/hidden-photo.webp', describe: 'HIDDEN-SENTINEL photo', visible: false }
const HOME = {
  hero: { welcome: 'Hello', brand: 'Example Person', tagline: 'Builder', avatarUrl: '/uploads/avatar.webp', phone: '+852 0000 0000', email: 'owner@example.test' },
  socials: { github: 'https://github.com/example', whatsapp: '+852 0000 0000' },
  brands: [],
  quickAccess: [{ label: 'Blog', url: '/blog' }],
  photos: [{ url: '/uploads/photo-a.webp', describe: 'Photo A' }, HIDDEN_PHOTO, { url: '/uploads/photo-c.webp', describe: 'Photo C' }],
  highlights: [{ value: '10', label: 'Years building', href: '/cv' }],
}

const HIDDEN_JOB = { jobTitle: 'HIDDEN-SENTINEL job', companyName: 'Secret Co', isVisible: false, features: [], relatedSkills: [] }
const CV = {
  en: [
    {
      sessionName: 'personalInformation',
      headerName: 'Personal',
      firstName: 'Example',
      lastName: 'Person',
      email: 'owner@example.test',
      phoneNumber: '+852 0000 0000',
      address: 'Example City',
      nickName: 'HIDDEN-SENTINEL nickname',
      introduction: 'Builds things.',
      hiddenFields: ['nickName'],
    },
    {
      sessionName: 'workExperience',
      headerName: 'Work',
      experiences: [
        { uid: 'job-a', jobTitle: 'Engineer', companyName: 'Example Co', startDate: '2024-01', endDate: '', jobDescription: 'Built things.', relatedSkills: ['Go', 'HIDDEN-SENTINEL skill'], hiddenItems: { relatedSkills: [1] }, features: [] },
        // Stored without a uid: it reads as `experiences-1`, a predictable one.
        HIDDEN_JOB,
      ],
    },
    {
      sessionName: 'publications',
      headerName: 'Publications',
      papers: [{ uid: 'paper-a', title: 'A paper', authors: ['Example Person', 'HIDDEN-SENTINEL co-author'], hiddenItems: { authors: [1] }, status: 'published', venue: 'Example Venue', date: '2024' }],
    },
    { sessionName: 'education', headerName: 'HIDDEN-SENTINEL section', isVisible: false, showOnWebsite: false, educationExperience: [{ uid: 'school-a', schoolName: 'HIDDEN-SENTINEL school' }] },
  ],
  zh: [],
}

before(async () => {
  await h.setup()
  const w = await storeWriters()
  await w.kv('home', HOME)
  await w.kv('cvdata', CV)
  tools = await aiToolCaller()
  routes = await changeRoutes(h)
})
beforeEach(() => tools?.nextMinute())
after(async () => {
  const { closeAuditDb } = await import('../lib/audit/db')
  closeAuditDb()
  h.teardown()
})

const stored = async (key: 'home' | 'cvdata') => JSON.stringify((await import('../lib/contentStore')).getKv(key))
const homeVersion = async () => (await tools.data('get_home', {}, 'draft')).version as string
const cvVersion = async () => (await tools.data('get_cv', {}, 'draft')).version as string

async function proposeHome(ops: Array<{ path: string; value_json: string }>) {
  return tools.call('propose_home_edit', { ops, base_version: await homeVersion(), rationale: 'r' }, 'propose', { grant: tools.grantAt('propose') })
}
async function proposeCv(ops: Array<Record<string, unknown>>) {
  return tools.call('propose_cv_edit', { ops, base_version: await cvVersion(), rationale: 'r' }, 'propose', { grant: tools.grantAt('propose') })
}

/** The error part of a refusal, without the field that names the operation (equal answers must be equal bytes). */
const refusal = (out: { json: any }) => JSON.stringify(out.json?.error)

test('a hidden photo is no target: position 1 is the next visible photo; a position past the view answers exactly like one far past it', async () => {
  const before = await stored('home')
  const view = await tools.data('get_home', { section: 'photos' }, 'draft')
  assert.deepEqual(view.value.map((p: { url: string }) => p.url), ['/uploads/photo-a.webp', '/uploads/photo-c.webp'])
  assert.ok(!JSON.stringify(view).includes('HIDDEN-SENTINEL'))
  // Stored position 2 exists (Photo C), but public position 2 does not: the same answer as position 9.
  const past = await proposeHome([{ path: 'photos[2].describe', value_json: '"x"' }])
  const nine = await proposeHome([{ path: 'photos[9].describe', value_json: '"x"' }])
  assert.equal(past.code, 'NOT_FOUND')
  assert.equal(refusal(nine).replaceAll('[9]', '[2]'), refusal(past))
  assert.equal(await stored('home'), before, 'nothing stored')

  // Position 1 is Photo C: the approved change writes there, and the hidden photo stays byte for byte.
  const out = await proposeHome([{ path: 'photos[1].describe', value_json: '"Photo C at dusk"' }])
  assert.equal(out.json?.status, 'waiting_for_owner', out.text)
  const card = await routes.card(out.json.change_id)
  assert.match(card.body.preview.documents[0].label, /\/uploads\/photo-c\.webp/, 'the card names the photo')
  assert.ok(!JSON.stringify(card.body.preview).includes('HIDDEN-SENTINEL'), 'the card shows the public view')
  assert.equal((await routes.approve(out.json.change_id)).statusCode, 200)
  const home = JSON.parse(await stored('home'))
  assert.equal(home.photos[2].describe, 'Photo C at dusk')
  assert.deepEqual(home.photos[1], HIDDEN_PHOTO)
  assert.deepEqual(home.highlights, HOME.highlights)
  assert.equal(home.hero.phone, HOME.hero.phone)
  assert.equal(home.socials.whatsapp, HOME.socials.whatsapp)
})

test('home paths outside the allow-list are FIELD_NOT_EDITABLE: contact details, the portrait, logos, photo files and visibility, layout', async () => {
  const before = await stored('home')
  for (const path of ['hero.phone', 'hero.email', 'hero.avatarUrl', 'socials.whatsapp', 'brands', 'photos[0].url', 'photos[0].visible', 'sections', 'sectionOrder', 'hero.secret', 'unknownTop']) {
    const out = await proposeHome([{ path, value_json: '"x"' }])
    assert.equal(out.code, 'FIELD_NOT_EDITABLE', `${path}: ${out.text}`)
  }
  assert.equal(await stored('home'), before)
})

test('the whole highlights list only while every stored highlight is shown; an unchanged public view is NO_VISIBLE_CHANGE', async () => {
  const store = await import('../lib/contentStore')
  const current = store.getKv('home') as typeof HOME
  // Shown: one highlight, so the whole list may be replaced, and position 0 is a target.
  const one = await proposeHome([{ path: 'highlights[0].value', value_json: '"11"' }])
  assert.equal(one.json?.status, 'waiting_for_owner', one.text)
  const whole = await proposeHome([{ path: 'highlights', value_json: '[{"value":"12","label":"Years","href":"/cv"}]' }])
  assert.equal(whole.json?.status, 'waiting_for_owner', whole.text)
  // The section switched off: the stored highlight is not in the view, so neither the list nor its position is a target.
  await store.putKv('home', { ...current, sections: { highlights: false } })
  const hiddenWhole = await proposeHome([{ path: 'highlights', value_json: '[{"value":"12","label":"Years","href":"/cv"}]' }])
  assert.equal(hiddenWhole.code, 'FIELD_HAS_HIDDEN_ITEMS', hiddenWhole.text)
  assert.equal((await proposeHome([{ path: 'highlights[0].label', value_json: '"x"' }])).code, 'NOT_FOUND')
  await store.putKv('home', current)
  // The same value again: visitors would see nothing new.
  assert.equal((await proposeHome([{ path: 'hero.tagline', value_json: '"Builder"' }])).code, 'NO_VISIBLE_CHANGE')
  // A hidden photo's text cannot be reached through another spelling either.
  assert.equal((await proposeHome([{ path: 'photos', value_json: '[]' }])).code, 'FIELD_NOT_EDITABLE')
})

test('a hidden CV entry with a predictable uid answers exactly like an unknown uid; a hidden section like an unknown one', async () => {
  const before = await stored('cvdata')
  const view = await tools.data('get_cv', { lang: 'en' }, 'draft')
  assert.ok(!JSON.stringify(view).includes('HIDDEN-SENTINEL'))
  const hidden = await proposeCv([{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'experiences-1', field: 'jobTitle', value_json: '"x"' }])
  const unknown = await proposeCv([{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'no-such-uid', field: 'jobTitle', value_json: '"x"' }])
  assert.equal(hidden.code, 'NOT_FOUND')
  assert.equal(refusal(hidden), refusal(unknown), 'byte for byte the same answer')
  assert.equal((await proposeCv([{ op: 'remove_entry', lang: 'en', section: 'workExperience', uid: 'experiences-1' }])).code, 'NOT_FOUND')
  const hiddenSection = await proposeCv([{ op: 'set_field', lang: 'en', section: 'education', uid: 'school-a', field: 'schoolName', value_json: '"x"' }])
  const missingSection = await proposeCv([{ op: 'set_field', lang: 'en', section: 'patents', uid: 'school-a', field: 'title', value_json: '"x"' }])
  assert.equal(hiddenSection.code, 'NOT_FOUND')
  assert.equal(refusal(hiddenSection), refusal(missingSection))
  assert.equal(await stored('cvdata'), before, 'nothing stored')
})

test('hidden list items, a hidden author, the hidden-item mark, a hidden field, contact fields and visibility keys are refused', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'relatedSkills', value_json: '["Go","Rust"]' }, 'FIELD_HAS_HIDDEN_ITEMS'],
    [{ op: 'set_field', lang: 'en', section: 'publications', uid: 'paper-a', field: 'authors', value_json: '["Example Person","Someone"]' }, 'FIELD_HAS_HIDDEN_ITEMS'],
    [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobDescription', value_json: '"…"' }, 'FIELD_HAS_HIDDEN_ITEMS'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'nickName', value_json: '"x"' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'email', value_json: '"x@example.test"' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'phoneNumber', value_json: '"+852 0000 0001"' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'address', value_json: '"Elsewhere"' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'photo', value_json: '"/uploads/x.webp"' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'personalInformation', field: 'hiddenFields', value_json: '[]' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'isVisible', value_json: 'false' }, 'FIELD_NOT_EDITABLE'],
    [{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'features', value_json: '[{"description":"x","hiddenFields":["description"]}]' }, 'INVALID_INPUT'],
    [{ op: 'add_entry', lang: 'en', section: 'workExperience', value_json: '{"jobTitle":"New","companyName":"Example","permission":true}' }, 'FIELD_NOT_EDITABLE'],
  ]
  const before = await stored('cvdata')
  for (const [op, code] of cases) {
    const out = await proposeCv([op])
    assert.equal(out.code, code, `${JSON.stringify(op)}: ${out.text}`)
  }
  assert.equal(await stored('cvdata'), before)
})

test('approved CV patches — a field, a new entry, a removed entry — leave every hidden value byte for byte; a change nobody sees is refused', async () => {
  const set = await proposeCv([{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Senior engineer"' }])
  assert.equal(set.json?.status, 'waiting_for_owner', set.text)
  assert.equal((await routes.approve(set.json.change_id)).statusCode, 200)
  const add = await proposeCv([{ op: 'add_entry', lang: 'en', section: 'workExperience', value_json: '{"jobTitle":"Mentor","companyName":"Example Club","isVisible":true}' }])
  assert.equal(add.json?.status, 'waiting_for_owner', add.text)
  assert.equal((await routes.approve(add.json.change_id)).statusCode, 200)
  const cv = JSON.parse(await stored('cvdata'))
  const jobs = cv.en[1].experiences
  assert.equal(jobs[0].jobTitle, 'Senior engineer')
  assert.deepEqual(jobs[0].hiddenItems, { relatedSkills: [1] })
  assert.deepEqual(jobs[0].relatedSkills, ['Go', 'HIDDEN-SENTINEL skill'])
  const { uid: hiddenUid, ...hiddenJob } = jobs[1]
  assert.deepEqual(hiddenJob, HIDDEN_JOB)
  assert.equal(hiddenUid, 'experiences-1', 'the hidden entry only gained its stored uid, as any save stores it')
  assert.equal(jobs[2].jobTitle, 'Mentor')
  assert.equal(jobs[2].isVisible, undefined, 'visibility is the server’s')
  assert.equal(cv.en[0].nickName, 'HIDDEN-SENTINEL nickname')
  assert.deepEqual(cv.en[0].hiddenFields, ['nickName'])
  assert.deepEqual(cv.en[2].papers[0].authors, ['Example Person', 'HIDDEN-SENTINEL co-author'])
  assert.deepEqual(cv.en[3], CV.en[3])

  const mentorUid = jobs[2].uid
  const remove = await proposeCv([{ op: 'remove_entry', lang: 'en', section: 'workExperience', uid: mentorUid }])
  assert.equal(remove.json?.status, 'waiting_for_owner', remove.text)
  assert.equal((await routes.approve(remove.json.change_id)).statusCode, 200)
  const after = JSON.parse(await stored('cvdata'))
  assert.deepEqual(after.en[1].experiences.map((e: { uid: string }) => e.uid), ['job-a', 'experiences-1'])
  assert.deepEqual({ ...after.en[1].experiences[1], uid: undefined }, { ...HIDDEN_JOB, uid: undefined })

  // Visitors would see nothing: the same value, or a paper without a title (no view shows it).
  assert.equal((await proposeCv([{ op: 'set_field', lang: 'en', section: 'workExperience', uid: 'job-a', field: 'jobTitle', value_json: '"Senior engineer"' }])).code, 'NO_VISIBLE_CHANGE')
  assert.equal((await proposeCv([{ op: 'add_entry', lang: 'en', section: 'publications', value_json: '{"venue":"Nowhere"}' }])).code, 'NO_VISIBLE_CHANGE')
})
