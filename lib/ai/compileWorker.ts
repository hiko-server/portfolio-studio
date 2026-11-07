import { parentPort } from 'worker_threads'
import { runCompileJob, type CompileJob } from './compileJob'

/**
 * The compile worker's entry (SERVER-ONLY, design §4.5): started by
 * lib/ai/compile with a 256 MB heap, it answers one job at a time and
 * says it is ready once its modules have loaded (the boot limit counts
 * until then). webpack emits it as a chunk of its own; the standalone
 * output carries it through next.config.js `outputFileTracingIncludes`.
 */

const port = parentPort
if (port) {
  port.on('message', (job: CompileJob) => {
    void runCompileJob(job).then((answer) => port.postMessage(answer))
  })
  port.postMessage({ ready: true })
}
