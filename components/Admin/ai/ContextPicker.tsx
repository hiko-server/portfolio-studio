import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Box, Button, Flex, Input, Popover, PopoverBody, PopoverContent, PopoverTrigger, Spinner, Text } from '@chakra-ui/react'
import { FiPlus } from 'react-icons/fi'
import { MONO, inputProps } from '../shell/ui'
import { pagePublicPath, type PageName } from '../../../lib/pageNames'
import { ASK_COPY } from './askCopy'
import type { AskChip } from './askContext'

const C = ASK_COPY.picker

/** One thing the picker can attach. */
type Option = { key: string; chip: AskChip; kind: string; name: string; hint: string | null }

const PAGES: PageName[] = ['now', 'uses', 'about', 'about-zh']

const chipKey = (c: AskChip) =>
  c.kind === 'item' ? `item:${c.collection}/${c.slug}` : c.kind === 'page' ? `page:${c.name}` : c.kind === 'cv' ? `cv:${c.lang}` : c.kind === 'media' ? `media:${c.name}` : c.kind

const fold = (s: string) => s.normalize('NFKC').toLowerCase()

/** The site's posts, case studies, pages and images (drafts included), read once when the picker first opens. */
async function loadOptions(signal: AbortSignal): Promise<Option[]> {
  const get = async (url: string) => {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<Record<string, any>>
  }
  const [posts, work, media] = await Promise.all([get('/api/admin/posts'), get('/api/admin/work'), get('/api/admin/media').catch(() => ({ items: [] }))])
  const items = (list: unknown, collection: 'blog' | 'work'): Option[] =>
    (Array.isArray(list) ? list : [])
      .filter((i): i is { slug: string; frontmatter?: Record<string, unknown> } => !!i && typeof i.slug === 'string')
      .map((i) => {
        const title = typeof i.frontmatter?.title === 'string' && i.frontmatter.title.trim() ? i.frontmatter.title : i.slug
        return {
          key: `item:${collection}/${i.slug}`,
          chip: { kind: 'item', collection, slug: i.slug },
          kind: collection === 'blog' ? ASK_COPY.chips.post : ASK_COPY.chips.caseStudy,
          name: title,
          hint: `${i.slug}${i.frontmatter?.draft ? ` · ${C.draft}` : ''}`,
        }
      })
  return [
    ...items(posts.items, 'blog'),
    ...items(work.items, 'work'),
    ...PAGES.map((name) => ({ key: `page:${name}`, chip: { kind: 'page', name } as AskChip, kind: ASK_COPY.chips.page, name: pagePublicPath(name), hint: null })),
    { key: 'home', chip: { kind: 'home' }, kind: ASK_COPY.chips.home, name: ASK_COPY.chips.home, hint: null },
    { key: 'cv:en', chip: { kind: 'cv', lang: 'en' }, kind: ASK_COPY.chips.cv, name: ASK_COPY.chips.cvLang('en'), hint: null },
    { key: 'cv:zh', chip: { kind: 'cv', lang: 'zh' }, kind: ASK_COPY.chips.cv, name: ASK_COPY.chips.cvLang('zh'), hint: null },
    ...(Array.isArray(media.items) ? media.items : [])
      .filter((m: unknown): m is { name: string } => !!m && typeof (m as { name?: unknown }).name === 'string')
      .map((m: { name: string }) => ({ key: `media:${m.name}`, chip: { kind: 'media', name: m.name } as AskChip, kind: ASK_COPY.chips.image, name: m.name, hint: null })),
  ]
}

/**
 * "+ Context" (PRODUCT §4.6): one combobox over the site's posts, case
 * studies, pages, the home page, the CV and the images, drafts included. A
 * pick attaches a chip — a typed reference the server loads itself, never
 * pasted text. The list is read when the picker first opens and filtered as
 * the owner types (title or slug); ↑ ↓ move, Enter attaches, Esc closes.
 * ARIA combobox: the input owns a listbox, the active option is announced
 * through aria-activedescendant.
 */
export default function ContextPicker({
  chips,
  onAdd,
  isOpen,
  onOpenChange,
  onDone,
}: {
  chips: readonly AskChip[]
  onAdd: (chip: AskChip) => void
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** A pick or Esc: the focus goes back where the owner writes (the message box), not to the "+ Context" button. */
  onDone?: () => void
}) {
  const ids = useId()
  const listId = `${ids}-list`
  const [options, setOptions] = useState<Option[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen || options) return
    const ac = new AbortController()
    setError(false)
    loadOptions(ac.signal)
      .then(setOptions)
      .catch(() => {
        if (!ac.signal.aborted) setError(true)
      })
    return () => ac.abort()
  }, [isOpen, options])
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActive(0)
    }
  }, [isOpen])

  const attached = useMemo(() => new Set(chips.map(chipKey)), [chips])
  const shown = useMemo(() => {
    const q = fold(query.trim())
    const all = (options ?? []).filter((o) => !attached.has(o.key))
    const hits = q ? all.filter((o) => fold(`${o.name} ${o.hint ?? ''} ${o.kind}`).includes(q)) : all
    return hits.slice(0, 50)
  }, [options, query, attached])
  useEffect(() => {
    if (active >= shown.length) setActive(Math.max(0, shown.length - 1))
  }, [shown.length, active])

  const pick = (o: Option) => {
    onAdd(o.chip)
    onOpenChange(false)
    onDone?.()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = shown[active]
      if (o) pick(o)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onOpenChange(false)
      onDone?.()
    }
  }

  const activeId = shown[active] ? `${ids}-opt-${active}` : undefined

  return (
    <Popover isOpen={isOpen} onOpen={() => onOpenChange(true)} onClose={() => onOpenChange(false)} initialFocusRef={inputRef} placement="top-start" isLazy returnFocusOnClose={false}>
      <PopoverTrigger>
        <Button
          size="xs"
          variant="ghost"
          color="page.fg-secondary"
          _hover={{ color: 'page.fg', bg: 'page.bg-overlay' }}
          leftIcon={<FiPlus aria-hidden />}
          minH={{ base: '44px', md: '26px' }}
          fontWeight={500}
          aria-haspopup="listbox"
          data-context-add=""
        >
          {C.add}
        </Button>
      </PopoverTrigger>
      <PopoverContent w={{ base: 'calc(100vw - 32px)', sm: '340px' }} bg="page.bg-elevated" borderColor="page.border" boxShadow="elevation.md" _focusVisible={{ outline: 'none' }}>
        <PopoverBody p={2}>
          <Input
            ref={inputRef}
            {...inputProps}
            size="sm"
            role="combobox"
            aria-expanded={shown.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-label={C.label}
            placeholder={C.placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <Box id={listId} role="listbox" aria-label={C.label} maxH="260px" overflowY="auto" mt={2}>
            {!options && !error ? (
              <Flex align="center" gap={2} px={2} py={2} fontSize="sm" color="page.fg-secondary">
                <Spinner size="xs" />
                {C.loading}
              </Flex>
            ) : error ? (
              <Text px={2} py={2} fontSize="sm" color="status.error">
                {C.error}
              </Text>
            ) : !shown.length ? (
              <Text px={2} py={2} fontSize="sm" color="page.fg-secondary">
                {C.none}
              </Text>
            ) : (
              shown.map((o, i) => (
                <Flex
                  key={o.key}
                  id={`${ids}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  align="baseline"
                  gap={2}
                  px={2}
                  py={1.5}
                  minH={{ base: '44px', md: '32px' }}
                  borderRadius="md"
                  cursor="pointer"
                  bg={i === active ? 'page.hover' : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  data-context-option={o.key}
                >
                  <Text as="span" fontSize="12px" color="page.fg-secondary" flexShrink={0} w="78px">
                    {o.kind}
                  </Text>
                  <Box minW={0}>
                    <Text fontSize="13px" noOfLines={1} wordBreak="break-all">
                      {o.name}
                    </Text>
                    {o.hint ? (
                      <Text fontFamily={MONO} fontSize="10px" color="page.fg-secondary" noOfLines={1}>
                        {o.hint}
                      </Text>
                    ) : null}
                  </Box>
                </Flex>
              ))
            )}
          </Box>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
