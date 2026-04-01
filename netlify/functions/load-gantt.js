'use strict';

const crypto = require('crypto');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    },
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

function emptyState() {
  return {
    users: [],
    projects: [],
    activeProjectId: null,
    activeUser: null,
    viewMode: 'monthly',
    zoomLevel: 1
  };
}

function validateLoaded(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!Array.isArray(obj.projects)) return false;
  if (obj.users != null && !Array.isArray(obj.users)) return false;
  for (const p of obj.projects) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Array.isArray(p.tasks)) return false;
  }
  return true;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!verifyBearer(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const ghToken = process.env.GITHUB_TOKEN;
  const filePath = process.env.GANTT_FILE_PATH || 'data/gantt-state.json';

  if (!owner || !repo || !ghToken) {
    return json(500, { error: 'Server misconfigured' });
  }

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${githubContentsPath(filePath)}`;

  let res;
  try {
    res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${ghToken}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
  } catch {
    return json(502, { error: 'Upstream request failed' });
  }

  if (res.status === 404) {
    return json(200, emptyState());
  }

  if (!res.ok) {
    return json(502, { error: 'GitHub request failed' });
  }

  let meta;
  try {
    meta = await res.json();
  } catch {
    return json(502, { error: 'Invalid GitHub response' });
  }

  if (!meta.content || typeof meta.content !== 'string') {
    return json(502, { error: 'Invalid file metadata' });
  }

  let parsed;
  try {
    const text = Buffer.from(meta.content.replace(/\s/g, ''), 'base64').toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    return json(502, { error: 'Invalid stored JSON' });
  }

  if (!validateLoaded(parsed)) {
    return json(502, { error: 'Invalid stored schema' });
  }

  return json(200, parsed);
};
