// 브라우저에서 C++ 을 컴파일하고 실행하는 워커.
// 컴파일러: binji/wasm-clang (clang 8, Apache-2.0). 사용법은 shared.js 의 API 클래스를 따른다.
// 한계: 스레드와 예외(try/throw)는 동작하지 않고, 포인터가 4바이트(wasm32)다.
self.importScripts('shared.js');

const ANSI = /\x1b\[[0-9;]*m/g;
let sink = null;   // 지금 받는 출력 버퍼. null 이면 버린다.

const api = new API({
  async readBuffer(f) { return (await fetch(f)).arrayBuffer(); },
  async compileStreaming(f) { return WebAssembly.compile(await (await fetch(f)).arrayBuffer()); },
  hostWrite(s) { if (sink !== null) sink.push(s); },
});

// 데모가 터미널에 찍는 진행 로그는 필요 없다.
api.hostLog = () => {};
api.hostLogAsync = async (_msg, promise) => await promise;

const CLANG_ARGS = [
  '-cc1', '-emit-obj', '-disable-free',
  '-isysroot', '/',
  '-internal-isystem', '/include/c++/v1',
  '-internal-isystem', '/include',
  '-internal-isystem', '/lib/clang/8.0.1/include',
  '-ferror-limit', '8', '-fmessage-length', '100',
  '-std=c++17', '-O1',
  // 함수 안 static 객체의 초기화 보호(원자 연산)를 이 대상에서는 만들 수 없다. 스레드가 없으니 필요도 없다.
  '-fno-threadsafe-statics',
  '-o', 'test.o', '-x', 'c++', 'test.cc',
];

// libc++ 의 일부 정렬 템플릿이 long double 비교 함수를 끌어오는데 이 sysroot 에는 그 함수가 없어 링크가 실패한다.
// 실제로 호출되는 일은 없으므로 빈 함수로 막아 둔다.
const STUBS = '\nextern "C" {\n' + ['__lttf2', '__gttf2', '__letf2', '__getf2', '__eqtf2', '__netf2', '__unordtf2']
  .map(n => `int ${n}(long double, long double) { return 0; }`).join('\n') + '\n}\n';

async function compile(code) {
  const diag = [];
  sink = diag;
  try {
    await api.ready;
    api.memfs.addFile('test.cc', code + STUBS);
    const clang = await api.getModule('clang');
    await api.run(clang, 'clang', ...CLANG_ARGS);
    await api.link('test.o', 'test.wasm');
    return { ok: true };
  } catch (e) {
    const log = diag.join('').replace(ANSI, '').replace(/\n?Error: process exited with code \d+\.?\s*$/, '').trim();
    return { ok: false, log: log || String(e && e.message || e) };
  } finally {
    sink = null;
  }
}

// 입력(stdin)마다 한 번씩 실행해 출력을 모은다.
async function runAll(stdins) {
  const mod = await WebAssembly.compile(api.memfs.getFileContents('test.wasm'));
  const results = [];
  for (const stdin of stdins) {
    const out = [];
    sink = out;
    api.memfs.setStdinStr(stdin);
    let exit = 0, err = '';
    try {
      await api.run(mod, 'test.wasm');
    } catch (e) {
      if (e && e.code !== undefined) exit = e.code;
      else { exit = -1; err = String(e && e.message || e); }
    } finally {
      sink = null;
    }
    let text = out.join('');
    const k = text.indexOf('\x1b[91mError:');   // App.run 이 실패할 때 덧붙이는 메시지
    if (k >= 0) text = text.slice(0, k);
    results.push({ stdout: text.replace(ANSI, ''), exit, err });
  }
  return results;
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.warm) {
    await api.ready;
    await api.getModule('clang');
    await api.getModule('lld');
    self.postMessage({ warmed: true });
    return;
  }
  let result;
  try {
    const c = await compile(m.code);
    result = c.ok ? { stage: 'done', results: await runAll(m.stdins) } : { stage: 'compile', log: c.log };
  } catch (e) {
    result = { stage: 'compile', log: '내부 오류: ' + String(e && e.message || e) };
  }
  self.postMessage({ id: m.id, result });
};
