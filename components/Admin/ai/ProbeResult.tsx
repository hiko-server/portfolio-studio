import { Box, Flex, Text } from '@chakra-ui/react'
import { MONO } from '../shell/ui'
import { MODELS_COPY } from './copy'
import { statusLabel, statusTone } from './assistantFormat'
import { sinceTime } from './format'
import type { ModelStatus, ProbeView } from './types'

const TONES = {
  ok: { color: 'green.700', dark: 'green.300', border: 'green.500' },
  warn: { color: 'orange.700', dark: 'orange.300', border: 'orange.400' },
  bad: { color: 'red.600', dark: 'red.300', border: 'red.400' },
  none: { color: 'page.fg-secondary', dark: undefined, border: 'page.border-strong' },
} as const

/** A model's status as a mono chip (the style of the change state chip). */
export function ModelStatusChip({ status }: { status: ModelStatus | string }) {
  const t = TONES[statusTone(status)]
  return (
    <Text
      as="span"
      fontFamily={MONO}
      fontSize="9px"
      letterSpacing="0.08em"
      textTransform="uppercase"
      color={t.color}
      _dark={t.dark ? { color: t.dark } : undefined}
      border="1px solid"
      borderColor={t.border}
      borderRadius="3px"
      px="5px"
      lineHeight="16px"
      whiteSpace="nowrap"
      flexShrink={0}
      data-model-status={status}
    >
      {statusLabel(status)}
    </Text>
  )
}

/** What a Test observed, in a few words (only what it really saw). */
function observations(o: ProbeView['observations']): string[] {
  const p = MODELS_COPY.probe
  const out: string[] = []
  if (typeof o.modelsListed === 'number' && o.modelsListed > 0) out.push(p.listedModels(o.modelsListed))
  if (o.argsArrived === 'fragmented') out.push(p.fragmented)
  else if (o.argsArrived === 'whole') out.push(p.whole)
  if (o.reasoningSeen === true) out.push(p.reasoning)
  if (o.usageSeen === true) out.push(p.usage)
  if (o.cachedSeen === true) out.push(p.cached)
  if (typeof o.elapsedMs === 'number') out.push(p.elapsed((o.elapsedMs / 1000).toFixed(1)))
  return out
}

/**
 * A Test's result (design §7.7, PRODUCT §8.1 step 4): the status and what it
 * means, then each step the server ran with its own outcome, then what it
 * observed. Every word of a failure is the server's plain text: a provider's
 * message is never markup.
 */
export default function ProbeResult({ result, now, live = false }: { result: ProbeView; now: number; live?: boolean }) {
  const p = MODELS_COPY.probe
  const obs = observations(result.observations ?? {})
  return (
    <Box role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined} data-probe-result={result.status}>
      <Flex align="center" gap={2} flexWrap="wrap">
        <ModelStatusChip status={result.status} />
        <Text fontSize="sm">{MODELS_COPY.statusMeans[result.status] ?? ''}</Text>
        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" ml="auto">
          <time dateTime={new Date(result.at).toISOString()}>{p.ran(sinceTime(result.at, now))}</time>
        </Text>
      </Flex>
      {result.steps.length ? (
        <Box as="ul" listStyleType="none" mt={2.5} fontSize="13px">
          {result.steps.map((s, i) => (
            <Flex as="li" key={`${s.step}-${i}`} gap={2} align="baseline" py={0.5}>
              <Text as="span" fontWeight={700} color={s.ok ? 'status.open' : 'status.error'} aria-hidden w="12px" flexShrink={0}>
                {s.ok ? '✓' : '×'}
              </Text>
              <Box minW={0}>
                <Text as="span">
                  <Box as="span" srOnly>
                    {s.ok ? 'Passed: ' : 'Failed: '}
                  </Box>
                  {p.steps[s.step] ?? s.step}
                </Text>
                {s.detail ? (
                  <Text fontSize="12px" color="page.fg-secondary" whiteSpace="pre-wrap" wordBreak="break-word">
                    {s.detail}
                  </Text>
                ) : null}
              </Box>
            </Flex>
          ))}
        </Box>
      ) : null}
      {result.message && result.status !== 'ready' && !result.steps.some((s) => s.detail === result.message) ? (
        <Text fontFamily={MONO} fontSize="12px" color="page.fg-secondary" mt={2} whiteSpace="pre-wrap" wordBreak="break-word">
          {result.message}
        </Text>
      ) : null}
      {obs.length ? (
        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary" mt={2}>
          {obs.join(' · ')}
        </Text>
      ) : null}
    </Box>
  )
}
