// WASI preview1 host for the eight imports used by the pinned FSRS executable.
// Runs in an Obsidian Web Worker; the Node bridge is only for the smoke test.
const port = typeof self === 'undefined' ? require('node:worker_threads').parentPort : self;
const post = value => port.postMessage(value);
async function run(workerData) {
  const input = new TextEncoder().encode(JSON.stringify(workerData.input));
  let position = 0, output = '', instance;
  const memory = () => new DataView(instance.exports.memory.buffer);
  const imports = {
    random_get: (ptr, len) => { for (let start=0; start<len; start+=65536) crypto.getRandomValues(new Uint8Array(instance.exports.memory.buffer, ptr+start, Math.min(65536,len-start))); return 0; },
    environ_sizes_get: (count, size) => { memory().setUint32(count, 0, true); memory().setUint32(size, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (clock, _precision, result) => {
      if (clock !== 0 && clock !== 1) return 28;
      memory().setBigUint64(result, BigInt(Math.floor((clock === 0 ? Date.now() : performance.now()) * 1e6)), true); return 0;
    },
    sched_yield: () => 0,
    proc_exit: code => { throw { wasiExit: code }; },
  };
  imports.fd_read = (fd, iovs, count, nread) => {
    if (fd !== 0) return 8;
    const view = new DataView(instance.exports.memory.buffer);
    let size = 0;
    for (let i = 0; i < count; i++) {
      const ptr = view.getUint32(iovs + i * 8, true), len = view.getUint32(iovs + i * 8 + 4, true);
      const take = Math.min(len, input.length - position);
      new Uint8Array(instance.exports.memory.buffer, ptr, take).set(input.subarray(position, position + take));
      position += take; size += take;
    }
    view.setUint32(nread, size, true); return 0;
  };
  const decoder = new TextDecoder();
  imports.fd_write = (fd, iovs, count, nwritten) => {
    if (fd !== 1 && fd !== 2) return 8;
    const view = new DataView(instance.exports.memory.buffer); let size = 0;
    for (let i = 0; i < count; i++) {
      const ptr = view.getUint32(iovs + i * 8, true), len = view.getUint32(iovs + i * 8 + 4, true); size += len;
      const text = decoder.decode(new Uint8Array(instance.exports.memory.buffer, ptr, len), { stream: true });
      if (fd === 1) output += text; else post({ diagnostic: text });
    }
    view.setUint32(nwritten, size, true);
    let boundary;
    while ((boundary = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, boundary); output = output.slice(boundary + 1);
      try { post(JSON.parse(line)); } catch { /* Non-JSON diagnostics are not results. */ }
    }
    return 0;
  };
  const module = await WebAssembly.compile(Uint8Array.from(atob(workerData.wasm), c => c.charCodeAt(0)));
  instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports });
  try { instance.exports._start(); } catch (e) { if (e?.wasiExit !== 0) throw e; }
}
const receive = data => run(data).catch(e => post({ error: e?.wasiExit !== undefined ? '计算模块退出：'+e.wasiExit : String(e) }));
if (typeof self === 'undefined') receive(require('node:worker_threads').workerData);
else self.onmessage = event => receive(event.data);
