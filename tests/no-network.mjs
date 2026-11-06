// Unit tests never reach the network: every outbound connection and DNS
// lookup to anything but this machine is refused (the caller sees a failed
// connection, like an offline machine) and fails the test file that made
// it. A test talks to a stub (globalThis.fetch, safeFetch's `resolve`
// seam) or to a server it started on 127.0.0.1. Installed by
// tests/register.mjs in `node --test` runs (the runner and each test file's
// process); scripts that borrow register.mjs for its TypeScript resolution
// (scripts/ci/fixture-store.mjs, scripts/bake-images.mjs) are unaffected.
import dns from 'node:dns'
import net from 'node:net'

/** What was refused, in order (tests/no-network.test.ts reads and clears it). */
const refused = []
globalThis[Symbol.for('portfolio-studio.tests.refusedNetwork')] = refused

/** This machine: loopback names and addresses, the unspecified address, an IPC path. */
function isLocal(host) {
  const h = String(host ?? 'localhost')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  return (
    h === '' ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(h)
  )
}

function refusal(what, target) {
  refused.push(`${what} ${target}`)
  const err = new Error(`unit tests may not reach the network (${what} ${target}): stub fetch or the resolver instead`)
  err.code = what === 'dns' ? 'ENOTFOUND' : 'ECONNREFUSED'
  return err
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const [options = {}] = net._normalizeArgs(args)
  if (!options.path && !isLocal(options.host)) {
    const err = refusal('connect', `${options.host}:${options.port}`)
    process.nextTick(() => this.destroy(err))
    return this
  }
  return connect.apply(this, args)
}

const lookup = dns.lookup
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLocal(hostname)) {
    const cb = rest[rest.length - 1]
    const err = refusal('dns', hostname)
    if (typeof cb === 'function') process.nextTick(() => cb(err))
    return {}
  }
  return lookup.call(this, hostname, ...rest)
}

const promisesLookup = dns.promises.lookup
dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
  if (!isLocal(hostname)) return Promise.reject(refusal('dns', hostname))
  return promisesLookup.call(this, hostname, ...rest)
}

process.on('exit', () => {
  if (!refused.length) return
  const lines = Array.from(new Set(refused)).map((r) => `  - ${r}`)
  process.stderr.write(`\nThis test file tried to reach the network (refused):\n${lines.join('\n')}\n`)
  process.exitCode = 1
})
