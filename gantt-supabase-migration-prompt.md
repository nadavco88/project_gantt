# Gantt Chart — Supabase Backend Migration Prompt

## Your Mission

Migrate the Gantt Chart app (`index.html`) from its current GitHub-file-based backend to a **Supabase (Postgres) backend**. The goal is real-time multi-user sync: when Alice saves a task, Bob sees it within ~1 second without refreshing.

You will:
1. Design and create the Supabase database schema
2. Rewrite the two Netlify functions (`load-gantt.js`, `save-gantt.js`)
3. Make **minimal, targeted edits** to `index.html` — only the remote sync layer needs to change
4. Enable Supabase Realtime so all connected users receive live updates

Do **not** rewrite the rendering engine, drag-and-drop, undo/redo, or any UI logic. Those are untouched.

---

## Current Architecture (what exists today)

### Frontend sync contract (inside `index.html`)

These are the only functions you need to replace or adapt:

| Function | What it does |
|---|---|
| `fetchRemoteState()` | GET `/.netlify/functions/load-gantt` → returns full state blob |
| `pushRemoteState(opts)` | POST `/.netlify/functions/save-gantt` → sends full state blob |
| `queueRemoteSave()` | Debounces `pushRemoteState` by 500 ms |
| `loadState()` | Called on init: tries remote first, falls back to localStorage |
| `saveLocalOnly()` | Saves to localStorage + calls `queueRemoteSave()` |
| `mergeRemoteIntoState(d)` | Merges a valid remote payload into `state` |
| `setGithubSyncIndicator(mode, msg)` | Shows/hides the top sync banner |
| `flushRemoteToGitHub()` | Called on `pagehide` to force a final save — rename this to `flushRemoteOnExit()` |

### Current state shape (the JSON blob saved/loaded today)

```js
{
  users: [{ name: string, color: string }],
  projects: [{
    id: string,         // 9-char random alphanumeric
    name: string,
    color: string,
    tasks: [{
      id: string,
      name: string,
      startDate: string,   // "YYYY-MM-DD"
      endDate: string,     // "YYYY-MM-DD"
      assignee: string,    // matches a user.name
      status: "not_started" | "in_progress" | "done",
      notes: string,
      colorIndex: number,
      isMilestone: boolean,
      lastEditedBy: string | null,
      lastEditedAt: number | null   // Unix ms timestamp
    }],
    dependencies: [{ from: string, to: string }]  // task IDs
  }],
  activeProjectId: string,
  activeUser: string,
  viewMode: "monthly" | "weekly",
  zoomLevel: number
}
```

### Current environment variables (Netlify)

```
GANTT_API_SECRET     ← shared Bearer token; users paste this in the app UI
```

The new backend will keep `GANTT_API_SECRET` for authenticating function calls, and add Supabase vars.

---

## Target Architecture

```
Browser (index.html)
    │
    │  GET  /.netlify/functions/load-gantt   (initial load)
    │  POST /.netlify/functions/save-gantt   (debounced saves)
    │
    │  ALSO: Supabase Realtime subscription (direct from browser)
    │        wss://your-project.supabase.co/realtime/v1/websocket
    ▼
Netlify Functions (Node.js)
    │
    │  Authenticate with GANTT_API_SECRET
    │  Read / write rows via Supabase REST API
    │  Use SUPABASE_SERVICE_ROLE_KEY (never exposed to browser)
    ▼
Supabase Postgres
    ├── table: gantt_projects
    ├── table: gantt_tasks
    ├── table: gantt_dependencies
    └── table: gantt_users
    
    Realtime channel: "gantt-sync"
    ← broadcasts row changes to all subscribed browsers
```

---

## Step 1 — Supabase Project Setup

1. Create a free account at [supabase.com](https://supabase.com)
2. Click **"New project"** — choose a region close to your users
3. Note down from **Project Settings → API**:
   - `Project URL` → becomes `SUPABASE_URL`
   - `anon public` key → becomes `SUPABASE_ANON_KEY` (safe to use in browser for Realtime)
   - `service_role` key → becomes `SUPABASE_SERVICE_ROLE_KEY` (**never expose in browser**)

---

## Step 2 — Database Schema

Run this SQL in **Supabase → SQL Editor → New query**:

```sql
-- ── Users ──────────────────────────────────────────────────────
CREATE TABLE gantt_users (
  name        TEXT PRIMARY KEY,
  color       TEXT NOT NULL DEFAULT '#4f6ef7',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Projects ───────────────────────────────────────────────────
CREATE TABLE gantt_projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#4f6ef7',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Tasks ──────────────────────────────────────────────────────
CREATE TABLE gantt_tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES gantt_projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  assignee        TEXT REFERENCES gantt_users(name) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'not_started'
                  CHECK (status IN ('not_started','in_progress','done')),
  notes           TEXT DEFAULT '',
  color_index     INTEGER DEFAULT 0,
  is_milestone    BOOLEAN DEFAULT FALSE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  last_edited_by  TEXT,
  last_edited_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Dependencies ───────────────────────────────────────────────
CREATE TABLE gantt_dependencies (
  id          SERIAL PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES gantt_projects(id) ON DELETE CASCADE,
  from_task   TEXT NOT NULL REFERENCES gantt_tasks(id) ON DELETE CASCADE,
  to_task     TEXT NOT NULL REFERENCES gantt_tasks(id) ON DELETE CASCADE,
  UNIQUE (from_task, to_task)
);

-- ── App-level settings (single row) ────────────────────────────
CREATE TABLE gantt_settings (
  id                  INTEGER PRIMARY KEY DEFAULT 1,   -- enforces single row
  active_project_id   TEXT,
  view_mode           TEXT DEFAULT 'monthly',
  zoom_level          NUMERIC DEFAULT 1,
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  CHECK (id = 1)
);
INSERT INTO gantt_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── Auto-update updated_at ──────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON gantt_projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON gantt_tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

---

## Step 3 — Row Level Security (RLS)

Your app uses a **shared secret** (not individual user auth), so the strategy is: the Netlify functions use the `service_role` key (bypasses RLS), and the browser only uses the `anon` key for **Realtime subscriptions only** (read-only channel listening).

```sql
-- Enable RLS on all tables
ALTER TABLE gantt_users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gantt_projects     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gantt_tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE gantt_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE gantt_settings     ENABLE ROW LEVEL SECURITY;

-- Anon key: SELECT only (needed for Realtime to work)
-- All writes go through Netlify functions (service_role, bypasses RLS)
CREATE POLICY "anon read users"        ON gantt_users        FOR SELECT USING (true);
CREATE POLICY "anon read projects"     ON gantt_projects     FOR SELECT USING (true);
CREATE POLICY "anon read tasks"        ON gantt_tasks        FOR SELECT USING (true);
CREATE POLICY "anon read deps"         ON gantt_dependencies FOR SELECT USING (true);
CREATE POLICY "anon read settings"     ON gantt_settings     FOR SELECT USING (true);

-- No INSERT/UPDATE/DELETE from anon key — only service_role (functions) can write
```

---

## Step 4 — Enable Realtime

In **Supabase dashboard → Database → Replication**:
- Enable Realtime for: `gantt_projects`, `gantt_tasks`, `gantt_dependencies`, `gantt_users`, `gantt_settings`

This allows the browser to subscribe to row-level change events on these tables.

---

## Step 5 — Netlify Environment Variables

Add these in **Netlify → Project configuration → Environment variables**, all scoped to **Functions**, **Production** context, marked sensitive where noted:

| Key | Value | Sensitive? |
|---|---|---|
| `SUPABASE_URL` | `https://your-project-ref.supabase.co` | No |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → Settings → API | ✅ Yes |
| `SUPABASE_ANON_KEY` | from Supabase → Settings → API | No |
| `GANTT_API_SECRET` | keep existing value | ✅ Yes |

> **Why keep `GANTT_API_SECRET`?** The Netlify functions still need to verify that only your app (not random internet traffic) can call the load/save endpoints. `SUPABASE_SERVICE_ROLE_KEY` is separate — it authenticates the *function to Supabase*, not the *browser to the function*.

---

## Step 6 — Rewrite `netlify/functions/load-gantt.js`

**Contract:** same as before — GET request returns the same JSON shape that `mergeRemoteIntoState()` already understands.

Logic to implement:
1. Verify `Authorization: Bearer <GANTT_API_SECRET>` with `crypto.timingSafeEqual`
2. Use `SUPABASE_SERVICE_ROLE_KEY` to query all five tables via Supabase REST API
3. Reassemble the exact state blob shape the frontend expects:
   ```js
   {
     users: [...],
     projects: [
       { id, name, color, tasks: [...], dependencies: [...] }
     ],
     activeProjectId,
     viewMode,
     zoomLevel
   }
   ```
4. Return `200` with that JSON
5. On any Supabase error, return `502`

**Key mapping** (Supabase snake_case → frontend camelCase):
- `start_date` → `startDate`
- `end_date` → `endDate`
- `color_index` → `colorIndex`
- `is_milestone` → `isMilestone`
- `last_edited_by` → `lastEditedBy`
- `last_edited_at` → `lastEditedAt` (convert ISO string to Unix ms: `new Date(row.last_edited_at).getTime()`)
- `sort_order` → used internally to preserve task ordering within a project

---

## Step 7 — Rewrite `netlify/functions/save-gantt.js`

**Contract:** same POST endpoint. Receives the full state blob. Performs an **upsert** (insert or update) for every entity, and deletes rows that are no longer present.

Logic to implement:
1. Verify auth (same `timingSafeEqual` check)
2. Validate payload schema (same checks as before)
3. Use `SUPABASE_SERVICE_ROLE_KEY` for all writes
4. For each table, use Supabase's **upsert** (`POST /rest/v1/table?on_conflict=id`) to handle both new and updated rows
5. **Delete orphaned rows**: after upserting, delete any `gantt_tasks` rows whose `id` is not in the incoming payload for that project, and similarly for `gantt_dependencies`
6. Update `gantt_settings` row (id=1) with `active_project_id`, `view_mode`, `zoom_level`
7. Return `200 { ok: true }`

**Delete strategy** (prevents stale data):
```
For each project in payload:
  DELETE FROM gantt_tasks WHERE project_id = p.id AND id NOT IN (incoming task ids)
  DELETE FROM gantt_dependencies WHERE project_id = p.id AND (from_task, to_task) NOT IN (incoming dep pairs)
DELETE FROM gantt_projects WHERE id NOT IN (incoming project ids)
DELETE FROM gantt_users WHERE name NOT IN (incoming user names)
```

**camelCase → snake_case mapping** (reverse of load):
- `startDate` → `start_date`
- `endDate` → `end_date`
- `colorIndex` → `color_index`
- `isMilestone` → `is_milestone`
- `lastEditedBy` → `last_edited_by`
- `lastEditedAt` (Unix ms) → `last_edited_at` (ISO string: `new Date(ms).toISOString()`)

---

## Step 8 — Frontend Changes to `index.html`

Make **only these targeted edits** — do not touch rendering, drag-and-drop, or undo/redo:

### 8a. Add Supabase JS client (in `<head>`, before closing `</head>`)
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
```

### 8b. Add two new constants (near the top of the `<script>` block, alongside `REMOTE_LOAD` / `REMOTE_SAVE`)
```js
const SUPABASE_URL      = 'https://your-project-ref.supabase.co';   // hardcode — not secret
const SUPABASE_ANON_KEY = 'your-anon-key';                           // hardcode — not secret
```

### 8c. Add Realtime subscription setup function
Add a new function `setupRealtimeSync()` that:
1. Creates a Supabase client: `supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`
2. Subscribes to the `"gantt-sync"` channel listening to `postgres_changes` on all five tables
3. On any change event received from another client:
   - Skip if the change was triggered within 2 seconds of the local user's last save (debounce self-echo)
   - Otherwise: call `fetchRemoteState()` → `mergeRemoteIntoState(data)` → `render()`
   - Update the sync indicator banner: briefly show "Updated by another user" then hide

### 8d. Update `init()` function
Add one line at the end of `init()`:
```js
setupRealtimeSync();
```

### 8e. Rename `flushRemoteToGitHub` → `flushRemoteOnExit`
Update the `pagehide` listener and the function name. This is cosmetic but avoids confusion.

### 8f. Update sync indicator text
In `setGithubSyncIndicator()`, change the display strings:
- `'Loading from GitHub…'` → `'Loading from Supabase…'`
- `'Saving to GitHub…'` → `'Saving…'`
- Toast message `'Could not load from GitHub — using local data. Check deploy and secret.'` → `'Could not load from Supabase — using local data.'`

---

## Step 9 — End-to-End Verification Checklist

### Setup
- [ ] Supabase project created, URL and keys noted
- [ ] SQL schema executed with no errors
- [ ] RLS policies applied
- [ ] Realtime enabled for all five tables
- [ ] All four Netlify env vars set, scoped to Functions + Production
- [ ] Netlify redeployed after env var changes

### Load function
- [ ] `GET /.netlify/functions/load-gantt` with correct Bearer token returns valid JSON matching the state shape
- [ ] Response includes `users`, `projects` (with nested `tasks` and `dependencies`), `activeProjectId`, `viewMode`, `zoomLevel`
- [ ] `GET` without token returns `401`
- [ ] First load on empty DB returns `{ projects: [], users: [] }` without errors

### Save function
- [ ] `POST /.netlify/functions/save-gantt` with full state blob returns `{ ok: true }`
- [ ] After save, rows are visible in Supabase Table Editor
- [ ] Deleting a task in the app and saving removes the row from `gantt_tasks`
- [ ] Deleting a project removes all its tasks and dependencies (cascade)
- [ ] `POST` without token returns `401`
- [ ] Oversized payload returns `413`

### Realtime sync
- [ ] Open the app in **two browser tabs**
- [ ] In Tab A, add a new task and wait 600 ms (debounce)
- [ ] Tab B shows the new task within ~1–2 seconds without manual refresh
- [ ] Sync indicator briefly shows "Updated by another user" in Tab B
- [ ] Editing the same task in both tabs simultaneously: last save wins, no crash, no data loss

### Fallback
- [ ] Disconnect from internet, make changes → localStorage caching works, changes survive page reload
- [ ] Reconnect → on next page load, remote state is fetched and overwrites local (remote is source of truth)

---

## Security Hardening Checklist

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **never** referenced in `index.html` or any client-side code
- [ ] `SUPABASE_ANON_KEY` used in browser only for Realtime (read-only subscriptions) — this is safe by design
- [ ] RLS confirmed: test that a direct `curl` to Supabase REST with the anon key **cannot** INSERT or UPDATE any row
- [ ] `GANTT_API_SECRET` still guards the Netlify function endpoints
- [ ] Netlify env vars marked sensitive in dashboard
- [ ] Supabase → Settings → Auth: disable **email signups** and **OAuth providers** (you're not using Supabase Auth)
- [ ] Supabase → Settings → API: confirm `service_role` key is not logged or exposed anywhere

---

## Data Migration (from existing GitHub JSON file)

If you have existing data in `data/gantt-state.json` from the old GitHub backend:

1. Copy the JSON locally
2. Write a one-time Node.js migration script that:
   - Reads the JSON file
   - POSTs it to `/.netlify/functions/save-gantt` with the correct Bearer token
   - Verifies the response is `{ ok: true }`
3. Load the app and confirm all projects and tasks appear correctly
4. The old `data/gantt-state.json` file and the GitHub-backend functions can then be deleted

---

## Known Limitations & Notes

| Topic | Detail |
|---|---|
| Conflict model | Still last-write-wins at the full-state level. Two users editing the **same task** simultaneously will have one overwrite the other. For the majority of team Gantt use cases this is acceptable. True operational-transform (like Google Docs) would require a significantly more complex architecture. |
| Realtime self-echo | Supabase Realtime broadcasts to **all** subscribers including the sender. The 2-second debounce window in `setupRealtimeSync()` prevents the local user from re-fetching their own just-saved data. |
| Free tier limits | Supabase free tier: 500 MB DB, 2 GB bandwidth, 200 concurrent Realtime connections. More than sufficient for a team Gantt tool. |
| `activeUser` | The current app's "active user" is a display name stored in `sessionStorage` — it is not authenticated. This is unchanged. If you later want per-user auth, Supabase Auth integrates cleanly. |
| Supabase client version | Use `@supabase/supabase-js@2` (v2). The Realtime API changed significantly between v1 and v2. |
