/**
 * A hook run as a component would run it, with no DOM and no renderer: React's
 * own hooks (useState, useRef, useCallback, useMemo, useEffect) are answered by
 * a small dispatcher installed for the length of each render, so a hook's real
 * code — its refs, its state updates and the effects they re-run — is what the
 * test drives. A state update schedules one re-render on a microtask (updates
 * in the same tick batch, as in React 18); effects run after the render that
 * changed their deps, the previous cleanup first; `unmount` runs every cleanup.
 *
 * It reaches React's current dispatcher, which React exports for renderers
 * (18: __SECRET_INTERNALS…ReactCurrentDispatcher, 19: __CLIENT_INTERNALS….H).
 * If neither is there (a React upgrade moved it), it throws rather than run
 * the hook against nothing.
 */
import * as React from 'react'

type Deps = readonly unknown[] | undefined
type EffectSlot = { kind: 'effect'; deps: Deps; cleanup: void | (() => void) }

type Slot = { kind: 'state'; value: unknown; set: (v: unknown) => void } | { kind: 'ref'; ref: { current: unknown } } | { kind: 'memo'; value: unknown; deps: Deps } | EffectSlot

function dispatcherHost(): { get: () => unknown; set: (d: unknown) => void } {
  const r = React as unknown as Record<string, any>
  const v18 = r.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher
  if (v18 && 'current' in v18) return { get: () => v18.current, set: (d) => (v18.current = d) }
  const v19 = r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  if (v19 && 'H' in v19) return { get: () => v19.H, set: (d) => (v19.H = d) }
  throw new Error('hookHarness: React’s current dispatcher was not found (did a React upgrade move it?)')
}

const changed = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

export type HookHandle<T> = {
  /** What the hook returned at its latest render. */
  readonly current: T
  /** Renders it again now (as a parent's re-render would). */
  rerender: () => void
  /** Runs every effect's cleanup; later state updates render nothing. */
  unmount: () => void
}

export function renderHook<T>(hook: () => T): HookHandle<T> {
  const host = dispatcherHost()
  const slots: Slot[] = []
  let cursor = 0
  let pending: Array<() => void> = []
  let scheduled = false
  let unmounted = false
  let latest: T

  const slot = <S extends Slot>(make: () => S): S => {
    const k = cursor++
    if (!slots[k]) slots[k] = make()
    return slots[k] as S
  }

  const schedule = () => {
    if (scheduled || unmounted) return
    scheduled = true
    queueMicrotask(render)
  }

  const dispatcher = {
    useState(init: unknown) {
      const s = slot(() => {
        const box: Extract<Slot, { kind: 'state' }> = {
          kind: 'state',
          value: typeof init === 'function' ? (init as () => unknown)() : init,
          set: (v: unknown) => {
            const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(box.value) : v
            if (Object.is(next, box.value)) return
            box.value = next
            schedule()
          },
        }
        return box
      })
      return [s.value, s.set]
    },
    useRef(init: unknown) {
      return slot(() => ({ kind: 'ref' as const, ref: { current: init } })).ref
    },
    useMemo(make: () => unknown, deps: Deps) {
      const k = cursor
      const s = slot(() => ({ kind: 'memo' as const, value: make(), deps }))
      if (s.deps !== deps && changed(s.deps, deps)) slots[k] = { kind: 'memo', value: make(), deps }
      return (slots[k] as Extract<Slot, { kind: 'memo' }>).value
    },
    useCallback(fn: unknown, deps: Deps) {
      return dispatcher.useMemo(() => fn, deps)
    },
    useEffect(create: () => void | (() => void), deps: Deps) {
      let fresh = false
      const s = slot<EffectSlot>(() => {
        fresh = true
        return { kind: 'effect', deps, cleanup: undefined }
      })
      if (!fresh && !changed(s.deps, deps)) return
      s.deps = deps
      pending.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup()
        s.cleanup = create()
      })
    },
  }

  function render() {
    scheduled = false
    if (unmounted) return
    const before = host.get()
    host.set(dispatcher)
    cursor = 0
    try {
      latest = hook()
    } finally {
      host.set(before)
    }
    const effects = pending
    pending = []
    for (const run of effects) run()
  }

  render()
  return {
    get current() {
      return latest
    },
    rerender: render,
    unmount() {
      unmounted = true
      for (const s of slots) if (s?.kind === 'effect' && typeof s.cleanup === 'function') s.cleanup()
    },
  }
}
