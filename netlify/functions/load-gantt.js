// netlify/functions/load-gantt.js
// GET /.netlify/functions/load-gantt
// Queries Supabase tables and returns the assembled state blob.
// Publicly accessible — no auth required.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SECURE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Access-Control-Allow-Origin': '*',
};

async function supabaseGet(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${body}`);
  }
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...SECURE_HEADERS,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[load-gantt] Missing Supabase env vars');
    return { statusCode: 500, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Server misconfiguration' }) };
  }

  try {
    const [users, projects, tasks, deps, settingsRows] = await Promise.all([
      supabaseGet('gantt_users', 'order=name.asc'),
      supabaseGet('gantt_projects', 'order=sort_order.asc,created_at.asc'),
      supabaseGet('gantt_tasks', 'order=sort_order.asc,created_at.asc'),
      supabaseGet('gantt_dependencies'),
      supabaseGet('gantt_settings', 'id=eq.1'),
    ]);

    const settings = settingsRows[0] || {};

    const tasksByProject = {};
    for (const t of tasks) {
      if (!tasksByProject[t.project_id]) tasksByProject[t.project_id] = [];
      tasksByProject[t.project_id].push({
        id: t.id,
        name: t.name,
        startDate: t.start_date,
        endDate: t.end_date,
        assignee: t.assignee || null,
        status: t.status,
        notes: t.notes || '',
        colorIndex: t.color_index ?? 0,
        isMilestone: !!t.is_milestone,
        lastEditedBy: t.last_edited_by || null,
        lastEditedAt: t.last_edited_at ? new Date(t.last_edited_at).getTime() : null,
      });
    }

    const depsByProject = {};
    for (const d of deps) {
      if (!depsByProject[d.project_id]) depsByProject[d.project_id] = [];
      depsByProject[d.project_id].push({ from: d.from_task, to: d.to_task });
    }

    const assembled = {
      users: users.map(u => ({ name: u.name, color: u.color })),
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        tasks: tasksByProject[p.id] || [],
        dependencies: depsByProject[p.id] || [],
      })),
      activeProjectId: settings.active_project_id || null,
      viewMode: settings.view_mode || 'monthly',
      zoomLevel: settings.zoom_level != null ? Number(settings.zoom_level) : 1,
    };

    return { statusCode: 200, headers: SECURE_HEADERS, body: JSON.stringify(assembled) };

  } catch (err) {
    console.error('[load-gantt] Error:', err.message);
    return { statusCode: 502, headers: SECURE_HEADERS, body: JSON.stringify({ error: 'Upstream error' }) };
  }
};
