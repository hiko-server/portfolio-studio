/**
 * The owner's GitHub organizations in the home document
 * (home.openSource.orgs): write-time validation (lib/homeShape) and the
 * Home editor's form model (components/Admin/home/homeForm). Synthetic
 * names only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HOME_LIMITS, normalizeHomeWrite, publicHome, type HomeData } from '../lib/homeShape'
import { formFromHome, serializeHome, validateHomeForm } from '../components/Admin/home/homeForm'

const home = (openSource: HomeData['openSource'] = {}): HomeData =>
  ({ hero: {}, socials: { github: 'https://github.com/example-person' }, brands: [], quickAccess: [], openSource }) as unknown as HomeData

test('openSource.orgs: logins trimmed, the first spelling of case-twins kept, invalid ones reported under openSource.orgs', () => {
  const base = { hero: {}, socials: {}, brands: [], quickAccess: [] } as unknown as HomeData
  const ok = normalizeHomeWrite({ ...base, openSource: { orgs: [' example-org ', 'Example-Org', 'example-lab'] } })
  assert.ok(ok.ok)
  if (ok.ok) assert.deepEqual(ok.home.openSource, { orgs: ['example-org', 'example-lab'] })

  const bad = normalizeHomeWrite({ ...base, openSource: { orgs: ['example-org', '-bad', 'a--b', 'x'.repeat(40), 42 as unknown as string] } })
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.deepEqual(
      bad.errors.map((e) => e.path),
      ['openSource.orgs.1', 'openSource.orgs.2', 'openSource.orgs.3', 'openSource.orgs.4'],
    )
    assert.match(bad.errors[0].message, /^Organization 2: enter a GitHub organization name/)
  }

  const notList = normalizeHomeWrite({ ...base, openSource: { orgs: 'example-org' as unknown as string[] } })
  assert.equal(notList.ok, false)
  if (!notList.ok) assert.deepEqual(notList.errors.map((e) => e.path), ['openSource.orgs'])

  assert.equal(HOME_LIMITS.orgsMax, 10)
  const many = Array.from({ length: 11 }, (_, i) => `example-org-${i}`)
  const tooMany = normalizeHomeWrite({ ...base, openSource: { orgs: many } })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.deepEqual(tooMany.errors, [{ path: 'openSource.orgs', message: 'Add at most 10 organizations.' }])
  // Ten distinct ones (an eleventh spelled differently only by case does not count) are fine.
  const ten = normalizeHomeWrite({ ...base, openSource: { orgs: [...many.slice(0, 10), 'EXAMPLE-ORG-0'] } })
  assert.ok(ten.ok)

  // Empty: no field at all; public by design.
  const empty = normalizeHomeWrite({ ...base, openSource: { orgs: [], showVanityStats: true } })
  assert.ok(empty.ok)
  if (empty.ok) assert.deepEqual(empty.home.openSource, { showVanityStats: true })
  assert.deepEqual(publicHome({ ...base, openSource: { orgs: ['example-org'] } })?.openSource, { orgs: ['example-org'] })
})

test('the editor form keeps the organizations; a draft of an older build without them still saves', () => {
  const form = formFromHome({ ...home({ orgs: ['example-org', 'example-lab'], featured: [{ name: 'example-org/engine' }] }) })
  assert.deepEqual(form.openSource.orgs, ['example-org', 'example-lab'])
  const out = serializeHome(form)
  assert.deepEqual(out.openSource, { featured: [{ name: 'example-org/engine' }], orgs: ['example-org', 'example-lab'] })
  assert.deepEqual(validateHomeForm(form), [])

  const old = formFromHome(home({}))
  delete (old.openSource as Partial<typeof old.openSource>).orgs
  assert.equal('openSource' in serializeHome(old), false)
  const onlyOrgs = serializeHome({ ...old, openSource: { featured: [], showVanityStats: false, orgs: [' example-org '] } })
  assert.deepEqual(onlyOrgs.openSource, { orgs: ['example-org'] })
  const invalid = validateHomeForm({ ...old, openSource: { featured: [], showVanityStats: false, orgs: ['not an org'] } })
  assert.deepEqual(invalid.map((e) => e.path), ['openSource.orgs.0'])
})
