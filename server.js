import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

const PORT = process.env.PORT || 10000;

// unityroom.com をプロキシ
app.use(
  "/",
  createProxyMiddleware({
    target: "https://unityroom.com",
    changeOrigin: true,
    secure: true,

    on: {
      proxyReq(proxyReq, req) {
        proxyReq.setHeader("referer", "https://unityroom.com/");
        proxyReq.setHeader("origin", "https://unityroom.com");
      },

      proxyRes(proxyRes) {
        // プロキシ先からのリダイレクトをRender側URLへ書き換える
        const location = proxyRes.headers.location;

        if (location) {
          proxyRes.headers.location = location
            .replace(/^https:\/\/unityroom\.com/, "");
        }
      }
    }
  })
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});
