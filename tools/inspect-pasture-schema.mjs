// Inspect trusted, already-loaded protobuf serializers. Never send game RPCs.
import { Bridge } from './core.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const b = new Bridge();
b._id = 1000000000 + Math.floor(Math.random() * 1000000000);
try {
  await b.ensure();
  const evidence = await b.evaluate(`(() => {
    const modules = Array.from(System.entries());
    const roots = new Map();
    const manifest = [];
    for (const [path, value] of modules) {
      if (!/pb\\.(?:ts|js)$/.test(path) || !value?.gamepb) continue;
      manifest.push({ path, namespaces: Object.keys(value.gamepb) });
      for (const [name, namespace] of Object.entries(value.gamepb)) {
        if (namespace && typeof namespace === 'object') roots.set(name, namespace);
      }
    }
    const names = new Map();
    const messages = [];
    for (const [ns, root] of roots) for (const [key, type] of Object.entries(root)) {
      if (typeof type !== 'function') continue;
      names.set(type, ns + '.' + key);
      if (typeof type.encode === 'function' && typeof type.decode === 'function') messages.push({ ns, key, type, encode: type.encode });
    }
    const selected = new Set(['animalpb','homesteadpb','globalscenepb','visitpb','friendpb','shoppb','itempb']);
    const out = { manifest, serviceIndex: [], services: [], messages: {}, enums: {}, context: { scene: globalThis.cc?.director?.getScene?.()?.name } };
    for (const [ns, root] of roots) for (const [key, value] of Object.entries(root)) {
      if (typeof value === 'function' && /Service$/.test(key)) out.serviceIndex.push({ name: 'gamepb.' + ns + '.' + key, clientMethods: Object.getOwnPropertyNames(value.prototype).filter(name => name !== 'constructor') });
      if (/ranch|pasture|animal|homestead|lab/i.test(ns)) selected.add(ns);
    }
    // Stubs only call this.rpcCall; provide a local capture object, never a transport.
    for (const [ns, root] of roots) {
      if (!selected.has(ns)) continue;
      for (const [key, value] of Object.entries(root)) {
        if (typeof value === 'object' && value) { out.enums[ns + '.' + key] = value; continue; }
        if (typeof value !== 'function' || !/Service$/.test(key)) continue;
        const service = { name: 'gamepb.' + ns + '.' + key, methods: [] };
        for (const method of Object.getOwnPropertyNames(value.prototype)) {
          if (method === 'constructor' || typeof value.prototype[method] !== 'function') continue;
          let captured;
          value.prototype[method].call({ rpcCall(fn, Req, Reply) { captured = { clientMethod: method, method: fn.name, request: names.get(Req), response: names.get(Reply) }; } }, {});
          if (!captured) throw new Error('Not a local protobuf service stub: ' + key + '.' + method);
          service.methods.push(captured);
        }
        out.services.push(service);
      }
    }
    let events = null;
    const writer = new Proxy({}, { get(_, method) { return (...args) => { events.push({ method: String(method), value: typeof args[0] === 'number' ? args[0] : undefined }); return writer; }; } });
    // Synchronous, temporary wrappers identify nested message types. Restore all
    // serializers in finally before the game event loop can process another task.
    try {
      for (const item of messages) item.type.encode = (value, target) => { events.push({ nested: item.ns + '.' + item.key }); return target || writer; };
      for (const item of messages) {
        if (!selected.has(item.ns)) continue;
        const fields = [];
        for (const key of Object.keys(item.type.prototype)) {
          if (key === 'toJSON') continue;
          const descriptor = Object.getOwnPropertyDescriptor(item.type.prototype, key);
          if (descriptor?.get || descriptor?.set) continue;
          const def = item.type.prototype[key];
          if (typeof def === 'function') continue;
          const repeated = Array.isArray(def);
          const isMap = def && typeof def === 'object' && !repeated && !('low' in def) && !ArrayBuffer.isView(def);
          const sentinel = repeated ? [1] : isMap ? { probe: 1 } : def == null ? {} : typeof def === 'string' ? 'x' : typeof def === 'boolean' ? true : 1;
          events = [];
          try {
            item.encode({ [key]: sentinel }, writer);
            const tag = events.find(event => event.method === 'uint32');
            const nested = events.find(event => event.nested)?.nested;
            const scalar = events.slice(events.indexOf(tag) + 1).find(event => event.method && !['fork','ldelim'].includes(event.method))?.method;
            fields.push({ name: key, number: tag ? tag.value >>> 3 : null, wire: tag ? tag.value & 7 : null, type: isMap ? 'map<' + (events[3]?.method || 'unknown') + ',' + (nested || events[5]?.method || 'unknown') + '>' : nested || scalar || 'unknown', repeated: repeated && scalar !== 'bytes', ...(tag ? {} : { error: 'No tag observed', events }) });
          } catch (error) { fields.push({ name: key, error: String(error.message) }); }
        }
        out.messages[item.ns + '.' + item.key] = fields;
      }
    } finally { for (const item of messages) item.type.encode = item.encode; }
    return out;
  })()`, { timeoutMs: 15000 });
  mkdirSync('out/protocol', { recursive: true });
  const data = { capturedAt: new Date().toISOString(), contextId: b.ctxId, source: 'current game SystemJS protobuf stubs and local serializer probes; no game RPCs', ...evidence };
  writeFileSync('out/protocol/pasture-runtime.json', JSON.stringify(data, null, 2));
  const issues = Object.entries(data.messages).flatMap(([name,fields]) => fields.filter(f=>f.error).map(f=>({message:name,...f})));
  console.log(JSON.stringify({ services: data.services, messageCount: Object.keys(data.messages).length, fieldIssues: issues, artifact: 'out/protocol/pasture-runtime.json' }));
} finally { b.close(); }
