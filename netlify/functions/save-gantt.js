// netlify/functions/save-gantt.js
// POST /.netlify/functions/save-gantt
// Validates, stamps, and writes gantt-state.json to GitHub (atomic via SHA).

const crypto = require('crypto');
const https  = require('https');

const FILE_PATH   = process.env.GANTT_FILE_PATH || 'data/gantt-state.json';
const OWNER       = process.env.GITHUB_OWNER;
const REPO        = process.env.GITHUB_REPO;
const TOKEN       = process.env.GITHUB_TOKEN;
const BRANCH      = process.env.GITHUB_BRANCH || 'main';
const API_SECRET  = process.env.GANTT_API_SECRET;

const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

const SECURE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Access-Control-Allow-Origin': '*',
};

// ── In-memory rate limiter (60 req/min per IP) ──────────────
const rateMap = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX    = 60;
const MAX_IPS     = 500;

function rateOk(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    if (rateMap.size >= MAX_IPS) {
      const oldest = [...rateMap.entries()].sort((a, b) => a[1].start - b[1].start)[0];
      if (oldest) rateMap.delete(oldest[0]);
    }
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_MAX;
}

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

// ── GitHub HTTPS helpers ─────────────────────────────────────
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}/contents/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gantt-netlify-function/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getCurrentSha() {
  const { status, body } = await ghRequest('GET', FILE_PATH);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`GitHub GET returned ${status}`);
  return JSON.parse(body).sha;
}

// ── Payload validation ───────────────────────────────────────
function validatePayload(data) {
  if (!data || typeof data !== 'object') return 'Body must be a JSON object';
  if (!Array.isArray(data.projects))     return 'projects must be an array';
  if (data.users && !Array.isArray(data.users)) return 'users must be an array';

  // Deep-scan for <script> injection
  const json = JSON.stringify(data);
  if (/<script[\s>]/i.test(json)) return 'Payload contains forbidden <script> tag';

  return null;
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  // 1. CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...SECURE_HEADERS,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }

  // 2. Method guard
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // 3. Rate limit
  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  if (!rateOk(ip)) {
    return { statusCode: 429, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Rate limit exceeded. Try again in 60 s.' }) };
  }

  // 4. Auth
  if (!checkAuth(event)) {
    return { statusCode: 401, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // 5. Env guard
  if (!OWNER || !REPO || !TOKEN) {
    console.error('[save-gantt] Missing environment variables');
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  // 6. Size guard
  const rawLen = Buffer.byteLength(event.body || '', 'utf8');
  if (rawLen > MAX_BYTES) {
    return { statusCode: 413, headers: SECURE_HEADERS, body: JSON.stringify({ error: `Payload too large (${rawLen} bytes, max ${MAX_BYTES})` }) };
  }

  // 7. Parse & validate
  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const validationError = validatePayload(data);
  if (validationError) {
    return { statusCode: 422, headers: SECURE_HEADERS, body: JSON.stringify({ error: validationError }) };
  }

  // 8. Server-side metadata stamp
  data._savedAt = new Date().toISOString();
  data._savedBy = 'netlify-function';

  // 9. Atomic write via SHA
  try {
    const sha = await getCurrentSha();
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64');

    const putBody = {
      message: `chore: update gantt state [${new Date().toISOString()}]`,
      content,
      branch: BRANCH,
    };
    if (sha) putBody.sha = sha;

    const { status, body } = await ghRequest('PUT', FILE_PATH, putBody);

    if (status === 200 || status === 201) {
      const ghResp = JSON.parse(body);
      return {
        statusCode: 200,
        headers: SECURE_HEADERS,
        body: JSON.stringify({ ok: true, sha: ghResp.content?.sha || null }),
      };
    }

    if (status === 409 || status === 422) {
      console.error('[save-gantt] Conflict', status);
      return {
        statusCode: 409,
        headers: SECURE_HEADERS,
        body: JSON.stringify({ error: 'Conflict – file was modified by another save. Please reload and try again.' }),
      };
    }

    console.error('[save-gantt] GitHub PUT error', status, body);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };

  } catch (err) {
    console.error('[save-gantt] Unexpected error:', err.message);
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
