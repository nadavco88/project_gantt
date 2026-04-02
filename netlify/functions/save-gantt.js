// netlify/functions/save-gantt.js
// POST /.netlify/functions/save-gantt
// Validates the state blob and upserts/deletes rows in Supabase.
// Publicly accessible — rate-limited but no auth required.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_BYTES = 1.5 * 1024 * 1024;

const SECURE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Access-Control-Allow-Origin': '*',
};

// ── Rate limiter (60 req/min per IP) ────────────────────────
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

function validatePayload(data) {
  if (!data || typeof data !== 'object') return 'Body must be a JSON object';
  if (!Array.isArray(data.projects)) return 'projects must be an array';
  if (data.users && !Array.isArray(data.users)) return 'users must be an array';
  const json = JSON.stringify(data);
  if (/<script[\s>]/i.test(json)) return 'Payload contains forbidden <script> tag';
  return null;
}

// ── Supabase REST helpers ───────────────────────────────────
const sbHeaders = {
  'apikey': '',
  'Authorization': '',
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

function initSbHeaders() {
  sbHeaders['apikey'] = SUPABASE_SERVICE_KEY;
  sbHeaders['Authorization'] = `Bearer ${SUPABASE_SERVICE_KEY}`;
}

async function sbRequest(method, table, query, body, extraHeaders) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const opts = {
    method,
    headers: { ...sbHeaders, ...(extraHeaders || {}) },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${table} failed: ${res.status} ${text}`);
  }
  return res;
}

async function upsert(table, rows, conflictCols) {
  if (!rows || rows.length === 0) return;
  const headers = {
    'Prefer': 'resolution=merge-duplicates,return=minimal',
  };
  await sbRequest('POST', table, conflictCols ? `on_conflict=${conflictCols}` : '', rows, headers);
}

async function deleteWhere(table, query) {
  await sbRequest('DELETE', table, query, undefined);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...SECURE_HEADERS,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
  if (!rateOk(ip)) {
    return { statusCode: 429, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Rate limit exceeded. Try again in 60 s.' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[save-gantt] Missing Supabase env vars');
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  const rawLen = Buffer.byteLength(event.body || '', 'utf8');
  if (rawLen > MAX_BYTES) {
    return { statusCode: 413, headers: SECURE_HEADERS, body: JSON.stringify({ error: `Payload too large (${rawLen} bytes, max ${MAX_BYTES})` }) };
  }

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

  initSbHeaders();

  try {
    const incomingUsers = (data.users || []).map(u => ({
      name: u.name,
      color: u.color || '#4f6ef7',
    }));
    if (incomingUsers.length > 0) {
      await upsert('gantt_users', incomingUsers, 'name');
    }

    const userNames = incomingUsers.map(u => u.name);
    if (userNames.length > 0) {
      await deleteWhere('gantt_users', `name=not.in.(${userNames.map(n => `"${n}"`).join(',')})`);
    } else {
      await deleteWhere('gantt_users', 'name=neq.___placeholder___');
    }

    const incomingProjects = (data.projects || []).map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.color || '#4f6ef7',
      sort_order: i,
    }));
    if (incomingProjects.length > 0) {
      await upsert('gantt_projects', incomingProjects, 'id');
    }

    const projectIds = incomingProjects.map(p => p.id);
    if (projectIds.length > 0) {
      await deleteWhere('gantt_projects', `id=not.in.(${projectIds.map(id => `"${id}"`).join(',')})`);
    } else {
      await deleteWhere('gantt_projects', 'id=neq.___placeholder___');
    }

    for (const p of (data.projects || [])) {
      const incomingTasks = (p.tasks || []).map((t, i) => ({
        id: t.id,
        project_id: p.id,
        name: t.name,
        start_date: t.startDate,
        end_date: t.endDate || t.startDate,
        assignee: t.assignee || null,
        status: t.status || 'not_started',
        notes: t.notes || '',
        color_index: t.colorIndex ?? 0,
        is_milestone: !!t.isMilestone,
        sort_order: i,
        last_edited_by: t.lastEditedBy || null,
        last_edited_at: t.lastEditedAt ? new Date(t.lastEditedAt).toISOString() : null,
      }));

      if (incomingTasks.length > 0) {
        await upsert('gantt_tasks', incomingTasks, 'id');
      }

      const taskIds = incomingTasks.map(t => t.id);
      if (taskIds.length > 0) {
        await deleteWhere('gantt_tasks', `project_id=eq.${p.id}&id=not.in.(${taskIds.map(id => `"${id}"`).join(',')})`);
      } else {
        await deleteWhere('gantt_tasks', `project_id=eq.${p.id}`);
      }

      const incomingDeps = (p.dependencies || []).map(d => ({
        project_id: p.id,
        from_task: d.from,
        to_task: d.to,
      }));

      await deleteWhere('gantt_dependencies', `project_id=eq.${p.id}`);
      if (incomingDeps.length > 0) {
        await sbRequest('POST', 'gantt_dependencies', '', incomingDeps, { 'Prefer': 'return=minimal' });
      }
    }

    const settingsRow = {
      id: 1,
      active_project_id: data.activeProjectId || null,
      view_mode: data.viewMode || 'monthly',
      zoom_level: data.zoomLevel ?? 1,
    };
    await upsert('gantt_settings', [settingsRow], 'id');

    return {
      statusCode: 200,
      headers: SECURE_HEADERS,
      body: JSON.stringify({ ok: true }),
    };

  } catch (err) {
    console.error('[save-gantt] Error:', err.message);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };
  }
};
