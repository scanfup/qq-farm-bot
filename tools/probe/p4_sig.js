(() => {
  const t = globalThis.tsdk;
  const safe = (fn, d) => { try { return fn(); } catch (e) { return 'ERR:' + e.message; } };
  const sig = (n) => {
    const f = t[n];
    if (typeof f !== 'function') return { name: n, type: typeof f };
    return {
      name: n,
      type: 'function',
      length: f.length,
      fname: safe(() => String(f.name)),
      head: safe(() => String(f).slice(0, 260)),
    };
  };
  const out = {
    heap: {
      HEAPU8: safe(() => t.HEAPU8 ? ('Uint8Array len=' + t.HEAPU8.length) : 'none'),
      HEAP32: safe(() => t.HEAP32 ? ('Int32Array len=' + t.HEAP32.length) : 'none'),
    },
    fns: [
      '_create_buffer', '_destroy_buffer', '_get_result', '_get_msg_len', '_get_msg',
      '_encrypt_data', '_decrypt_data', '_encrypt_data_v2', '_decrypt_data_v2',
      '_generate_token', '_init_runtime', '_get_encrypted_init_info',
      '_get_data_to_server', '_send_data_from_server', '_process_received_data',
      '_send_heartbeat_tick', '_check_func_array', '_add_js_info',
      '_send_to_gs', '_send_to_gs_fast', '_detect_speed_hack',
      '_report_gamejs_md5', '_report_env_hash', '_set_feature_gray_value',
    ].map(sig),
    tsdk_extra: safe(() => {
      // tsdk 上是否已有高层 wrapper（非下划线开头）
      return Object.keys(t).filter(k => !k.startsWith('_') && k !== 'calledRun');
    }),
    wasmModuleInfo: safe(() => {
      const r = {};
      for (const k of ['wasmMemory', 'wasmExports', 'asm', 'Module', 'runtimeInitialized']) {
        r[k] = typeof t[k];
      }
      return r;
    }),
  };
  return JSON.stringify(out, null, 1);
})()
