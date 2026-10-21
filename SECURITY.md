# Security

True Vision Camera is a static, first-party-only web application. Its security posture:

- **No third-party code or requests.** No CDNs, fonts, analytics or APIs. All processing runs on the device; frames never leave it.
- **Strict Content-Security-Policy** (`default-src 'self'`, no inline scripts, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`), served both by `vercel.json` and the local server.
- **Clickjacking / isolation**: `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`.
- **Transport**: HSTS with preload on the hosted version; camera access requires a secure context.
- **Permissions-Policy** limits camera and microphone to this origin and disables unrelated features.
- **No referrer leakage**: `Referrer-Policy: no-referrer`; `rel="noopener"` on any opened window.
- **Input hygiene**: persisted settings are validated by type and range on load; file names are sanitised to `[A-Za-z0-9_-]`; DOM is built with `textContent`, never with untrusted HTML.
- **Local server**: GET/HEAD only, path traversal blocked, repository internals (`.git`, server code, tests) not served.
- **Dependencies**: none, so there is no supply chain to compromise.

To report a vulnerability, open a GitHub issue with the label `security` or contact the repository owner.
