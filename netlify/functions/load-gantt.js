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
  'Access-Control-Allow-Origin': '*',
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
  // 1. CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...SECURE_HEADERS,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }

  // 2. Method guard
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
