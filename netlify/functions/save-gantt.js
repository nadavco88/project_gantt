'use strict';

const crypto = require('crypto');

const MAX_BYTES = Math.floor(1.5 * 1024 * 1024);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

function verifyBearer(event) {
  const secret = process.env.GANTT_API_SECRET;
  if (!secret || typeof secret !== 'string') return false;
  const h = event.headers.authorization || event.headers.Authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(String(h).trim());
  if (!m) return false;
  try {
    const a = crypto.createHash('sha256').update(m[1], 'utf8').digest();
    const b = crypto.createHash('sha256').update(secret, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function githubContentsPath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function validatePayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.projects)) return false;
  if (obj.users != null && !Array.isArray(obj.users)) return false;
  for (const p of obj.projects) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.tasks)) return false;
  }
  return true;
}

function normalizeForStore(payload) {
  return {
    users: Array.isArray(payload.users) ? payload.users : [],
    projects: payload.projects,
    activeProjectId: payload.activeProjectId != null ? payload.activeProjectId : null,
    activeUser: payload.activeUser != null ? payload.activeUser : null,
    viewMode: payload.viewMode === 'weekly' ? 'weekly' : 'monthly',
    zoomLevel: typeof payload.zoomLevel === 'number' && !Number.isNaN(payload.zoomLevel) ? payload.zoomLevel : 1
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!verifyBearer(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  let raw = event.body || '';
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!validatePayload(payload)) {
    return json(400, { error: 'Invalid payload' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const ghToken = process.env.GITHUB_TOKEN;
  const filePath = process.env.GANTT_FILE_PATH || 'data/gantt-state.json';

  if (!owner || !repo || !ghToken) {
    return json(500, { error: 'Server misconfigured' });
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${githubContentsPath(filePath)}`;

  let getRes;
  try {
    getRes = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch {
    return json(502, { error: 'Upstream request failed' });
  }

  let sha = null;
  if (getRes.status === 200) {
    let meta;
    try {
      meta = await getRes.json();
    } catch {
      return json(502, { error: 'Invalid GitHub response' });
    }
    if (meta.sha) sha = meta.sha;
  } else if (getRes.status !== 404) {
    return json(502, { error: 'GitHub read failed' });
  }

  const normalized = normalizeForStore(payload);
  const jsonStr = JSON.stringify(normalized);
  const content = Buffer.from(jsonStr, 'utf8').toString('base64');

  const putBody = {
    message: 'Update Gantt state',
    content,
    ...(sha ? { sha } : {})
  };

  let putRes;
  try {
    putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(putBody)
    });
  } catch {
    return json(502, { error: 'Upstream request failed' });
  }

  if (putRes.status === 422 || putRes.status === 409) {
    return json(409, { error: 'conflict', code: 'conflict' });
  }

  if (!putRes.ok) {
    return json(502, { error: 'GitHub write failed' });
  }

  return json(200, { ok: true });
};
