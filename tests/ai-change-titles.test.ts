/**
 * M7 — a change's title is what it does (design §5.3: "title, from action and
 * slug"). The review page heads every change "<who> wants to <title>"
 * (CHANGES_COPY.wantsTo), the Changes rows and the card headline show the
 * title alone, so every title a plan builds starts with an imperative verb.
 * The trial walk found "Trial drafter wants to new draft post …": the three
 * draft-safe titles were noun phrases.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CHANGES_COPY } from '../components/Admin/ai/copy'

const ROOT = path.resolve(import.meta.dirname, '..')
const PLANS = path.join(ROOT, 'lib/ai/plans')
const VERBS = new Set(['Apply', 'Clear', 'Delete', 'Discard', 'Edit', 'Fill', 'Import', 'Merge', 'Move', 'Publish', 'Rename', 'Restore', 'Save', 'Schedule', 'Set', 'Unpublish', 'Write'])

/** The first word of every branch a plan's `title:` can take, per file and line. */
function titleStarts(): Array<{ where: string; first: string }> {
  const out: Array<{ where: string; first: string }> = []
  for (const name of fs.readdirSync(PLANS).filter((f) => f.endsWith('.ts') && f !== 'types.ts')) {
    const lines = fs.readFileSync(path.join(PLANS, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = /^\s*title: (.+),$/.exec(line)
      if (!m || /frontmatter|fm\.|args\.title/.test(m[1])) return
      // The literal that opens each branch: `…` or '…'; `cond ? `A…` : `B…``; `${cond ? 'A' : 'B'} …`.
      // Ternaries inside a template (`${n === 1 ? 'fix' : 'fixes'}`) are words in the middle, not branches.
      const expr = m[1]
      const firsts: string[] = []
      const head = /^\s*`\$\{[^?]*\?\s*'([A-Za-z]+)[^']*'\s*:\s*'([A-Za-z]+)/.exec(expr)
      const ternary = /^[^`'$]+\?\s*[`']([A-Za-z]+)[\s\S]*?`\s*:\s*[`']([A-Za-z]+)/.exec(expr)
      const plain = /^\s*[`']([A-Za-z]+)/.exec(expr)
      if (head) firsts.push(head[1], head[2])
      else if (ternary) firsts.push(ternary[1], ternary[2])
      else if (plain) firsts.push(plain[1])
      else firsts.push(`(unread: ${expr.slice(0, 40)})`)
      for (const first of firsts) out.push({ where: `${name}:${i + 1}`, first })
    })
  }
  return out
}

test('every title a plan builds starts with a verb, so “<who> wants to <title>” reads as a sentence', () => {
  const starts = titleStarts()
  assert.ok(starts.length >= 20, `titles found: ${starts.length}`)
  const bad = starts.filter((s) => !VERBS.has(s.first))
  assert.deepEqual(bad, [])
})

test('the draft-safe writes read as actions on the review page', () => {
  for (const [title, heading] of [
    ['Write a new draft post trial-link', 'Example app wants to write a new draft post trial-link'],
    ['Save unpublished changes to post example-field-notes', 'Example app wants to save unpublished changes to post example-field-notes'],
    ['Edit draft case study example-work', 'Example app wants to edit draft case study example-work'],
    ['Set the default texts of image field-dusk.jpg', 'Example app wants to set the default texts of image field-dusk.jpg'],
  ]) {
    assert.equal(CHANGES_COPY.wantsTo('Example app', title), heading)
  }
  const items = fs.readFileSync(path.join(PLANS, 'items.ts'), 'utf8')
  assert.match(items, /title: `Write a new draft \$\{noun\(c\)\} \$\{args\.slug\}`/)
  assert.match(items, /`Save unpublished changes to \$\{noun\(c\)\} \$\{args\.slug\}` : `Edit draft \$\{noun\(c\)\} \$\{args\.slug\}`/)
  assert.match(fs.readFileSync(path.join(PLANS, 'media.ts'), 'utf8'), /title: `Set the default texts of image \$\{name\}`/)
})
