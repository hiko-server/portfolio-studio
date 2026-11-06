/**
 * M4 — the greppable check (design §7.2, §7.7, §14 M4): no request to any
 * model provider ever carries `temperature`, `top_p`, `top_k`,
 * `budget_tokens` or `tool_choice`. API 2026-10-21 answers each with a 400 on
 * Claude, Kimi errors on sampling values, and forced tool choice is refused
 * by Opus 5.5, DeepSeek in thinking mode, GLM and MiniMax.
 *
 * Two halves: the code that builds requests (lib/ai/**, the provider routes)
 * names none of them outside comments — read through the TypeScript scanner,
 * so a comment explaining the rule is fine and a property, string or
 * identifier is not — and every request the provider test files send is
 * checked at runtime against the same list (tests/ai-providers-*.test.ts,
 * tests/helpers/modelTurns NEVER_SENT).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { NEVER_SENT } from './helpers/modelTurns'

const ROOT = path.resolve(import.meta.dirname, '..')

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** Every identifier, property name and string in `file` (comments are trivia, never tokens). */
function codeWords(file: string): Array<{ word: string; line: number }> {
  const text = fs.readFileSync(file, 'utf8')
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text)
  const out: Array<{ word: string; line: number }> = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      const line = text.slice(0, scanner.getTokenStart()).split('\n').length
      for (const w of scanner.getTokenValue().split(/[^A-Za-z0-9_]+/)) out.push({ word: w, line })
    }
  }
  return out
}

test('the request builders name no never-sent parameter outside comments', () => {
  const scanned = [...files(path.join(ROOT, 'lib/ai')), ...files(path.join(ROOT, 'pages/api/admin/ai'))]
  assert.ok(scanned.some((f) => f.endsWith(path.join('providers', 'anthropic.ts'))))
  const hits: string[] = []
  for (const file of scanned) {
    for (const { word, line } of codeWords(file)) if (NEVER_SENT.includes(word)) hits.push(`${path.relative(ROOT, file)}:${line} ${word}`)
  }
  assert.deepEqual(hits, [])
})

test('the scanner itself sees a parameter in code and ignores one in a comment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-no-sampling-'))
  const tmp = path.join(dir, 'probe.ts')
  fs.writeFileSync(tmp, "// temperature in a comment is fine\nconst body = { model: 'm', temperature: 0.2, 'top_p': 1 }\nvoid body\n")
  try {
    const words = codeWords(tmp).map((w) => w.word)
    assert.ok(words.includes('temperature') && words.includes('top_p'))
    assert.equal(words.filter((w) => w === 'temperature').length, 1, 'the comment is not code')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
