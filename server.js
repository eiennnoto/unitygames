import express from "express";
import httpProxy from "http-proxy";

const app = express();

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: true
});

const PORT = process.env.PORT || 10000;

// unityroom本体
app.use((req, res) => {
  let target;

  // /play-host/78914/... のような形で
  // play.unityroom.com を指定できるようにする
  if (req.url.startsWith("/play-host/")) {
    req.url = req.url.replace(/^\/play-host/, "");

    target = "https://78914.play.unityroom.com";
  } else {
    target = "https://unityroom.com";
  }

  proxy.web(req, res, {
    target,
    changeOrigin: true
  });
});

proxy.on("error", (err, req, res) => {
  console.error(err);

  if (!res.headersSent) {
    res.status(502).send("Proxy error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});
