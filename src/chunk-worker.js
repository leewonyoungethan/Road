// Builds terrain chunk data off the main thread so driving never stutters.
import { TerrainCore } from './terrain-core.js';

let core = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { core = new TerrainCore(m.seed); return; }
  if (m.type === 'build') {
    const d = core.buildChunkData(m.cx, m.cz, m.segs, m.detail, m.opts);
    d.key = m.key; d.lod = m.lod; d.job = m.job;
    const tr = [d.pos.buffer, d.nor.buffer, d.col.buffer, d.idx.buffer];
    for (const k in d.inst) tr.push(d.inst[k].m.buffer, d.inst[k].c.buffer);
    self.postMessage(d, tr);
  }
};
