import { Box, Button, Text } from '@chakra-ui/react'
import { MONO } from '../shell/ui'
import { AI_COPY } from './copy'

export type StripTile = {
  label: string
  value: string
  sub: string
  /** The section the tile sums up ([01]), when the view has numbered sections. */
  index?: number
  /** A short action on the tile ("Review"). */
  action?: { label: string; onClick: () => void }
}

/**
 * Admin → AI's status strip (design §8.1, PRODUCT §3): one hairline panel of
 * tiles — Access, Connected apps, Waiting (the assistant's tile joins with
 * stage M4). Two columns on phones, one row from sm; the hairlines are the
 * grid's 1px gaps over the border colour, so they hold in any arrangement.
 */
export default function AiStatusStrip({ tiles }: { tiles: StripTile[] }) {
  return (
    <Box
      as="section"
      aria-label={AI_COPY.strip.label}
      display="grid"
      gridTemplateColumns={{ base: 'repeat(2, minmax(0, 1fr))', sm: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      gap="1px"
      bg="page.border"
      border="1px solid"
      borderColor="page.border"
      borderRadius="xl"
      overflow="hidden"
    >
      {tiles.map((t, i) => (
        <Box
          key={t.label}
          px={4}
          py={3}
          bg="page.bg"
          minW={0}
          gridColumn={{ base: tiles.length % 2 === 1 && i === tiles.length - 1 ? 'span 2' : undefined, sm: 'auto' }}
        >
          <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
            {t.index ? (
              <Box as="span" color="accent.text" mr={1.5}>
                [{String(t.index).padStart(2, '0')}]
              </Box>
            ) : null}
            {t.label}
          </Text>
          <Text fontSize="md" fontWeight={600} mt={1} className="tnum">
            {t.value}
          </Text>
          <Text fontSize="xs" color="page.fg-secondary">
            {t.sub}
            {t.action ? (
              <>
                {' · '}
                <Button variant="link" size="xs" fontSize="xs" color="accent.text" fontWeight={500} onClick={t.action.onClick} verticalAlign="baseline">
                  {t.action.label}
                </Button>
              </>
            ) : null}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
