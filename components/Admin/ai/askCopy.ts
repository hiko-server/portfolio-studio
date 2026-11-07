/**
 * The words of Ask AI (design §8.6, PRODUCT §5): the entry points in the
 * editors, the panel and its chips, and the editor bridge's cards. Kept
 * apart from ./copy.ts, which belongs to Admin → AI, so an editor page
 * carries only the few words its button needs until the panel opens.
 * Voice as ./copy.ts: plain second person, curly quotes, no exclamation
 * marks. "Ask AI" is the verb, "AI assistant" the destination — never a bare
 * "Ask", which the public palette owns.
 */

export const ASK_COPY = {
  button: 'Ask AI',
  /** The panel's accessible name and title. */
  panel: 'AI assistant',
  eyebrow: '[ask ai]',
  close: 'Close the AI assistant',
  newChat: 'New chat',
  fullView: 'Open full view',
  fullViewHint: 'The conversation in Admin → AI, with its history',
  shortcut: (keys: string) => `Ask AI (${keys})`,
  saveFirst: 'Save the draft first: Ask AI works on a saved post.',
  loading: 'Loading the assistant',
  loadError: (detail: string) => `Couldn’t load the assistant (${detail}).`,
  retry: 'Retry',
  off: 'AI access is off.',
  offBody: 'Turn it on in Admin → AI → Connections to ask about this page.',
  openConnections: 'Open Connections',
  noModel: 'No model connected yet.',
  noModelBody: 'Add an API key in Admin → AI → Models to ask about this page.',
  openModels: 'Open Models',
  intro: (what: string) => `Ask about ${what}, or say what to change. A change to it comes back here as a suggestion: nothing is saved until you apply it and save.`,
  introServer: (what: string) => `Ask about ${what}, or say what to change. Anything that would reach visitors waits here for your approval.`,
  introPlain: 'Ask about the site, or say what to change. Drafts save at once and visitors can’t see them; anything that would reach visitors waits for your approval.',
  /** The status line below the panel's header. */
  privacy: (provider: string, host: string) => (host ? `Your messages, the attached text and what the tools read go to ${provider} (${host}).` : `Your messages, the attached text and what the tools read go to ${provider}.`),

  chips: {
    label: 'Attached to your next message',
    remove: (label: string) => `Remove ${label}`,
    post: 'Post',
    caseStudy: 'Case study',
    page: 'Page',
    home: 'Home page',
    cv: 'CV',
    image: 'Image',
    selection: 'Selection',
    unsaved: 'unsaved edits',
    words: (n: number) => (n === 1 ? '1 word' : `${n.toLocaleString('en')} words`),
    cvLang: (lang: string) => (lang === 'zh' ? '中文' : 'English'),
  },

  /** + Context (PRODUCT §4.6): attach a post, case study, page, the home page, the CV or an image. */
  picker: {
    add: 'Context',
    label: 'Attach a post, page or image',
    placeholder: 'Search posts, case studies, pages, images…',
    loading: 'Loading the site’s content',
    error: 'Couldn’t load the list. Close it and try again.',
    none: 'Nothing else matches.',
    draft: 'draft',
  },

  /** Prompts an entry point puts in the message box (the owner's own words to send or change). */
  prompts: {
    check: (label: string) => `Help me fix this publish check: “${label}”.`,
    health: (message: string, where: string) => `Look at this content health issue and propose a fix: “${message}” (${where}).`,
    readiness: (label: string) => `Explain this CV readiness check and propose a fix: “${label}”.`,
    altText: 'Suggest alt text and a caption for this image, from the text around it where it is used.',
    selection: 'About the selected text: ',
  },

  /** The editor bridge (§7.8): a suggestion for the open editor. */
  suggestion: {
    eyebrow: '[suggestion]',
    forEditor: 'For your editor',
    opened: 'Opened from Changes',
    apply: 'Apply to editor',
    applying: 'Applying',
    dismiss: 'Dismiss',
    undo: 'Undo',
    applied: 'Applied to the editor. Nothing is saved until you save.',
    appliedSaved: 'Saved in the editor.',
    editedSince: 'You edited after applying it: use the editor’s own undo.',
    changed: (noun: string) => `The ${noun} changed while this was being written. Ask again.`,
    changedProposal: (noun: string) => `The ${noun} changed after this was proposed. Ask again, or review it under Changes.`,
    askAgain: 'Ask again',
    dismissed: 'Dismissed.',
    expired: 'This suggestion expired. Ask again if you still want it.',
    voided: 'AI access changed, so this suggestion can’t be applied.',
    issuerEnded: 'Whoever asked for this no longer has access (the app was disconnected, or that browser signed out), so it can’t be applied.',
    closed: (state: string) => `This change is ${state}.`,
    saving: 'Wait for the save to finish.',
    hidden: 'Hidden here. It still waits under Changes.',
    note: 'Applying replaces the text in the editor with what is shown here. Save, Publish and every check work as always.',
    notEditor: 'This suggestion is for another document.',
  },

  /** A home or CV proposal while that editor has unsaved edits (§7.8: not bridged in v1). */
  saveOrDiscard: 'Save or discard your edits first: approving now would be overwritten by your next save.',

  /** Open in editor (§8.2). */
  openInEditor: 'Open in editor',

  /** The AI-touched state of an editor (§7.8). */
  touched: {
    badge: 'AI edits not saved',
    badgeHint: 'This editor holds AI-suggested edits you haven’t saved. The preview loads nothing from other sites until you save.',
    preview: 'AI edits · images from other sites aren’t loaded',
  },

  /** Contains AI edits (§4.6, §8.2) in the publish sheet and the schedule dialog. */
  contains: {
    title: 'Contains AI edits',
    saved: 'This version carries edits AI wrote.',
    local: 'This editor holds AI-suggested edits you haven’t saved yet.',
    open: 'Open the change',
  },
}
