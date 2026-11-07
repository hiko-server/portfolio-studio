/**
 * The repo's own module graph, read from source: which local modules a file
 * loads at run time, and everything reachable from a set of files. For
 * boundary tests ("this layer never reaches that module"). Test-only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']

/** Repo-relative path with forward slashes. */
export const rel = (file: string) => path.relative(ROOT, file).replace(/\\/g, '/')

/**
 * The module specifiers a file loads at run time: static imports and
 * re-exports with at least one value binding (an `import type`, or a list of
 * `type` names only, is erased by the compiler), side-effect imports and
 * import(). Comments are ignored.
 */
export function valueImports(src: string): string[] {
  const out: string[] = []
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of code.matchAll(/(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue
    const clause = m[3].trim()
    const list = /\{([^}]*)\}/.exec(clause)
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()
    const named = list ? list[1].split(',').map((s) => s.trim()).filter(Boolean) : []
    if (!outside && named.length && named.every((s) => s.startsWith('type '))) continue
    out.push(m[4])
  }
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** The file a relative specifier names, or null (packages and missing files). */
export function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, `index${e}`))]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

/** The local files `file` loads directly. */
export function localImports(file: string): string[] {
  return valueImports(fs.readFileSync(file, 'utf8'))
    .map((spec) => resolveLocal(file, spec))
    .filter((f): f is string => !!f)
}

/**
 * Every local file reachable from `seeds` (repo-relative), each with the
 * chain that reaches it — for a readable failure message.
 */
export function reachable(seeds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const queue: Array<[string, string[]]> = seeds.map((s) => [path.join(ROOT, s), [s]])
  while (queue.length) {
    const [file, chain] = queue.shift() as [string, string[]]
    const key = rel(file)
    if (out.has(key)) continue
    out.set(key, chain)
    for (const next of localImports(file)) if (!out.has(rel(next))) queue.push([next, [...chain, rel(next)]])
  }
  return out
}

/** Import cycles among the files reachable from `seeds`, as `a -> b -> a` lines. */
export function cyclesFrom(seeds: readonly string[]): string[] {
  const files = Array.from(reachable(seeds).keys())
  const edges = new Map(files.map((f) => [f, localImports(path.join(ROOT, f)).map(rel)]))
  const found = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (f: string) => {
    stack.push(f)
    for (const next of edges.get(f) ?? []) {
      const at = stack.indexOf(next)
      if (at >= 0) found.add([...stack.slice(at), next].join(' -> '))
      else if (!done.has(next)) visit(next)
    }
    stack.pop()
    done.add(f)
  }
  for (const f of files) if (!done.has(f)) visit(f)
  return Array.from(found)
}
