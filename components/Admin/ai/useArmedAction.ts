import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the element must have been on screen, in a focused window, before its action arms (design §5.3). */
export const ARM_AFTER_MS = 1000

/**
 * Arming for an action a person must mean (design §5.3): consent's Allow,
 * and Approve on a change card. The action stays disabled until, all at
 * once,
 *
 *   - the element (the card holding the button) has been at least half on
 *     screen — or filling the viewport, when it is taller than that — for 1
 *     second, in a window that had the focus (document.hasFocus()) for all of
 *     that second; and
 *   - after that second began, a pointer moved or pressed inside the
 *     element, or the keyboard focus entered it (or is inside it). On a
 *     device whose primary pointer is coarse (a phone: no hover), this
 *     condition is dropped.
 *
 * Losing the focus or scrolling the element away starts over. This is what
 * stops DoubleClickjacking — a page that gets a double click and swaps this
 * window in under the second click: the window gains the focus at that
 * moment, so the second has not passed, and no pointer event inside the
 * element came after it began. `frame-ancestors 'none'` already stops
 * framing. The hook never moves the focus itself: a card that appears never
 * takes it.
 *
 *   const { ref, armed } = useArmedAction<HTMLDivElement>(enabled)
 *   <Box ref={ref}> … <Button isDisabled={!armed} onClick={() => armed && go()}> … </Box>
 */
export function useArmedAction<T extends HTMLElement>(enabled = true): { ref: (el: T | null) => void; armed: boolean } {
  const [el, setEl] = useState<T | null>(null)
  const [armed, setArmed] = useState(false)
  const state = useRef({ visible: false, focused: false, since: 0, intent: false })
  const timer = useRef<number | null>(null)

  const ref = useCallback((node: T | null) => setEl(node), [])

  useEffect(() => {
    const s = state.current
    const reset = () => {
      s.since = 0
      s.intent = false
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      setArmed(false)
    }
    if (!el || !enabled) {
      reset()
      return
    }
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    const evaluate = () => {
      const steady = s.visible && s.focused
      if (!steady) return reset()
      if (!s.since) {
        s.since = performance.now()
        s.intent = false
      }
      const elapsed = performance.now() - s.since
      if (elapsed < ARM_AFTER_MS) {
        setArmed(false)
        if (timer.current === null) {
          timer.current = window.setTimeout(() => {
            timer.current = null
            evaluate()
          }, ARM_AFTER_MS - elapsed + 5)
        }
        return
      }
      // Keyboard focus already inside the element counts as well: the element never takes it by itself.
      setArmed(coarse || s.intent || el.contains(document.activeElement))
    }
    const onIntent = () => {
      // Only intent shown after the steady second began counts (see above).
      if (!s.since) return
      s.intent = true
      evaluate()
    }
    const onFocus = () => {
      s.focused = document.hasFocus() && document.visibilityState === 'visible'
      evaluate()
    }
    const onBlur = () => {
      s.focused = false
      evaluate()
    }

    s.focused = document.hasFocus() && document.visibilityState === 'visible'
    s.visible = false
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const rootH = entry.rootBounds?.height ?? window.innerHeight
          s.visible = entry.isIntersecting && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= rootH * 0.5)
        }
        evaluate()
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    )
    io.observe(el)
    el.addEventListener('pointermove', onIntent)
    el.addEventListener('pointerdown', onIntent)
    el.addEventListener('focusin', onIntent)
    el.addEventListener('focusout', evaluate)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onFocus)
    evaluate()
    return () => {
      io.disconnect()
      el.removeEventListener('pointermove', onIntent)
      el.removeEventListener('pointerdown', onIntent)
      el.removeEventListener('focusin', onIntent)
      el.removeEventListener('focusout', evaluate)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onFocus)
      reset()
    }
  }, [el, enabled])

  return { ref, armed: armed && enabled }
}
