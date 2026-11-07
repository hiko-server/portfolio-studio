import { useState } from 'react'
import { Box, Flex, Progress, Table, TableContainer, Tbody, Td, Text, Th, Thead, Tr } from '@chakra-ui/react'
import { MONO } from '../shell/ui'
import SegmentedTabs, { tabPanelProps } from '../shell/SegmentedTabs'
import { useScrollRegion } from '../shell/scrollRegion'
import { MODELS_COPY } from './copy'
import { formatCost, usageByModel } from './assistantFormat'
import type { UsageAnswer } from './types'

const U = MODELS_COPY.usage
const n = (v: number) => Math.round(v).toLocaleString('en')

/**
 * Models → [03] Usage (PRODUCT §8.1, design §7.7): today's weighted tokens
 * against the daily limit, then a table per model for this month or today —
 * calls, tokens in (uncached and cache writes), cached, out, reasoning — as
 * each provider reported them. Rows with estimated calls say so. A cost
 * appears only where every call reported one; there are no price tables.
 */
export default function UsageTable({ usage, now }: { usage: UsageAnswer; now: number }) {
  const [period, setPeriod] = useState<'month' | 'today'>('month')
  const [ref, region] = useScrollRegion(U.tableLabel(period === 'month' ? U.month : U.todayHead))
  const rows = usageByModel(usage.rows, period, now)
  const anyCost = rows.some((r) => r.reportedMicroUsd !== null && r.reportedMicroUsd > 0)
  const anyReasoning = rows.some((r) => r.reasoning > 0)
  const limit = usage.today.limit
  const share = limit && limit > 0 ? Math.min(100, (usage.today.weighted / limit) * 100) : 0
  const resets = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(usage.today.resetsAt)

  return (
    <Box>
      <Box border="1px solid" borderColor="page.border" borderRadius="xl" px={4} py={3}>
        <Flex align="baseline" justify="space-between" gap={3} flexWrap="wrap">
          <Text fontFamily={MONO} fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="page.fg-secondary">
            {U.today}
          </Text>
          <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary">
            {U.resets(resets)}
          </Text>
        </Flex>
        <Text fontSize="sm" mt={1} className="tnum">
          {limit !== null ? U.ofLimit(n(usage.today.weighted), n(limit)) : n(usage.today.weighted)}
        </Text>
        {limit ? (
          <Progress
            value={share}
            size="xs"
            mt={2}
            borderRadius="full"
            colorScheme={share >= 90 ? 'red' : share >= 70 ? 'orange' : 'purple'}
            bg="page.bg-overlay"
            aria-label={U.ofLimit(n(usage.today.weighted), n(limit))}
          />
        ) : null}
        <Text fontSize="xs" color="page.fg-secondary" mt={2}>
          {U.caps(usage.caps.modelTurnsPerRun, usage.caps.toolCallsPerRun, n(usage.caps.runTokens))}
        </Text>
      </Box>

      <Flex mt={5} mb={3} align="center" justify="space-between" gap={3} flexWrap="wrap">
        <SegmentedTabs
          items={[
            { key: 'month', label: U.month },
            { key: 'today', label: U.todayHead },
          ]}
          value={period}
          onSelect={setPeriod}
          label={U.tableLabel('')}
          idPrefix="ai-usage"
          size="sm"
        />
      </Flex>
      <Box {...tabPanelProps('ai-usage', period)}>
        {rows.length ? (
          <TableContainer ref={ref} {...region} border="1px solid" borderColor="page.border" borderRadius="xl" _focusVisible={{ outline: '2px solid', outlineColor: 'accent.500', outlineOffset: '2px' }}>
            <Table size="sm" variant="unstyled">
              <Thead>
                <Tr borderBottom="1px solid" borderColor="page.border">
                  <Th textTransform="none" letterSpacing="normal" fontSize="12px" color="page.fg-secondary" py={2.5}>
                    {U.cols.model}
                  </Th>
                  {[U.cols.calls, U.cols.in, U.cols.cached, U.cols.out, ...(anyReasoning ? [U.cols.reasoning] : []), ...(anyCost ? [U.cols.cost] : [])].map((h) => (
                    <Th key={h} isNumeric textTransform="none" letterSpacing="normal" fontSize="12px" color="page.fg-secondary" py={2.5}>
                      {h}
                    </Th>
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((r) => {
                  const est = r.estimatedCalls > 0 ? '~' : ''
                  return (
                    <Tr key={r.key} borderBottom="1px solid" borderColor="page.border" _last={{ borderBottom: 'none' }}>
                      <Td py={2.5}>
                        <Text fontSize="13px">{r.providerLabel ?? U.removed}</Text>
                        <Text fontFamily={MONO} fontSize="11px" color="page.fg-secondary">
                          {r.model}
                          {r.estimatedCalls ? ` · ${U.estimated}` : ''}
                        </Text>
                      </Td>
                      <Td isNumeric className="tnum" fontSize="13px">
                        {n(r.calls)}
                      </Td>
                      <Td isNumeric className="tnum" fontSize="13px">
                        {est}
                        {n(r.usageIn + r.cacheWrite)}
                      </Td>
                      <Td isNumeric className="tnum" fontSize="13px">
                        {n(r.cachedRead)}
                      </Td>
                      <Td isNumeric className="tnum" fontSize="13px">
                        {est}
                        {n(r.usageOut)}
                      </Td>
                      {anyReasoning ? (
                        <Td isNumeric className="tnum" fontSize="13px">
                          {n(r.reasoning)}
                        </Td>
                      ) : null}
                      {anyCost ? (
                        <Td isNumeric className="tnum" fontSize="13px" title={U.reported}>
                          {r.reportedMicroUsd !== null ? formatCost(r.reportedMicroUsd) : '—'}
                        </Td>
                      ) : null}
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          </TableContainer>
        ) : (
          <Text fontSize="sm" color="page.fg-secondary">
            {U.none}
          </Text>
        )}
      </Box>
    </Box>
  )
}
