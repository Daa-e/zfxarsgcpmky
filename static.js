// 서버 없이 도는 정적 모드. dist 에만 들어간다. (build-static.js 가 복사한다)
// - 비밀번호로 data.enc 를 풀어 노트와 문제를 메모리에 올린다.
// - /api/* 호출을 가로채서 같은 모양의 답을 준다. 코드는 브라우저 안의 clang(wasm)이 컴파일한다.
(function () {
  const WASM = 'wasm/';
  const KEY_STORE = 'cwkey';
  const ITER = 300000;
  let DATA = null;
  let runner = null;

  const norm = s => String(s).replace(/\r/g, '').split('\n').map(x => x.trimEnd()).join('\n').trim();
  const b64 = {
    enc: u8 => btoa(String.fromCharCode(...u8)),
    dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  async function decryptWith(key, buf) {
    const iv = buf.slice(16, 28), ct = buf.slice(28);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function deriveKey(pw, salt) {
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  // 로그인 창은 한 번만 만들고, 틀리면 같은 창에서 다시 받는다.
  function makeGate() {
    const st = document.createElement('style');
      st.textContent = `#gate{position:fixed;inset:0;z-index:99;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:16px}
      #gate form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px 24px;width:100%;max-width:360px;box-shadow:var(--shadow)}
      #gate h2{margin:0 0 4px;font-size:20px}#gate p{margin:0 0 14px;color:var(--mute);font-size:14px}
      #gate input[type=password]{width:100%;padding:12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:16px}
      #gate label{display:flex;gap:8px;align-items:center;margin:12px 0;font-size:14px;color:var(--mute)}
      #gate button{width:100%;padding:12px;border-radius:9px;border:0;background:var(--accent);color:var(--accent-fg);font-size:16px;font-weight:700;cursor:pointer}
      #gate .err{color:var(--bad);margin:10px 0 0;min-height:1.2em}`;
    document.head.appendChild(st);
    const g = document.createElement('div');
    g.id = 'gate';
    g.innerHTML = `<form><h2>C++</h2><p>비밀번호를 입력하세요.</p>
      <input type="password" id="gpw" autocomplete="current-password" autofocus>
      <label><input type="checkbox" id="grem" checked> 이 기기에서 비밀번호 기억</label>
      <button type="submit">열기</button><div class="err" id="gerr"></div></form>`;
    document.body.appendChild(g);
    return g;
  }

  function waitSubmit(g) {
    return new Promise(resolve => {
      g.querySelector('form').onsubmit = ev => {
        ev.preventDefault();
        resolve({ pw: g.querySelector('#gpw').value, remember: g.querySelector('#grem').checked });
      };
    });
  }

  async function unlock() {
    const buf = new Uint8Array(await (await fetch('data.enc', { cache: 'no-cache' })).arrayBuffer());
    const salt = buf.slice(0, 16);

    const saved = store.get(KEY_STORE);
    if (saved) {
      try {
        const key = await crypto.subtle.importKey('raw', b64.dec(saved), 'AES-GCM', false, ['decrypt']);
        DATA = await decryptWith(key, buf);
        return;
      } catch { store.del(KEY_STORE); }   // 비밀번호가 바뀌었거나 데이터가 새로 암호화됐다.
    }
    const gate = makeGate();
    for (;;) {
      const { pw, remember } = await waitSubmit(gate);
      const err = gate.querySelector('#gerr');
      err.textContent = '확인하는 중...';
      try {
        const key = await deriveKey(pw, salt);
        DATA = await decryptWith(key, buf);
        if (remember) store.set(KEY_STORE, b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
        gate.remove();
        return;
      } catch {
        err.textContent = '비밀번호가 틀렸습니다.';
        gate.querySelector('#gpw').select();
      }
    }
  }

  // ---- 컴파일 러너 (워커 하나를 재사용하고, 오래 쓰면 새로 만든다) ----
  class Runner {
    constructor() { this.n = 0; this.spawn(); }
    spawn() {
      this.jobs = 0;
      this.pending = new Map();
      this.worker = new Worker(WASM + 'runner.js');
      this.worker.onmessage = e => {
        const p = this.pending.get(e.data.id);
        if (p) { this.pending.delete(e.data.id); p(e.data.result); }
      };
    }
    warm() { this.worker.postMessage({ warm: true }); }
    run(code, stdins, timeoutMs) {
      if (this.jobs >= 25) { this.worker.terminate(); this.spawn(); }   // memfs 가 계속 커지는 것을 막는다.
      this.jobs++;
      return new Promise(resolve => {
        const id = ++this.n;
        const t = setTimeout(() => {
          this.pending.delete(id);
          this.worker.terminate();
          this.spawn();
          resolve({ stage: 'timeout' });
        }, timeoutMs);
        this.pending.set(id, r => { clearTimeout(t); resolve(r); });
        this.worker.postMessage({ id, code, stdins });
      });
    }
  }

  async function run(body) {
    const prob = (DATA.problems[body.note] || []).find(p => p.id === body.problem);
    if (!prob) return { error: '문제를 찾지 못했습니다.' };

    // 출력 예측은 컴파일하지 않는다. 정답이 이미 검증되어 들어 있다.
    if (prob.mode === 'predict') {
      const exp = norm(body.predict || ''), act = norm(prob.answer);
      return { stage: 'done', ok: exp === act, log: '', predict: true, results: [{ pass: exp === act, actual: act, expect: exp, stdin: '' }] };
    }
    if (prob.web === false) return { unsupported: true };

    runner = runner || new Runner();
    const stdins = prob.tests.map(t => t.stdin || '');
    const r = await runner.run(String(body.code || '') + '\n' + (prob.harness || ''), stdins, 15000 + 4000 * stdins.length);
    if (r.stage === 'compile') return { stage: 'compile', ok: false, log: r.log };
    if (r.stage === 'timeout') {
      const results = prob.tests.map(t => ({ pass: false, timedOut: true, stdin: t.stdin || '', actual: '', expect: norm(t.expect) }));
      return { stage: 'done', ok: false, log: '', results };
    }
    const results = prob.tests.map((t, i) => {
      const x = r.results[i];
      return { pass: x.exit === 0 && norm(x.stdout) === norm(t.expect), timedOut: false, exit: x.exit,
        stdin: t.stdin || '', actual: norm(x.stdout), expect: norm(t.expect), stderr: x.err || '' };
    });
    return { stage: 'done', ok: results.every(r => r.pass), log: '', results };
  }

  async function handle(url, opt) {
    let m;
    if (url === '/api/notes') return DATA.notes;
    if ((m = url.match(/^\/api\/note\/([A-H]\d{2})$/))) {
      const n = DATA.notes.find(x => x.id === m[1]);
      return n ? { ...n, markdown: DATA.markdown[m[1]], easy: (DATA.easy || {})[m[1]] || '', speak: (DATA.speak || {})[m[1]] || '' } : { error: 'no note' };
    }
    if ((m = url.match(/^\/api\/problems\/([A-H]\d{2})$/))) return DATA.problems[m[1]] || [];
    if (url === '/api/run') return run(JSON.parse(opt.body));
    return { error: 'unknown ' + url };
  }

  window.CW_STATIC = {
    unlock,
    handle,
    warm() { runner = runner || new Runner(); runner.warm(); },
    get data() { return DATA; },
    forgetPassword() { store.del(KEY_STORE); },
  };
})();
