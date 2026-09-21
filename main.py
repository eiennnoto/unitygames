from flask import Flask, Response, request
import requests

app = Flask(__name__)

TARGET = "https://unityroom.com"

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def proxy(path):
    url = TARGET + "/" + path

    if request.query_string:
        url += "?" + request.query_string.decode()

    headers = {
        "User-Agent": request.headers.get(
            "User-Agent",
            "Mozilla/5.0"
        )
    }

    r = requests.get(
        url,
        headers=headers,
        timeout=20
    )

    excluded = {
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection"
    }

    response_headers = [
        (k, v)
        for k, v in r.headers.items()
        if k.lower() not in excluded
    ]

    return Response(
        r.content,
        status=r.status_code,
        headers=response_headers
    )


if __name__ == "__main__":
    import os

    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
