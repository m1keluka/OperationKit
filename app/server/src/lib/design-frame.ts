/**
 * Design-review frame: rewrite a fetched HTML page so Command Center can
 * host it in a sandboxed iframe and talk to an injected overlay (click-to-
 * comment, in-place text). Pure — no fetch, no Express.
 */

const PRIVATE_V4 = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
]

export function isBlockedPreviewHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\./, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '::1' || h === '[::1]' || h === '0.0.0.0') return true
  return PRIVATE_V4.some(re => re.test(h))
}

export function parsePreviewUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (isBlockedPreviewHost(u.hostname)) return null
  return u
}

export function baseHrefFor(sourceUrl: string): string {
  const u = new URL(sourceUrl)
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname.replace(/[^/]+$/, '')
  return `${u.origin}${path || '/'}`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Overlay that postMessages picks/text-edits to the parent Command Center origin. */
export function designBridgeScript(parentOrigin: string): string {
  const origin = JSON.stringify(parentOrigin)
  return `<script data-cc-design-bridge="1">
(function(){
  var PARENT = ${origin};
  var mode = 'idle';
  var hover = null;
  var editing = null;
  function cssPath(el){
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + String(testid).replace(/"/g, '\\\\"') + '"]';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var name = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === cur.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) name += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(name);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function payload(el, extra){
    var r = el.getBoundingClientRect();
    var out = {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: String(el.innerText || '').trim().slice(0, 240),
      bbox: { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight }
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }
  function outline(el, color){
    if (hover && hover !== el && hover !== editing) try { hover.style.outline = ''; } catch (e) {}
    hover = el;
    if (el && el !== editing) try { el.style.outline = '2px solid ' + color; } catch (e2) {}
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== PARENT) return;
    if (!e.data) return;
    if (e.data.type === 'cc-design-mode') {
      mode = e.data.mode || 'idle';
      document.documentElement.style.cursor = mode === 'idle' ? '' : 'crosshair';
      if (mode === 'idle' && hover && hover !== editing) {
        try { hover.style.outline = ''; } catch (e3) {}
        hover = null;
      }
    }
    if (e.data.type === 'cc-design-focus' && e.data.selector) {
      try {
        var t = document.querySelector(e.data.selector);
        if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); outline(t, '#c2410c'); }
      } catch (e4) {}
    }
  });
  document.addEventListener('mouseover', function (e) {
    if (mode === 'idle') return;
    var el = e.target;
    if (!el || !el.tagName) return;
    outline(el, mode === 'text' ? '#2563eb' : '#c2410c');
  }, true);
  document.addEventListener('click', function (e) {
    if (mode === 'idle') return;
    var el = e.target;
    if (!el || !el.tagName) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'comment') {
      window.parent.postMessage(Object.assign({ type: 'cc-design-pick' }, payload(el)), PARENT);
      return;
    }
    if (mode === 'text') {
      if (editing && editing !== el) {
        try { editing.removeAttribute('contenteditable'); editing.style.outline = ''; } catch (e5) {}
      }
      editing = el;
      var before = String(el.innerText || '');
      try { el.setAttribute('contenteditable', 'true'); el.style.outline = '2px solid #2563eb'; el.focus(); } catch (e6) {}
      function done() {
        el.removeEventListener('blur', done);
        try { el.removeAttribute('contenteditable'); el.style.outline = ''; } catch (e7) {}
        var after = String(el.innerText || '');
        if (after !== before) {
          window.parent.postMessage(Object.assign({ type: 'cc-design-text', before: before, after: after }, payload(el)), PARENT);
        }
        editing = null;
      }
      el.addEventListener('blur', done);
    }
  }, true);
  try { window.parent.postMessage({ type: 'cc-design-ready' }, PARENT); } catch (e8) {}
})();
<\/script>`
}

/**
 * Drop the preview's own JS. Next/Vite hydrating inside the sandboxed frame
 * reads window.location (`/api/objectives/:id/design-frame`) and replaces
 * the SSR page with "this page couldn't load". CSS/images stay; the canvas
 * overlay is the only script we inject afterward.
 */
export function stripPreviewScripts(html: string): string {
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  out = out.replace(/<script\b[^>]*\/\s*>/gi, '')
  out = out.replace(/<link\b[^>]*>/gi, tag => {
    if (/\brel\s*=\s*["']modulepreload["']/i.test(tag)) return ''
    if (/\bas\s*=\s*["']script["']/i.test(tag)) return ''
    return tag
  })
  return out
}

export function rewriteDesignHtml(html: string, opts: { sourceUrl: string; parentOrigin: string }): string {
  const base = escapeAttr(baseHrefFor(opts.sourceUrl))
  const bridge = designBridgeScript(opts.parentOrigin)
  let out = stripPreviewScripts(html)
  out = out.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, m => `${m}\n<base href="${base}">`)
  } else {
    out = `<!DOCTYPE html><head><base href="${base}"></head>${out}`
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${bridge}</body>`)
  } else {
    out += bridge
  }
  return out
}

export function frameErrorPage(message: string): string {
  const safe = escapeAttr(message)
  return `<!DOCTYPE html><html><body style="font:14px/1.4 system-ui;padding:24px;color:#667085">
<p>${safe}</p></body></html>`
}
