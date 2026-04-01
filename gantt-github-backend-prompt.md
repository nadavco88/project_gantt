# Gantt Chart — GitHub-Backed Backend: Comprehensive Architecture Prompt

## Context & Current State

You are building the backend infrastructure for a production-ready, multi-user Gantt Chart application (`index.html`). The frontend is a fully self-contained HTML/JS SPA that already includes:

- A remote sync layer calling `/.netlify/functions/load-gantt` (GET) and `/.netlify/functions/save-gantt` (POST)
- Bearer-token authentication via `GANTT_API_SECRET` stored in `sessionStorage`
- Debounced auto-save (500 ms) and a `pagehide` flush
- Optimistic local-storage caching as fallback
- Conflict detection (HTTP 409) and payload size guard (1.45 MB cap)
- A `github-sync-indicator` banner for visual feedback

**Goal:** implement the two Netlify serverless functions that store and retrieve the shared Gantt state as a JSON file inside a private GitHub repository, with maximum security, auditability, and resilience.

---

## Repository Structure

```
your-repo/
├── netlify.toml                  ← build + function config
├── netlify/
│   └── functions/
│       ├── load-gantt.js         ← GET handler
│       └── save-gantt.js         ← POST handler
├── data/
│   └── gantt-state.json          ← persisted state (managed by functions only)
├── index.html                    ← the frontend SPA (DO NOT modify)
└── .github/
    └── workflows/
        └── validate-state.yml    ← CI checkpoint: JSON schema validation on push
```

> **Why store data in the same repo?** It gives you a free, append-only audit log (Git history), zero extra database cost, atomic writes via GitHub's Contents API, and easy rollback via `git revert`.

---

## Required Environment Variables (Netlify Dashboard → Site Settings → Environment Variables)

| Variable | Where set | Description |
|---|---|---|
| `GITHUB_TOKEN` | Netlify env (never in repo) | Fine-grained PAT — **only** `contents: write` on this repo |
| `GITHUB_OWNER` | Netlify env | Your GitHub username or org |
| `GITHUB_REPO` | Netlify env | Repository name |
| `GANTT_FILE_PATH` | Netlify env (optional) | Path inside repo, default `data/gantt-state.json` |
| `GANTT_API_SECRET` | Netlify env (never in repo) | Random 32-byte hex secret; **also** pasted by users in the app's "Remote (GitHub)…" dialog |

**Generate secrets:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Security Hardening Checklist

### GitHub PAT (Personal Access Token)
- [ ] Use a **fine-grained PAT** (not a classic token)
- [ ] Scope: `Contents: Read and Write` on **this repo only** — nothing else
- [ ] Set expiry: 90 days max; rotate on a calendar reminder
- [ ] Never commit the token. Use `git secret` or similar if you need local dev access
- [ ] Revoke the token immediately if it leaks — GitHub will often auto-detect and alert you

### Netlify Environment
- [ ] Mark `GITHUB_TOKEN` and `GANTT_API_SECRET` as **sensitive** in Netlify (they will be redacted in logs)
- [ ] Enable **branch-specific** env scoping: only expose vars on `main`/production
- [ ] Never echo env vars inside function response bodies or logs

### API Secret (`GANTT_API_SECRET`)
- [ ] All function requests must include `Authorization: Bearer <secret>`
- [ ] Compare using **constant-time comparison** (`crypto.timingSafeEqual`) — never `===`
- [ ] Return `401` immediately on mismatch, with no diagnostic message beyond `Unauthorized`
- [ ] The secret lives only in Netlify env + user's `sessionStorage` — never in `localStorage`, the HTML, or the repo

### Request Validation (both functions)
- [ ] Reject any method that is not the expected one (405)
- [ ] Validate `Content-Type: application/json` on POST
- [ ] Enforce payload size ≤ 1.5 MB (match the frontend's 1.45 MB guard)
- [ ] Parse and schema-validate the JSON body before writing — reject malformed payloads (400)
- [ ] Rate-limit: track calls per IP using Netlify's built-in rate limiting header `x-nf-client-connection-ip` or use a simple in-memory LRU (max 60 saves/min per IP)

### Headers (both function responses)
```
Content-Type: application/json
Cache-Control: no-store, no-cache, must-revalidate
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

---

## `netlify/functions/load-gantt.js` — Full Implementation

```javascript
// netlify/functions/load-gantt.js
// GET /.netlify/functions/load-gantt
// Returns the current gantt-state.json from GitHub, or {} if not yet created.

const crypto = require('crypto');
const https  = require('https');

const FILE_PATH   = process.env.GANTT_FILE_PATH || 'data/gantt-state.json';
const OWNER       = process.env.GITHUB_OWNER;
const REPO        = process.env.GITHUB_REPO;
const TOKEN       = process.env.GITHUB_TOKEN;
const API_SECRET  = process.env.GANTT_API_SECRET;

const SECURE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// ── Constant-time secret comparison ──────────────────────────
function checkAuth(event) {
  const authHeader = (event.headers['authorization'] || '').trim();
  if (!authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  try {
    const a = Buffer.from(provided.padEnd(64));
    const b = Buffer.from(API_SECRET.padEnd(64));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Simple GitHub Contents API GET ───────────────────────────
function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gantt-netlify-function/1.0',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  // 1. Method guard
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // 2. Auth
  if (!checkAuth(event)) {
    return { statusCode: 401, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 3. Env guard
  if (!OWNER || !REPO || !TOKEN) {
    console.error('[load-gantt] Missing environment variables');
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // 4. Fetch from GitHub
  try {
    const { status, body } = await githubGet(FILE_PATH);

    if (status === 404) {
      // File doesn't exist yet — return empty-but-valid state
      return { statusCode: 200, headers: SECURE_HEADERS, body: JSON.stringify({ projects: [], users: [] }) };
    }

    if (status !== 200) {
      console.error('[load-gantt] GitHub API error', status);
      return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };
    }

    const ghResponse = JSON.parse(body);
    const decoded    = Buffer.from(ghResponse.content, 'base64').toString('utf8');
    const data       = JSON.parse(decoded);

    // 5. Minimal schema check before returning
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      console.error('[load-gantt] Corrupt state in GitHub');
      return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Corrupt state' }) };
    }

    return { statusCode: 200, headers: SECURE_HEADERS, body: JSON.stringify(data) };

  } catch (err) {
    console.error('[load-gantt] Unexpected error:', err.message);
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
```

---

## `netlify/functions/save-gantt.js` — Full Implementation

```javascript
// netlify/functions/save-gantt.js
// POST /.netlify/functions/save-gantt
// Writes gantt-state.json to GitHub using the Contents API (atomic update via SHA).

const crypto = require('crypto');
const https  = require('https');

const FILE_PATH   = process.env.GANTT_FILE_PATH || 'data/gantt-state.json';
const OWNER       = process.env.GITHUB_OWNER;
const REPO        = process.env.GITHUB_REPO;
const TOKEN       = process.env.GITHUB_TOKEN;
const API_SECRET  = process.env.GANTT_API_SECRET;

const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB hard cap

const SECURE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// ── Auth ──────────────────────────────────────────────────────
function checkAuth(event) {
  const authHeader = (event.headers['authorization'] || '').trim();
  if (!authHeader.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  try {
    const a = Buffer.from(provided.padEnd(64));
    const b = Buffer.from(API_SECRET.padEnd(64));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Schema validation (minimal but strict) ────────────────────
function validatePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (!Array.isArray(data.projects)) return false;
  for (const p of data.projects) {
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return false;
    if (!Array.isArray(p.tasks)) return false;
    for (const t of p.tasks) {
      if (typeof t.id !== 'string' || typeof t.name !== 'string') return false;
      // Sanitize: strip any executable-looking content
      if (/<script/i.test(JSON.stringify(t))) return false;
    }
  }
  return true;
}

// ── GitHub API helpers ────────────────────────────────────────
function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gantt-netlify-function/1.0',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

async function getCurrentSha() {
  const { status, body } = await githubRequest('GET', FILE_PATH);
  if (status === 404) return null;  // file doesn't exist yet
  if (status !== 200) throw new Error(`GitHub GET failed: ${status}`);
  return JSON.parse(body).sha;
}

// ── Rate limiter (in-memory, per cold-start) ──────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS  = 60;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  // Prune old entries to avoid memory leak
  if (rateLimitMap.size > 500) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
    }
  }
  return entry.count > RATE_LIMIT_MAX_CALLS;
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  // 1. Method guard
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // 2. Auth
  if (!checkAuth(event)) {
    return { statusCode: 401, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 3. Rate limit
  const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'unknown';
  if (isRateLimited(clientIp)) {
    return { statusCode: 429, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  // 4. Env guard
  if (!OWNER || !REPO || !TOKEN) {
    console.error('[save-gantt] Missing environment variables');
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // 5. Payload size guard
  const rawBody = event.body || '';
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BYTES) {
    return { statusCode: 413, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  // 6. Parse + schema validate
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!validatePayload(data)) {
    return { statusCode: 400, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Invalid payload schema' }) };
  }

  // 7. Stamp server-side metadata
  data._savedAt  = new Date().toISOString();
  data._savedBy  = clientIp.slice(0, 15); // truncated for privacy; useful for audit

  // 8. Get current SHA (for atomic update / optimistic locking)
  let sha;
  try {
    sha = await getCurrentSha();
  } catch (err) {
    console.error('[save-gantt] Failed to get SHA:', err.message);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };
  }

  // 9. Write to GitHub
  const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const payload = {
    message: `chore: auto-save gantt state [${new Date().toISOString()}]`,
    content: encoded,
    ...(sha ? { sha } : {}),  // omit sha if file is new
  };

  let writeResult;
  try {
    writeResult = await githubRequest('PUT', FILE_PATH, payload);
  } catch (err) {
    console.error('[save-gantt] GitHub PUT failed:', err.message);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Write failed' }) };
  }

  // 10. Conflict detection (SHA mismatch = someone else saved first)
  if (writeResult.status === 409 || writeResult.status === 422) {
    return { statusCode: 409, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Conflict — reload from GitHub' }) };
  }

  if (writeResult.status !== 200 && writeResult.status !== 201) {
    console.error('[save-gantt] Unexpected GitHub response:', writeResult.status);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };
  }

  return { statusCode: 200, headers: SECURE_HEADERS, body: JSON.stringify({ ok: true, savedAt: data._savedAt }) };
};
```

---

## `netlify.toml` — Build & Function Configuration

```toml
[build]
  publish = "."
  functions = "netlify/functions"

[functions]
  node_bundler = "esbuild"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "geolocation=(), microphone=(), camera=()"

[[headers]]
  for = "/.netlify/functions/*"
  [headers.values]
    Cache-Control = "no-store"

[context.production.environment]
  NODE_ENV = "production"
```

---

## GitHub Actions: State Validation Checkpoint

`.github/workflows/validate-state.yml`

```yaml
name: Validate Gantt State

on:
  push:
    paths:
      - 'data/gantt-state.json'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate JSON structure
        run: |
          node -e "
            const fs = require('fs');
            const raw = fs.readFileSync('data/gantt-state.json', 'utf8');
            let data;
            try { data = JSON.parse(raw); } catch(e) { console.error('INVALID JSON:', e.message); process.exit(1); }
            if (!Array.isArray(data.projects)) { console.error('Missing projects array'); process.exit(1); }
            for (const p of data.projects) {
              if (!p.id || !p.name || !Array.isArray(p.tasks)) { console.error('Bad project:', p.id); process.exit(1); }
              for (const t of p.tasks) {
                if (!t.id || !t.name) { console.error('Bad task:', t.id); process.exit(1); }
              }
            }
            console.log('State valid. Projects:', data.projects.length,
              'Tasks total:', data.projects.reduce((n,p)=>n+p.tasks.length,0));
          "

      - name: Check file size
        run: |
          SIZE=$(wc -c < data/gantt-state.json)
          echo "State file size: ${SIZE} bytes"
          if [ "$SIZE" -gt "1500000" ]; then
            echo "ERROR: State file exceeds 1.5 MB limit"
            exit 1
          fi

      - name: Notify on failure
        if: failure()
        run: echo "::error::Gantt state validation failed. Check data/gantt-state.json."
```

---

## Deployment Checklist (Sequential)

### Step 1 — GitHub Setup
- [ ] Create a **private** GitHub repository (or use existing)
- [ ] Create `data/gantt-state.json` with contents `{"projects":[],"users":[]}` and commit it (prevents 404 on first load)
- [ ] Create a **fine-grained PAT**: Settings → Developer Settings → Fine-grained tokens → New token
  - Resource owner: your account or org
  - Repository access: Only `this-repo`
  - Permissions: `Contents: Read and Write` only
  - Expiration: 90 days
- [ ] Copy the token immediately — it is shown only once

### Step 2 — Netlify Setup
- [ ] Connect repo to Netlify (or use Netlify CLI: `netlify init`)
- [ ] In Netlify dashboard → Site Settings → Environment Variables, add:
  - `GITHUB_TOKEN` = your fine-grained PAT *(mark sensitive)*
  - `GITHUB_OWNER` = your GitHub username
  - `GITHUB_REPO` = repository name
  - `GANTT_API_SECRET` = generated 32-byte hex secret *(mark sensitive)*
  - `GANTT_FILE_PATH` = `data/gantt-state.json` *(optional)*
- [ ] Scope all variables to **Production** branch only
- [ ] Trigger a new deploy (push a commit or use Netlify dashboard)

### Step 3 — Function Files
- [ ] Create `netlify/functions/load-gantt.js` (code above)
- [ ] Create `netlify/functions/save-gantt.js` (code above)
- [ ] Create `netlify.toml` (config above)
- [ ] Commit and push — Netlify auto-deploys

### Step 4 — Frontend Connection
- [ ] Open your Netlify URL
- [ ] Click **Export → Remote (GitHub)…** in the Gantt app toolbar
- [ ] Paste your `GANTT_API_SECRET` value and click Connect
- [ ] The `github-sync-indicator` banner confirms load/save activity

### Step 5 — Verify End-to-End
- [ ] Load the page — banner shows "Loading from GitHub…" then disappears
- [ ] Add a task and wait 0.5 s — banner shows "Saving to GitHub…"
- [ ] Check GitHub repo → `data/gantt-state.json` — new commit with updated content
- [ ] Open an incognito window, connect with the same secret — same state loads
- [ ] Simulate conflict: edit in two tabs simultaneously — one gets toast "Remote conflict — reload from GitHub"

### Step 6 — Monitoring & Rotation
- [ ] Enable GitHub Actions on the repo — `validate-state.yml` runs on every state push
- [ ] Set a calendar reminder at 80 days to rotate the PAT before it expires
- [ ] Periodically review Netlify function logs for unexpected 401/5xx spikes

---

## Architecture Diagram (Text)

```
Browser (index.html)
    │
    │  GET /.netlify/functions/load-gantt
    │  Authorization: Bearer <GANTT_API_SECRET>
    ▼
Netlify CDN Edge
    │
    │  Routes to serverless function (Node.js, no cold-start secrets exposed)
    ▼
load-gantt.js / save-gantt.js
    │
    │  timingSafeEqual auth check
    │  Schema validation
    │  Rate limit check
    │
    │  GET /repos/OWNER/REPO/contents/data/gantt-state.json
    │  Authorization: Bearer <GITHUB_TOKEN>  (never reaches browser)
    ▼
GitHub Contents API
    │
    │  Returns base64-encoded JSON + current SHA
    ▼
save-gantt.js
    │
    │  PUT with {content: base64, sha: currentSHA, message: "chore: auto-save..."}
    ▼
GitHub repo: data/gantt-state.json
    │
    │  Commit created (audit trail)
    ▼
GitHub Actions: validate-state.yml
    │
    │  JSON schema check + file size check
    ▼
Pass / Fail notification
```

---

## Known Limitations & Mitigations

| Limitation | Mitigation |
|---|---|
| GitHub API rate limit (5000 req/hr for authenticated PAT) | Frontend debounces saves to 500 ms; GitHub counts each PUT as 1 request — typical usage is far below the limit |
| Concurrent multi-user edits cause 409 conflicts | Frontend handles 409 with toast prompt; last-write-wins via SHA rotation; for true concurrent editing consider adding an operational-transform layer |
| Cold-start latency (Netlify functions) | Keep functions lightweight (no npm dependencies); use Node.js built-in `https` only |
| Git history grows indefinitely | Run `git gc` periodically or squash history via a scheduled GitHub Action if the repo becomes large |
| PAT expiry causes silent failures | Netlify will return 502; frontend shows "Could not load from GitHub — using local data" — set a calendar reminder to rotate before expiry |
