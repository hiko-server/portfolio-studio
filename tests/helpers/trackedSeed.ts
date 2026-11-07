import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { trialWrote } from '../../scripts/ai-trial.mjs'

/**
 * A git seed (data/home.json, data/cvdata.json) as this checkout tracks it.
 *
 * The local trial (scripts/ai-trial.mjs) replaces both with the fixture
 * store's copies and records what it wrote. While the file on disk is still
 * exactly that, the seed is the one in git's index; otherwise it is the file
 * on disk, an edit in progress included. So a worktree running the trial
 * checks the same seeds as one that never did.
 */
export function readTrackedSeed(rel: string, root = process.cwd()): string {
  if (!trialWrote(root, rel)) return fs.readFileSync(path.join(root, rel), 'utf8')
  // A GIT_DIR in the shell must not answer for this checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) as NodeJS.ProcessEnv
  const res = spawnSync('git', ['show', `:${rel}`], { cwd: root, env, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`git show :${rel} failed in ${root}: ${res.stderr.trim()}`)
  return res.stdout
}
