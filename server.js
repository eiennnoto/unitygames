import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import httpProxy from 'http-proxy';
import * as cheerio from 'cheerio';

const app = express();
app.set('trust proxy', true);

// オープンプロキシにならないよう、unityroom系だけ許可
const ALLOWED_HOSTS = [
  'unityroom.com',
  ...(process.env.EXTRA_ALLOWED_HOSTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
];

function isAllowedHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');

  return ALLOWED_HOSTS.some(
    base => h === base || h.endsWith(`.${base}`)
  );
}

function getPublicOrigin(req) {
  const proto =
    req.headers['x-forwarded-proto']?.split(',')[0]?.trim() ||
    req.protocol ||
    'https';

  return `${proto}://${req.get('host')}`;
}

// /__p/ホスト名/パス を本来のURLに戻す
function parseProxyTarget(req) {
  const prefix = '/__p/';
  const original = req.originalUrl;

  if (!original.startsWith(prefix)) {
    return null;
  }

  const after = original.slice(prefix.length);

  const slash = after.indexOf('/');

  const encodedHost =
    slash === -1
      ? after
      : after.slice(0, slash);

  const rawPath =
    slash === -1
      ? '/'
      : after.slice(slash);

  let hostname;

  try {
    hostname = decodeURIComponent(encodedHost);
  } catch {
    return null;
  }

  if (!/^[a-z0-9.-]+$/i.test(hostname)) {
    return null;
  }

  if (!isAllowedHost(hostname)) {
    return null;
  }

  try {
    const target = new URL(
      `https://${hostname}${rawPath}`
    );

    target.hash = '';

    return target;
  } catch {
    return null;
  }
}

// 本来のURL → Render側URL
function proxyUrl(target, publicOrigin) {
  let path = target.pathname || '/';

  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  return (
    `${publicOrigin}/__p/` +
    `${target.hostname}` +
    `${path}` +
    `${target.search}` +
    `${target.hash}`
  );
}

function shouldRewriteUrl(raw) {
  if (!raw) return false;

  const s = raw.trim();

  if (
    !s ||
    s.startsWith('#') ||
    s.startsWith('data:') ||
    s.startsWith('blob:') ||
    s.startsWith('javascript:') ||
    s.startsWith('mailto:') ||
    s.startsWith('tel:')
  ) {
    return false;
  }

  return true;
}

function rewriteUrl(raw, pageUrl, publicOrigin) {
  if (!shouldRewriteUrl(raw)) {
    return raw;
  }

  try {
    const u = new URL(raw, pageUrl);

    if (
      u.protocol !== 'http:' &&
      u.protocol !== 'https:'
    ) {
      return raw;
    }

    if (!isAllowedHost(u.hostname)) {
      return raw;
    }

    return proxyUrl(
      u,
      publicOrigin
    );
  } catch {
    return raw;
  }
}

function rewriteSrcset(
  value,
  pageUrl,
  publicOrigin
) {
  return value
    .split(',')
    .map(part => {
      const trimmed = part.trim();

      if (!trimmed) return part;

      const match =
        trimmed.match(/^(\S+)(\s+.*)?$/);

      if (!match) return part;

      return (
        rewriteUrl(
          match[1],
          pageUrl,
          publicOrigin
        ) +
        (match[2] || '')
      );
    })
    .join(', ');
}

function rewriteCss(
  css,
  pageUrl,
  publicOrigin
) {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (full, quote, rawUrl) => {
      const rewritten = rewriteUrl(
        rawUrl,
        pageUrl,
        publicOrigin
      );

      return `url(${quote}${rewritten}${quote})`;
    }
  );
}

function rewriteHtml(
  html,
  pageUrl,
  publicOrigin
) {
  const $ = cheerio.load(
    html,
    {
      decodeEntities: false
    }
  );

  const attrs = [
    'href',
    'src',
    'action',
    'poster',
    'data',
    'cite',
    'formaction',
    'manifest',
    'background',
    'profile'
  ];

  for (const attr of attrs) {
    $(`[${attr}]`).each((_, el) => {
      const value = $(el).attr(attr);

      if (value) {
        $(el).attr(
          attr,
          rewriteUrl(
            value,
            pageUrl,
            publicOrigin
          )
        );
      }
    });
  }

  $('[srcset]').each((_, el) => {
    const value = $(el).attr('srcset');

    if (value) {
      $(el).attr(
        'srcset',
        rewriteSrcset(
          value,
          pageUrl,
          publicOrigin
        )
      );
    }
  });

  $('[style]').each((_, el) => {
    const value = $(el).attr('style');

    if (value) {
      $(el).attr(
        'style',
        rewriteCss(
          value,
          pageUrl,
          publicOrigin
        )
      );
    }
  });

  $('style').each((_, el) => {
    const value = $(el).html();

    if (value) {
      $(el).html(
        rewriteCss(
          value,
          pageUrl,
          publicOrigin
        )
      );
    }
  });

  // meta refresh
  $('meta[http-equiv]').each((_, el) => {
    const equiv =
      ($(el).attr('http-equiv') || '')
        .toLowerCase();

    if (equiv !== 'refresh') {
      return;
    }

    const content =
      $(el).attr('content');

    if (!content) return;

    $(el).attr(
      'content',
      content.replace(
        /(url\s*=\s*)(.+)$/i,
        (_, p1, p2) => {
          return (
            p1 +
            rewriteUrl(
              p2.trim(),
              pageUrl,
              publicOrigin
            )
          );
        }
      )
    );
  });

  // fetch / XHR / WebSocket など、
  // JavaScriptから動的にアクセスされたURLも書き換える
  const upstreamBase =
    JSON.stringify(pageUrl);

  const allowedHostsJson =
    JSON.stringify(ALLOWED_HOSTS);

  const shim = `<script>
(() => {
  const UPSTREAM_BASE = ${upstreamBase};
  const PREFIX = '/__p/';
  const ALLOWED_HOSTS = ${allowedHostsJson};

  const hostAllowed = (h) =>
    ALLOWED_HOSTS.some(
      base =>
        h === base ||
        h.endsWith('.' + base)
    );

  const rewrite = (input) => {
    try {
      const s =
        typeof input === 'string'
          ? input
          : input.url;

      const u =
        new URL(
          s,
          UPSTREAM_BASE
        );

      if (
        u.protocol !== 'http:' &&
        u.protocol !== 'https:'
      ) {
        return s;
      }

      if (!hostAllowed(u.hostname)) {
        return s;
      }

      return (
        PREFIX +
        u.hostname +
        (u.pathname || '/') +
        u.search +
        u.hash
      );
    } catch {
      return input;
    }
  };

  const absolute = (u) =>
    u.startsWith(PREFIX)
      ? location.origin + u
      : u;

  // fetch
  const originalFetch =
    window.fetch;

  window.fetch = function(
    input,
    init
  ) {
    if (input instanceof Request) {
      return originalFetch.call(
        this,
        new Request(
          absolute(
            rewrite(input.url)
          ),
          input
        ),
        init
      );
    }

    return originalFetch.call(
      this,
      absolute(rewrite(input)),
      init
    );
  };

  // XMLHttpRequest
  const originalOpen =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open =
    function(
      method,
      url,
      ...rest
    ) {
      return originalOpen.call(
        this,
        method,
        absolute(rewrite(url)),
        ...rest
      );
    };

  // WebSocket
  const OriginalWebSocket =
    window.WebSocket;

  if (OriginalWebSocket) {
    window.WebSocket = function(
      url,
      protocols
    ) {
      const rewritten =
        absolute(rewrite(url));

      return protocols === undefined
        ? new OriginalWebSocket(
            rewritten
          )
        : new OriginalWebSocket(
            rewritten,
            protocols
          );
    };

    window.WebSocket.prototype =
      OriginalWebSocket.prototype;

    window.WebSocket.CONNECTING =
      OriginalWebSocket.CONNECTING;

    window.WebSocket.OPEN =
      OriginalWebSocket.OPEN;

    window.WebSocket.CLOSING =
      OriginalWebSocket.CLOSING;

    window.WebSocket.CLOSED =
      OriginalWebSocket.CLOSED;
  }
})();
</script>`;

  $('head').prepend(shim);

  return $.html();
}

function copyResponseHeaders(
  upstream,
  res,
  targetUrl
) {
  const skip = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    'content-encoding'
  ]);

  for (const [key, value] of upstream.headers) {
    if (skip.has(key.toLowerCase())) {
      continue;
    }

    // Redirect先もRender側に変更
    if (key.toLowerCase() === 'location') {
      try {
        const location =
          new URL(
            value,
            targetUrl
          );

        if (
          (location.protocol === 'http:' ||
           location.protocol === 'https:') &&
          isAllowedHost(location.hostname)
        ) {
          res.setHeader(
            'Location',
            proxyUrl(
              location,
              getPublicOrigin(res.req)
            )
          );
        } else {
          res.setHeader(
            key,
            value
          );
        }
      } catch {
        res.setHeader(
          key,
          value
        );
      }

      continue;
    }

    if (
      key.toLowerCase() === 'set-cookie'
    ) {
      continue;
    }

    res.setHeader(
      key,
      value
    );
  }

  // CookieをRenderドメインで使えるようにする
  const cookies =
    typeof upstream.headers.getSetCookie ===
    'function'
      ? upstream.headers.getSetCookie()
      : [];

  for (const cookie of cookies) {
    const rewritten =
      cookie
        .replace(
          /;\s*Domain=[^;]+/ig,
          ''
        )
        .replace(
          /;\s*Path=[^;]*/ig,
          '; Path=/'
        );

    res.append(
      'Set-Cookie',
      rewritten
    );
  }
}

async function handleProxy(
  req,
  res
) {
  const target =
    parseProxyTarget(req);

  if (!target) {
    return res
      .status(400)
      .send(
        'Invalid or disallowed proxy target'
      );
  }

  const headers = {
    ...req.headers
  };

  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];

  // Render側のOrigin/Refererを
  // unityroom側にそのまま送らない
  delete headers.origin;
  delete headers.referer;

  let body;

  if (
    req.method !== 'GET' &&
    req.method !== 'HEAD'
  ) {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    body = Buffer.concat(chunks);
  }

  let upstream;

  try {
    upstream = await fetch(
      target,
      {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        signal:
          AbortSignal.timeout(30000)
      }
    );
  } catch (error) {
    console.error(
      'Upstream fetch failed:',
      target.href,
      error
    );

    return res
      .status(502)
      .send(
        `Upstream request failed: ${error.message}`
      );
  }

  copyResponseHeaders(
    upstream,
    res,
    target
  );

  res.status(
    upstream.status
  );

  // Redirect
  if (
    upstream.status >= 300 &&
    upstream.status < 400
  ) {
    return res.end();
  }

  const contentType =
    (
      upstream.headers.get(
        'content-type'
      ) || ''
    ).toLowerCase();

  const isText =
    contentType.includes(
      'text/html'
    ) ||
    contentType.includes(
      'text/css'
    );

  // HTML/CSSだけメモリに読み込んでURLを書き換える
  // Unityの大きな.data / .wasmなどはストリーミング
  if (isText) {
    const text =
      await upstream.text();

    const publicOrigin =
      getPublicOrigin(req);

    const rewritten =
      contentType.includes(
        'text/html'
      )
        ? rewriteHtml(
            text,
            target.href,
            publicOrigin
          )
        : rewriteCss(
            text,
            target.href,
            publicOrigin
          );

    res.removeHeader(
      'content-length'
    );

    return res.send(
      rewritten
    );
  }

  if (!upstream.body) {
    return res.end();
  }

  Readable
    .fromWeb(upstream.body)
    .pipe(res);
}

// トップページ
app.get('/', (req, res) => {
  res.redirect(
    '/__p/unityroom.com/'
  );
});

// プロキシ
app.all(
  /^\/__p\//,
  (req, res) => {
    handleProxy(
      req,
      res
    ).catch(err => {
      console.error(err);

      if (!res.headersSent) {
        res
          .status(500)
          .send('Proxy error');
      } else {
        res.end();
      }
    });
  }
);

app.get(
  '/health',
  (_req, res) =>
    res.type('text/plain').send('ok')
);

const server =
  http.createServer(app);

// WebSocket用
const wsProxy =
  httpProxy.createProxyServer({
    ws: true
  });

server.on(
  'upgrade',
  (req, socket, head) => {
    try {
      const fakeReq = {
        originalUrl: req.url
      };

      const target =
        parseProxyTarget(
          fakeReq
        );

      if (!target) {
        return socket.destroy();
      }

      req.url =
        `${target.pathname || '/'}` +
        `${target.search || ''}`;

      wsProxy.ws(
        req,
        socket,
        head,
        {
          target:
            `wss://${target.hostname}`,
          changeOrigin: true,
          secure: true
        }
      );
    } catch (err) {
      console.error(
        'WebSocket proxy failed:',
        err
      );

      socket.destroy();
    }
  }
);

// Render用
const port =
  Number(process.env.PORT) ||
  10000;

server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Unityroom proxy listening on 0.0.0.0:${port}`
    );
  }
);
