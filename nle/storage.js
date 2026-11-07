// What the editor keeps in the browser for its page's address (its layout, its overlays, what each panel shows). The app's
// window opens the studio at 127.0.0.1, where it opened localhost, so that a film running in a frame of the editor's
// (nle/viewport.js) is another site and gets a process of its own: once, what was kept at localhost is brought here, before
// the editor reads any of it.
const MOVED = 'ephemeris:moved';
let had = null;
try { had = localStorage.getItem(MOVED); } catch { had = '1'; }
if (location.hostname === '127.0.0.1' && !had) {
  await new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.hidden = true;
    f.src = `http://localhost:${location.port}/nle/storage.html`;
    const done = () => { removeEventListener('message', got); f.remove(); resolve(); };
    const got = (e) => {
      if (e.source !== f.contentWindow) return;
      try { for (const [k, v] of Object.entries(e.data?.ephemerisStorage ?? {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v); } catch { /* (full, or blocked: the editor starts as new) */ }
      done();
    };
    addEventListener('message', got);
    setTimeout(done, 3000);
    document.documentElement.append(f);
  });
  try { localStorage.setItem(MOVED, '1'); } catch { /* kept nowhere: asked again next time */ }
}
