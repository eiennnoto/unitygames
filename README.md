# Unityroom Render Proxy

Unityroom を Render の同一オリジン経由で表示する Node.js リバースプロキシです。

## Render 設定
- Runtime: Node
- Build Command: `npm install`
- Start Command: `node server.js`
- `START_URL`: `https://unityroom.com/`
- `ALLOWED_HOSTS`: `unityroom.com`
- `ALLOWED_HOST_SUFFIXES`: `.unityroom.com`

外部CDN・画像配信ホストまで全部通したいテストでは `ALLOW_ANY_EXTERNAL=true` を設定できます。
ただし、これは公開オープンプロキシに近づくので、公開サービスでは必要なホストだけを `ALLOWED_HOSTS` / `ALLOWED_HOST_SUFFIXES` に追加してください。

## URL
トップページは Render URL の `/` で `https://unityroom.com/` に転送されます。

例:
- `/p/https/unityroom.com/`
- `/p/https/78914.play.unityroom.com/`

HTML のリンク、画像、CSS、script、iframe、form などは `/p/...` に書き換えます。
さらにページ内の `fetch` / XHR / EventSource / sendBeacon / WebSocket の動的通信もプロキシへ向けます。
