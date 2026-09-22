# Unityroom Render Proxy

Render Web Service 用の Node.js リバースプロキシです。

## できること

- `unityroom.com` の HTML を Render 経由で表示
- `*.unityroom.com` のサブドメインを同じプロキシから取得
- HTML の `href` / `src` / `action` / `poster` / `srcset` などを書き換え
- CSS の `url(...)` / `@import` を書き換え
- インライン `<script>` 内にある絶対 `http://` / `https://` URL を書き換え
- 外部 JavaScript ファイル内の絶対 `http://` / `https://` URL も取得時に書き換え
- `fetch` / XHR / EventSource / sendBeacon / WebSocket の実行時URLを Render 経由へ寄せる
- upstream のリダイレクトもプロキシURLへ書き換え
- Cookie の Domain を除去してプロキシ側で扱いやすくする

## Render 設定

### Build Command

```bash
npm install
```

### Start Command

```bash
node server.js
```

### 環境変数

通常はそのままで使えます。

```text
START_URL=https://unityroom.com/
```

許可するホストを増やす場合:

```text
ALLOWED_HOSTS=unityroom.com
ALLOWED_HOST_SUFFIXES=.unityroom.com,.example.com
```

テスト目的で任意の HTTP/HTTPS ホストを許可する場合:

```text
ALLOW_ANY_EXTERNAL=true
```

`ALLOW_ANY_EXTERNAL=true` は公開オープンプロキシに近い動作になるため、公開運用では推奨しません。

## URL の例

Render の URL が:

```text
https://example.onrender.com
```

ならトップページ:

```text
https://example.onrender.com/
```

ゲーム用ホスト:

```text
https://example.onrender.com/p/https/78914.play.unityroom.com/
```

## JavaScript 内の URL

例えば元ページに:

```html
<script>
  const game = "https://78914.play.unityroom.com/Build/Web.data.unityweb";
  fetch("https://unityroom.com/api/example");
</script>
```

がある場合、配信時には概ね次のように書き換えられます。

```html
<script>
  const game = "/p/https/78914.play.unityroom.com/Build/Web.data.unityweb";
  fetch("/p/https/unityroom.com/api/example");
</script>
```

さらに `fetch()` などはブラウザ側のランタイムパッチでも処理します。

## 注意

すべてのサイト・すべての通信を100%透過的に代理できるわけではありません。Service Worker、WebRTC、独自プロトコル、JavaScript が動的に組み立てるURL、CORS/認証/Origin 制約などでは追加対応が必要になる場合があります。
