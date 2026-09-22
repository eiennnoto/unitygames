const http = require('node:http');
const { Readable } = require('node:stream');
const { URL } = require('node:url');
const cheerio = require('cheerio');
const httpProxy = require('http-proxy');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const START_URL = process.env.START_URL || 'https://unityroom.com/';
const ALLOW_ANY_EXTERNAL = /^true$/i.test(process.env.ALLOW_ANY_EXTERNAL || 'false');

const allowedExact = new Set(
  (process.env.ALLOWED_HOSTS || 'unityroom.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const allowedSuffixes = (process.env.ALLOWED_HOST_SUFFIXES || '.unityroom.com')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'
]);

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  if (ALLOW_ANY_EXTERNAL) return true;
  if (allowedExact.has(host)) return true;
  return allowedSuffixes.some(suffix => suffix.startsWith('.') && host.endsWith(suffix));
}

function validateTarget(target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    throw new Error('Invalid target URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http/https targets are allowed');
  }
  if (u.username || u.password) {
    throw new Error('Userinfo in target URL is not allowed');
  }
  if (!isAllowedHost(u.hostname)) {
    throw new Error(`Target host is not allowed: ${u.hostname}`);
  }
  return u;
}

function targetFromProxyPath(pathname, search = '') {
  const match = pathname.match(/^\/p\/(https|http)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const host = decodeURIComponent(match[2]);
  const path = match[3] || '/';
  const scheme = match[1];
  const target = `${scheme}://${host}${path}${search}`;
  return validateTarget(target);
}

function proxyPathFor(target) {
  const u = new URL(target);
  const suffix = u.pathname || '/';
  return `/p/${u.protocol.slice(0, -1)}/${u.host}${suffix}${u.search}${u.hash}`;
}

function rewriteUrl(raw, baseUrl, options = {}) {
  if (raw == null) return raw;
  const value = String(raw).trim();
  if (!value || value.startsWith('#') || /^(data:|blob:|javascript:|mailto:|tel:|about:|file:)/i.test(value)) {
    return raw;
  }

  let absolute;
  try {
    absolute = new URL(value, baseUrl);
  } catch {
    return raw;
  }

  if (!['http:', 'https:'].includes(absolute.protocol)) return raw;

  // Already proxied through this server.
  if (absolute.pathname.startsWith('/p/')) return absolute.toString();

  try {
    return proxyPathFor(absolute.href);
  } catch {
    return raw;
  }
}

function rewriteSrcset(value, baseUrl) {
  return String(value)
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const pieces = trimmed.split(/\s+/);
      pieces[0] = rewriteUrl(pieces[0], baseUrl);
      return pieces.join(' ');
    })
    .join(', ');
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, quote, rawUrl) => {
    const rewritten = rewriteUrl(rawUrl, baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  }).replace(/@import\s+(['"])(.*?)\1/gi, (full, quote, rawUrl) => {
    const rewritten = rewriteUrl(rawUrl, baseUrl);
    return `@import ${quote}${rewritten}${quote}`;
  });
}


function rewriteJavaScript(js, baseUrl) {
  // Rewrite absolute HTTP(S) URLs embedded in JavaScript strings/templates/comments.
  // This intentionally targets URL-looking text only; relative URLs are left alone
  // because they already resolve through the proxied page origin/path.
  const source = String(js);

  const rewriteAbsolute = (raw) => {
    const value = raw.replace(/\\\//g, '/');
    let u;
    try {
      u = new URL(value, baseUrl);
    } catch {
      return raw;
    }
    if (!['http:', 'https:'].includes(u.protocol)) return raw;
    try {
      const rewritten = proxyPathFor(u.href);
      // Preserve JavaScript-escaped forward slashes when they were present.
      return raw.includes('\\/') ? rewritten.replaceAll('/', '\\/') : rewritten;
    } catch {
      return raw;
    }
  };

  // Plain URLs.
  let output = source.replace(
    /https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi,
    rewriteAbsolute
  );

  // JSON/JS strings sometimes escape slashes as https:\/\/example.com.
  output = output.replace(
    /https?:\\\/\\\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/gi,
    rewriteAbsolute
  );

  return output;
}

function rewriteHtml(html, targetUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const baseTag = $('base[href]').first();
  let documentBase = targetUrl;
  if (baseTag.length) {
    try { documentBase = new URL(baseTag.attr('href'), targetUrl).href; } catch {}
    baseTag.attr('href', proxyPathFor(documentBase));
  }

  // iframe[src] is rewritten just like any other external resource.
  // When that iframe requests an HTML document, proxyHttp() runs rewriteHtml() again,
  // so scripts/images/CSS/nested iframes inside the iframe are also proxied.
  const attrs = [
    ['a[href]', 'href'], ['area[href]', 'href'], ['link[href]', 'href'],
    ['script[src]', 'src'], ['img[src]', 'src'], ['iframe[src]', 'src'],
    ['frame[src]', 'src'], ['embed[src]', 'src'], ['input[src]', 'src'],
    ['video[src]', 'src'], ['audio[src]', 'src'], ['source[src]', 'src'],
    ['track[src]', 'src'], ['image[href]', 'href'], ['image[xlink\\:href]', 'xlink:href'],
    ['object[data]', 'data'], ['form[action]', 'action'], ['button[formaction]', 'formaction'],
    ['input[formaction]', 'formaction'], ['textarea[formaction]', 'formaction'],
    ['video[poster]', 'poster']
  ];

  for (const [selector, attr] of attrs) {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (value != null) $(el).attr(attr, rewriteUrl(value, documentBase));
    });
  }

  $('[srcset]').each((_, el) => $(el).attr('srcset', rewriteSrcset($(el).attr('srcset'), documentBase)));
  $('[style]').each((_, el) => $(el).attr('style', rewriteCss($(el).attr('style'), documentBase)));

  $('meta[http-equiv]').each((_, el) => {
    const equiv = String($(el).attr('http-equiv') || '').toLowerCase();
    if (equiv === 'refresh') {
      const content = $(el).attr('content') || '';
      const m = content.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.*)$/i);
      if (m) $(el).attr('content', `${m[1]}${rewriteUrl(m[2], documentBase)}`);
    }
  });

  // Rewrite absolute HTTP(S) URLs that are embedded directly inside inline scripts.
  $('script:not([src])').each((_, el) => {
    const content = $(el).html();
    if (content) $(el).html(rewriteJavaScript(content, documentBase));
  });

  // Let runtime-generated requests (fetch/XHR/WebSocket/etc.) also go through this server.
  const runtimePatch = `
<script>
(() => {
  const proxy = (value) => {
    if (typeof value !== 'string') {
      if (value && typeof value.url === 'string') {
        return new URL(proxy(value.url), location.href).toString();
      }
      return value;
    }
    if (/^(data:|blob:|javascript:|mailto:|tel:|about:|file:|#)/i.test(value)) return value;
    let u;
    try { u = new URL(value, document.baseURI); } catch { return value; }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (u.origin === location.origin && u.pathname.startsWith('/p/')) return u.toString();
      return '/p/' + u.protocol.slice(0, -1) + '/' + u.host + (u.pathname || '/') + u.search + u.hash;
    }
    return value;
  };

  const rawFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' || input instanceof URL) return rawFetch.call(this, proxy(String(input)), init);
    try {
      const clone = new Request(input);
      return rawFetch.call(this, new Request(proxy(clone.url), clone), init);
    } catch { return rawFetch.call(this, input, init); }
  };

  const rawOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return rawOpen.call(this, method, proxy(String(url)), ...rest);
  };

  if (window.EventSource) {
    const RawEventSource = window.EventSource;
    window.EventSource = function(url, config) { return new RawEventSource(proxy(String(url)), config); };
    window.EventSource.prototype = RawEventSource.prototype;
    window.EventSource.CONNECTING = RawEventSource.CONNECTING;
    window.EventSource.OPEN = RawEventSource.OPEN;
    window.EventSource.CLOSED = RawEventSource.CLOSED;
  }

  if (navigator.sendBeacon) {
    const rawBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => rawBeacon(proxy(String(url)), data);
  }

  if (window.WebSocket) {
    const RawWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
      const u = String(url);
      if (/^wss?:/i.test(u)) {
        const wsPath = '/ws?url=' + encodeURIComponent(u);
        const proxyWs = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + wsPath;
        return protocols === undefined ? new RawWebSocket(proxyWs) : new RawWebSocket(proxyWs, protocols);
      }
      return protocols === undefined ? new RawWebSocket(u) : new RawWebSocket(u, protocols);
    };
    window.WebSocket.prototype = RawWebSocket.prototype;
    window.WebSocket.CONNECTING = RawWebSocket.CONNECTING;
    window.WebSocket.OPEN = RawWebSocket.OPEN;
    window.WebSocket.CLOSING = RawWebSocket.CLOSING;
    window.WebSocket.CLOSED = RawWebSocket.CLOSED;
  }

  const rewriteElementUrl = (el, attr) => {
    try {
      const v = el.getAttribute(attr);
      if (!v) return;
      const next = proxy(v);
      if (next !== v) el.setAttribute(attr, next);
    } catch {}
  };

  // Cover dynamically-created DOM elements that use absolute URLs.
  const observe = () => {
    const attrs = ['src','href','poster','action','formaction','data']; // includes dynamically-created iframe[src]
    const mo = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' && attrs.includes(r.attributeName)) rewriteElementUrl(r.target, r.attributeName);
        for (const node of r.addedNodes || []) {
          if (!(node instanceof Element)) continue;
          for (const attr of attrs) if (node.hasAttribute(attr)) rewriteElementUrl(node, attr);
          node.querySelectorAll?.('[src],[href],[poster],[action],[formaction],[data]').forEach(child => {
            for (const attr of attrs) if (child.hasAttribute(attr)) rewriteElementUrl(child, attr);
          });
        }
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: attrs });
  };
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });
})();
</script>`;

  if ($('head').length) $('head').prepend(runtimePatch);
  else $('html').prepend(`<head>${runtimePatch}</head>`);

  return $.html();
}

function copyResponseHeaders(upstream, res, targetUrl) {
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (hopByHop.has(lower)) continue;
    if (['content-security-policy', 'content-security-policy-report-only', 'x-frame-options'].includes(lower)) continue;
    if (lower === 'location') {
      try {
        res.setHeader('Location', proxyPathFor(new URL(value, targetUrl)));
      } catch {}
      continue;
    }
    if (lower === 'set-cookie') {
      continue; // handled below with getSetCookie()
    }
    if (lower === 'content-length') continue;
    res.setHeader(key, value);
  }

  if (typeof upstream.headers.getSetCookie === 'function') {
    const cookies = upstream.headers.getSetCookie().map(cookie =>
      cookie.replace(/;\s*Domain=[^;]*/ig, '')
            .replace(/;\s*Path=[^;]*/ig, '; Path=/')
    );
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
  }
}

async function proxyHttp(req, res, targetUrl) {
  const target = validateTarget(targetUrl);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (hopByHop.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'accept-encoding') continue;
    headers[key] = value;
  }
  headers['accept-encoding'] = 'identity';

  // Make the upstream server see the proxied target as the logical origin.
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = target.origin + '/';

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 30 * 1024 * 1024) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Request body too large');
        return;
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: 'manual'
  });

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');
  const isJavaScript = contentType.includes('javascript') ||
    contentType.includes('ecmascript') ||
    contentType.includes('application/x-javascript');
  const isText = isHtml || isCss || isJavaScript;

  copyResponseHeaders(upstream, res, target);

  if (isText) {
    const input = await upstream.text();
    const output = isHtml
      ? rewriteHtml(input, target.href)
      : isCss
        ? rewriteCss(input, target.href)
        : rewriteJavaScript(input, target.href);
    const buf = Buffer.from(output);
    res.setHeader('Content-Length', String(buf.length));
    res.writeHead(upstream.status);
    res.end(buf);
    return;
  }

  const bodyStream = upstream.body ? Readable.fromWeb(upstream.body) : null;
  res.writeHead(upstream.status);
  if (bodyStream) bodyStream.pipe(res);
  else res.end();
}

const wsProxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
wsProxy.on('error', (err, req, socket) => {
  try { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
  console.error('WebSocket proxy error:', err.message);
});

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health' || req.url === '/health/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/' || requestUrl.pathname === '') {
      res.writeHead(302, { Location: proxyPathFor(START_URL) });
      res.end();
      return;
    }

    if (requestUrl.pathname === '/ws') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('WebSocket endpoint');
      return;
    }

    const target = targetFromProxyPath(requestUrl.pathname, requestUrl.search);
    if (!target) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    await proxyHttp(req, res, target.href);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(`Proxy error: ${err.message}`);
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname !== '/ws') return socket.destroy();

    const raw = requestUrl.searchParams.get('url');
    if (!raw) return socket.destroy();
    const target = validateWsTarget(raw);
    wsProxy.ws(req, socket, head, {
      target: target.href,
      changeOrigin: true,
      secure: true
    });
  } catch (err) {
    console.error('WS upgrade rejected:', err.message);
    socket.destroy();
  }
});

function validateWsTarget(raw) {
  const u = new URL(raw);
  if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('Only ws/wss targets are allowed');
  if (!isAllowedHost(u.hostname)) throw new Error(`Target host is not allowed: ${u.hostname}`);
  if (u.username || u.password) throw new Error('Userinfo in target URL is not allowed');
  return u;
}

server.listen(PORT, HOST, () => {
  console.log(`Proxy listening on http://${HOST}:${PORT}`);
  console.log(`Start URL: ${START_URL}`);
  console.log(`ALLOW_ANY_EXTERNAL=${ALLOW_ANY_EXTERNAL}`);
});
