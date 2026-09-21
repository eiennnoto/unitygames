const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const TARGET = process.env.TARGET_URL;

if (!TARGET) {
  console.error("TARGET_URL が設定されていません");
  process.exit(1);
}

// 動作確認用
app.get("/health", (req, res) => {
  res.send("OK");
});

// 元サイトへ全部転送
const proxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true
});

app.use(proxy);

const port = Number(process.env.PORT) || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Proxy server started on port ${port}`);
  console.log(`Target: ${TARGET}`);
});
