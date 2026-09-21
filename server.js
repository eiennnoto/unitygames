const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

// 最初に表示するサイト
const HOME = "https://unityroom.com/";

// 許可するホスト
function isAllowedHost(hostname) {
    hostname = hostname.toLowerCase();

    // unityroom.com
    if (hostname === "unityroom.com") {
        return true;
    }

    // www.unityroom.com
    if (hostname === "www.unityroom.com") {
        return true;
    }

    // 78914.play.unityroom.com
    // abc.play.unityroom.com
    if (hostname.endsWith(".play.unityroom.com")) {
        return true;
    }

    return false;
}

// URLをRenderプロキシURLへ変換
function proxyUrl(target) {
    return "/proxy?url=" + encodeURIComponent(target);
}

// HTML内のURLを書き換える
function rewriteHtml(html, baseUrl) {
    const base = new URL(baseUrl);

    // src / href / action / poster / data
    html = html.replace(
        /(\b(?:src|href|action|poster|data)\s*=\s*)(["'])([^"']+)\2/gi,
        (match, prefix, quote, value) => {

            if (
                value.startsWith("#") ||
                value.startsWith("data:") ||
                value.startsWith("blob:") ||
                value.startsWith("javascript:") ||
                value.startsWith("mailto:")
            ) {
                return match;
            }

            try {
                const absolute = new URL(value, base);

                if (!isAllowedHost(absolute.hostname)) {
                    return match;
                }

                return (
                    prefix +
                    quote +
                    proxyUrl(absolute.href) +
                    quote
                );

            } catch {
                return match;
            }
        }
    );

    // srcset
    html = html.replace(
        /(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi,
        (match, prefix, quote, value) => {

            const result = value.split(",").map(item => {
                const parts = item.trim().split(/\s+/);

                if (!parts[0]) {
                    return item;
                }

                try {
                    const absolute = new URL(parts[0], base);

                    if (!isAllowedHost(absolute.hostname)) {
                        return item;
                    }

                    parts[0] = proxyUrl(absolute.href);

                    return parts.join(" ");
                } catch {
                    return item;
                }
            });

            return prefix + quote + result.join(", ") + quote;
        }
    );

    // CSS url(...)
    html = html.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (match, quote, value) => {

            try {
                const absolute = new URL(value, base);

                if (!isAllowedHost(absolute.hostname)) {
                    return match;
                }

                return `url("${proxyUrl(absolute.href)}")`;

            } catch {
                return match;
            }
        }
    );

    return html;
}

// CSS内のURLを書き換える
function rewriteCss(css, baseUrl) {
    const base = new URL(baseUrl);

    return css.replace(
        /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (match, quote, value) => {

            if (
                value.startsWith("data:") ||
                value.startsWith("#")
            ) {
                return match;
            }

            try {
                const absolute = new URL(value, base);

                if (!isAllowedHost(absolute.hostname)) {
                    return match;
                }

                return `url("${proxyUrl(absolute.href)}")`;
            } catch {
                return match;
            }
        }
    );
}

// HTTPサーバー
const server = http.createServer(async (req, res) => {

    try {

        const requestUrl = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        // ホーム
        if (
            requestUrl.pathname === "/" ||
            requestUrl.pathname === "/index.html"
        ) {
            return proxyRequest(
                HOME,
                req,
                res
            );
        }

        // /proxy?url=...
        if (requestUrl.pathname === "/proxy") {

            const target = requestUrl.searchParams.get("url");

            if (!target) {
                res.writeHead(400, {
                    "Content-Type": "text/plain; charset=utf-8"
                });

                return res.end("url is required");
            }

            let targetUrl;

            try {
                targetUrl = new URL(target);
            } catch {
                res.writeHead(400, {
                    "Content-Type": "text/plain; charset=utf-8"
                });

                return res.end("Invalid URL");
            }

            // HTTPSだけ許可
            if (targetUrl.protocol !== "https:") {
                res.writeHead(403);
                return res.end("Only HTTPS is allowed");
            }

            // unityroom系だけ許可
            if (!isAllowedHost(targetUrl.hostname)) {
                res.writeHead(403, {
                    "Content-Type": "text/plain; charset=utf-8"
                });

                return res.end("Host is not allowed");
            }

            return proxyRequest(
                targetUrl.href,
                req,
                res
            );
        }

        res.writeHead(404, {
            "Content-Type": "text/plain; charset=utf-8"
        });

        res.end("Not Found");

    } catch (err) {

        console.error(err);

        if (!res.headersSent) {
            res.writeHead(500);
        }

        res.end("Internal Server Error");
    }
});

async function proxyRequest(target, req, res) {

    console.log(`${req.method} ${target}`);

    try {

        const targetUrl = new URL(target);

        if (!isAllowedHost(targetUrl.hostname)) {
            res.writeHead(403);
            return res.end("Host is not allowed");
        }

        const headers = {
            "user-agent":
                req.headers["user-agent"] ||
                "Mozilla/5.0",
            "accept":
                req.headers["accept"] ||
                "*/*",
            "accept-language":
                req.headers["accept-language"] ||
                "ja,en-US;q=0.9,en;q=0.8"
        };

        // Refererを送る
        headers.referer = targetUrl.origin + "/";

        const response = await fetch(targetUrl.href, {
            method: req.method,
            headers,
            redirect: "manual"
        });

        // リダイレクト
        if (
            response.status >= 300 &&
            response.status < 400
        ) {

            const location = response.headers.get("location");

            if (location) {

                const absolute = new URL(
                    location,
                    targetUrl
                );

                if (isAllowedHost(absolute.hostname)) {

                    res.writeHead(response.status, {
                        "Location":
                            proxyUrl(absolute.href)
                    });

                    return res.end();
                }
            }
        }

        const contentType =
            response.headers.get("content-type") || "";

        const buffer =
            Buffer.from(await response.arrayBuffer());

        let body = buffer;

        // HTML
        if (
            contentType.includes("text/html")
        ) {

            const html =
                buffer.toString("utf8");

            const rewritten =
                rewriteHtml(
                    html,
                    targetUrl.href
                );

            body =
                Buffer.from(rewritten);
        }

        // CSS
        else if (
            contentType.includes("text/css")
        ) {

            const css =
                buffer.toString("utf8");

            const rewritten =
                rewriteCss(
                    css,
                    targetUrl.href
                );

            body =
                Buffer.from(rewritten);
        }

        // ヘッダー
        const responseHeaders = {
            "Content-Type":
                contentType ||
                "application/octet-stream",

            "Cache-Control":
                "public, max-age=300",

            "Access-Control-Allow-Origin":
                "*"
        };

        // Content-Length
        responseHeaders["Content-Length"] =
            body.length;

        res.writeHead(
            response.status,
            responseHeaders
        );

        res.end(body);

    } catch (err) {

        console.error(
            "Proxy error:",
            err
        );

        if (!res.headersSent) {

            res.writeHead(502, {
                "Content-Type":
                    "text/plain; charset=utf-8"
            });

            res.end(
                "Proxy Error\n\n" +
                err.message
            );
        }
    }
}

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Proxy running on 0.0.0.0:${PORT}`
        );
    }
);
