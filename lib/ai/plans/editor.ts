import { editorBaseText } from '../../../components/Admin/ai/editorBase'
import { mergeFrontmatter } from '../../frontmatterMerge'
import { isDraftFrontmatter, readPage } from '../../mdx-admin'
import { pageAdminPath, pagePublicPath } from '../../pageNames'
import { applyEdits } from '../edits'
import type { EditorBinding, ToolContext, ToolRefusal } from '../toolTypes'
import { itemEditUrl, itemState, itemText, needsDraftAccess, noun, quotedVersion, refuse } from './common'
import type { EditContentArgs } from './items'
import { editsRefusal } from './items'
import type { PageEditArgs } from './pages'
import { canonicalJson, sha256Hex, type WritePlan } from './types'

/**
 * Plans of a write to the document the owner has open in an editor (pure;
 * design §7.8). When an assistant run is attached to an open post, case
 * study or page, `edit_content` and `propose_page_edit` on that target take
 * this path: the before-state is the editor's current form state, as the
 * owner's browser sent it — what "the post I'm editing" means — and the
 * after-state is computed from it, then checked by validateAiWrite exactly
 * like a stored write (same refusals, same codes). The write goes to the
 * editor (`sink: 'editor'`): nothing is written to the store, and the
 * owner applies the whole suggestion, or nothing, then saves it there.
 *
 * The suggestion is bound to the editor's text (components/Admin/ai/
 * editorBase): the body and every field it sets or removes, hashed. The
 * editor applies it only while its own state still hashes to that value.
 * A frontmatter patch can never carry `draft`, the schedule or the
 * translation key (the tools' schemas refuse them), which matters here
 * because a plain Save takes `draft` from the editor's form state.
 */

type Frontmatter = Record<string, unknown>

const LABEL: Record<'now' | 'uses' | 'about' | 'about-zh', string> = { now: '/now', uses: '/uses', about: 'the About bio', 'about-zh': 'the Chinese bio' }

/** The value as stored text: undefined keys dropped (what a JSON round trip keeps). */
const plain = (fm: Frontmatter): Frontmatter => JSON.parse(JSON.stringify(fm ?? {})) as Frontmatter

/** Is the run attached to the editor of this post or case study? */
export function editorOfItem(editor: EditorBinding | null | undefined, collection: string, slug: string): Extract<EditorBinding, { kind: 'item' }> | null {
  return editor && editor.kind === 'item' && editor.collection === collection && editor.slug === slug ? editor : null
}

/** Is the run attached to the editor of this page? */
export function editorOfPage(editor: EditorBinding | null | undefined, name: string): Extract<EditorBinding, { kind: 'page' }> | null {
  return editor && editor.kind === 'page' && editor.name === name ? editor : null
}

/** The base hash of a suggestion: the editor's text it was computed from (editorBaseText), SHA-256. */
export function editorBaseHash(doc: { frontmatter: Frontmatter; body: string }, keys: readonly string[]): string {
  return sha256Hex(editorBaseText(doc, keys))
}

function staleEditor(what: string, version: string): ToolRefusal {
  return refuse(
    'VERSION_CONFLICT',
    `base_version is not the version of the ${what} open in the owner's editor: read it again with get_content and redo the edit.`,
    { current_version: version },
  )
}

/** The editor's frontmatter after the patch and removals (the server-side merge of a stored write). */
function patched(state: Frontmatter, patch: Frontmatter | undefined, removed: readonly string[] | undefined): Frontmatter {
  const edited: Frontmatter = { ...plain(patch ?? {}) }
  for (const k of removed ?? []) edited[k] = undefined
  return plain(mergeFrontmatter(plain(state), edited))
}

/** `edit_content` on the post or case study open in the owner's editor. */
export function planEditorItemEdit(args: EditContentArgs, editor: Extract<EditorBinding, { kind: 'item' }>, ctx: ToolContext): WritePlan | ToolRefusal {
  void ctx
  const c = args.collection
  const stored = itemState(c, args.slug)
  if (!stored) return refuse('NOT_FOUND', 'Nothing exists at that address. Check the collection and slug with search_content.')
  if (quotedVersion(args.base_version) !== editor.version) return staleEditor(noun(c), editor.version)

  const state = { frontmatter: plain(editor.state.frontmatter), body: editor.state.body }
  let body = args.body ?? state.body
  if (args.edits) {
    const out = applyEdits(state.body, args.edits)
    if (!out.ok) return editsRefusal(out)
    body = out.body
  }
  const frontmatter = patched(state.frontmatter, args.frontmatter_patch, args.remove_frontmatter)
  if (body === state.body && canonicalJson(frontmatter) === canonicalJson(state.frontmatter)) {
    return refuse('NO_VISIBLE_CHANGE', 'The change leaves the editor exactly as it is. Nothing was sent.')
  }
  const touchedKeys = [...Object.keys(args.frontmatter_patch ?? {}), ...(args.remove_frontmatter ?? [])]
  const live = !isDraftFrontmatter(stored.live.frontmatter)
  return {
    kind: 'item.editor',
    risk: 'draft',
    sink: 'editor',
    target: { kind: c, ref: args.slug },
    baseVersion: editor.version,
    args: {
      collection: c,
      slug: args.slug,
      base_version: editor.version,
      base_hash: editorBaseHash(state, touchedKeys),
      keys: Array.from(new Set(touchedKeys)).sort(),
      body,
      ...(args.frontmatter_patch ? { frontmatter_patch: plain(args.frontmatter_patch) } : {}),
      ...(args.remove_frontmatter ? { remove_frontmatter: [...args.remove_frontmatter] } : {}),
    },
    rationale: args.rationale ?? null,
    // The stored item as it is (nothing here writes it): the state before AI touched it, should the owner save this.
    before: { kind: 'item', collection: c, slug: args.slug, live: stored.live, pending: stored.pending },
    preview: {
      kind: 'item.editor',
      risk: 'draft',
      title: `Edit ${noun(c)} ${args.slug} in the editor`,
      documents: [
        {
          ref: `${c}/${args.slug}`,
          label: `${noun(c).charAt(0).toUpperCase()}${noun(c).slice(1)} ${args.slug} in your editor`,
          publicUrl: live ? `/${c}/${args.slug}` : null,
          format: 'mdx',
          before: itemText(state),
          after: itemText({ frontmatter, body }),
        },
      ],
      effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'item', collection: c, touchedKeys, frontmatter, body, before: state },
    audit: { route: c === 'blog' ? 'admin/posts' : 'admin/work', method: 'PUT', body: { slug: args.slug, frontmatter } },
    editUrl: itemEditUrl(c, args.slug),
  }
}

/** `propose_page_edit` on the page open in the owner's editor: a suggestion there, never a waiting change. */
export function planEditorPageEdit(args: PageEditArgs, editor: Extract<EditorBinding, { kind: 'page' }>, ctx: ToolContext): WritePlan | ToolRefusal {
  const scope = needsDraftAccess(ctx)
  if (scope) return scope
  if (quotedVersion(args.base_version) !== editor.version) return staleEditor('page', editor.version)
  const stored = readPage(args.name)
  const state = { frontmatter: plain(editor.state.frontmatter), body: editor.state.body }
  let body = args.body ?? state.body
  if (args.edits) {
    const out = applyEdits(state.body, args.edits)
    if (!out.ok) return editsRefusal(out)
    body = out.body
  }
  if (!body.trim()) return refuse('INVALID_INPUT', 'The page would be empty. Clearing a page is the owner’s to do in its editor.', { field: 'body' })
  const frontmatter = patched(state.frontmatter, args.frontmatter_patch, args.remove_frontmatter)
  if (typeof frontmatter.title !== 'string' || !frontmatter.title.trim()) return refuse('INVALID_INPUT', 'The page needs a title.', { field: 'frontmatter_patch.title' })
  if (body === state.body && canonicalJson(frontmatter) === canonicalJson(state.frontmatter)) {
    return refuse('NO_VISIBLE_CHANGE', 'The change leaves the editor exactly as it is. Nothing was sent.')
  }
  const touchedKeys = [...Object.keys(args.frontmatter_patch ?? {}), ...(args.remove_frontmatter ?? [])]
  const name = args.name
  return {
    kind: 'page.editor',
    risk: 'draft',
    sink: 'editor',
    target: { kind: 'page', ref: name },
    baseVersion: editor.version,
    args: {
      name,
      base_version: editor.version,
      base_hash: editorBaseHash(state, touchedKeys),
      keys: Array.from(new Set(touchedKeys)).sort(),
      body,
      ...(args.frontmatter_patch ? { frontmatter_patch: plain(args.frontmatter_patch) } : {}),
      ...(args.remove_frontmatter?.length ? { remove_frontmatter: [...args.remove_frontmatter] } : {}),
    },
    rationale: args.rationale ?? null,
    before: { kind: 'page', name, page: stored.updatedAt ? { frontmatter: stored.frontmatter, body: stored.body, updatedAt: stored.updatedAt } : null },
    preview: {
      kind: 'page.editor',
      risk: 'draft',
      title: `Edit ${LABEL[name]} in the editor`,
      documents: [{ ref: `page/${name}`, label: `Page ${LABEL[name]} in your editor`, publicUrl: pagePublicPath(name), format: 'mdx', before: itemText(state), after: itemText({ frontmatter, body }) }],
      effects: { publicPaths: [], schedule: null, deleted: false, import: null, hiddenValuesChanged: null },
    },
    held: null,
    check: { kind: 'item', collection: 'page', touchedKeys, frontmatter, body, before: state },
    audit: { route: 'admin/page', method: 'PUT', body: { name, frontmatter, body } },
    editUrl: pageAdminPath(name),
  }
}
