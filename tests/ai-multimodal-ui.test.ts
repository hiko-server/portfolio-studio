/**
 * The browser half of the assistant's files and voice
 * (components/Admin/ai/media): what a picked file is taken as, how dictated
 * phrases join the text, how a reply is read aloud, the WAV the recorder
 * makes, and the rule that every image the chat draws comes from this site
 * (the owner's own upload, or its local preview) — never from a URL a model
 * or a page could choose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { classify, formatBytes, formatDuration, mediaUrl, stampedName } from '../components/Admin/ai/media/prepare'
import { joinDictated, speechChunks, speechLang, toSpeakable } from '../components/Admin/ai/media/voice'
import { endView } from '../components/Admin/ai/assistantFormat'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

test('a picked file is taken by its type or name; what the assistant cannot use is refused', () => {
  assert.equal(classify({ type: 'image/jpeg', name: 'a.jpg' }), 'image')
  assert.equal(classify({ type: '', name: 'IMG_0001.HEIC' }), 'image')
  assert.equal(classify({ type: 'image/svg+xml', name: 'logo.svg' }), 'text', 'SVG is markup: read as text, never drawn')
  assert.equal(classify({ type: 'application/pdf', name: 'x' }), 'pdf')
  assert.equal(classify({ type: 'audio/webm', name: 'voice.webm' }), 'audio')
  assert.equal(classify({ type: 'video/mp2t', name: 'index.ts' }), 'text', 'a TypeScript file whatever the OS calls it')
  assert.equal(classify({ type: '', name: 'Dockerfile' }), 'text')
  assert.equal(classify({ type: 'application/zip', name: 'site.zip' }), null)
  assert.equal(classify({ type: 'application/x-msdownload', name: 'setup.exe' }), null)
})

test('dictated phrases join the text: a space between Latin words, none around Chinese or Japanese', () => {
  assert.equal(joinDictated('', ' hello '), 'hello')
  assert.equal(joinDictated('Write a post', 'about Tokyo'), 'Write a post about Tokyo')
  assert.equal(joinDictated('Write a post ', 'about Tokyo'), 'Write a post about Tokyo')
  assert.equal(joinDictated('写一篇', '关于东京的文章'), '写一篇关于东京的文章')
  assert.equal(joinDictated('Draft', '东京'), 'Draft东京')
  assert.equal(joinDictated('text', '   '), 'text')
})

test('a reply is read without its markup: code, links and tables become what a listener needs', () => {
  const md = '# Title\n\nSee [the post](/blog/x) and https://example.com/a?b=c.\n\n```js\nconst x = 1\n```\n\n- **One**\n- `two`\n\n| a | b |\n|---|---|\n| 1 | 2 |'
  const spoken = toSpeakable(md)
  assert.doesNotMatch(spoken, /[#*`|]|https?:|\]\(/)
  assert.match(spoken, /the post/)
  assert.match(spoken, /\(code block\)/)
  assert.match(spoken, /One/)
  const chunks = speechChunks('First sentence. '.repeat(40))
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 220))
  assert.deepEqual(speechChunks(''), [])
  assert.equal(speechLang('这是一个关于网站的回答，内容很长。'), 'zh-CN')
  assert.equal(speechLang('これは日本語の文章です。ひらがなとカタカナ。'), 'ja-JP')
  assert.match(speechLang('An English reply.'), /^en/)
})

test('sizes, durations and capture names read well', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB')
  assert.equal(formatDuration(65_000), '1:05')
  assert.equal(stampedName('photo', 'jpg', new Date(2026, 10, 12, 9, 5, 7)), 'photo-2026-11-12-090507.jpg')
  assert.equal(mediaUrl('m_abc'), '/api/admin/ai/media/m_abc')
  assert.equal(mediaUrl('m_abc', true), '/api/admin/ai/media/m_abc?download=1')
})

test('a message refused with its files says so, shows the provider’s words, and offers no Retry (nothing is left to send)', () => {
  const view = endView({ state: 'failed', reason: 'media-refused', message: 'The model refused this message with its files.', detail: { providerMessage: 'image input is not supported' } }, 'DeepSeek')
  assert.ok(view)
  assert.equal(view!.tone, 'warning')
  assert.match(view!.line, /DeepSeek refused this message with its files/)
  assert.equal(view!.providerSaid, 'image input is not supported')
  assert.equal(view!.action, null)
})

test('every image the chat draws is this site’s: an upload served by /api/admin/ai/media or its local preview, never a URL from a reply', () => {
  const viewer = read('components/Admin/ai/media/MessageMedia.tsx')
  for (const m of viewer.matchAll(/\bsrc=\{([^}]+)\}/g)) assert.match(m[1], /^(srcOf\(m, previews\)|mediaUrl\(m\.id\))$/, `MessageMedia src: ${m[1]}`)
  const tray = read('components/Admin/ai/media/AttachmentTray.tsx')
  for (const m of tray.matchAll(/\bsrc=\{([^}]+)\}/g)) assert.equal(m[1], 'item.preview', 'the tray draws only the local preview')
  assert.match(read('components/Admin/ai/media/prepare.ts'), /export const mediaUrl = \(id: string, download = false\) => `\/api\/admin\/ai\/media\/\$\{encodeURIComponent\(id\)\}/)
  // Replies stay text: ChatMarkdown still draws no image, and nothing under media/ renders model text as markup.
  assert.doesNotMatch(read('components/Admin/ai/ChatMarkdown.tsx'), /<img|<Image\b/)
  for (const f of fs.readdirSync(path.join(ROOT, 'components/Admin/ai/media'))) assert.doesNotMatch(read(`components/Admin/ai/media/${f}`), /dangerouslySetInnerHTML|innerHTML/, f)
})

test('the microphone, camera and screen are asked for only when the owner acts, and stopped when done', () => {
  const voice = read('components/Admin/ai/media/voice.ts')
  const capture = read('components/Admin/ai/media/capture.ts')
  const camera = read('components/Admin/ai/media/CameraCapture.tsx')
  // Each getUserMedia / getDisplayMedia call sits inside a start function the owner's click calls.
  assert.match(voice, /const start = useCallback\(async \(\) => \{[\s\S]*getUserMedia/)
  assert.match(capture, /export async function captureScreen\(\)[\s\S]*getDisplayMedia[\s\S]*finally \{\s*for \(const t of stream\.getTracks\(\)\) t\.stop\(\)/)
  assert.match(camera, /const stopStream = useCallback\(\(\) => \{\s*for \(const t of stream\.current\?\.getTracks\(\) \?\? \[\]\) t\.stop\(\)/)
  // Dictation prefers recognition on this device when the browser offers it.
  assert.match(voice, /processLocally: true/)
})
