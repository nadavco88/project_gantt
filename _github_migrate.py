# -*- coding: utf-8 -*-
import pathlib
import re

p = pathlib.Path(r"c:\gantt_chart\index.html")
text = p.read_text(encoding="utf-8")

old1 = """  - Netlify + GitHub: set env GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GANTT_API_SECRET; optional GANTT_FILE_PATH
    (default data/gantt-state.json). With sync on, GitHub is the source of truth; localStorage is a cache. Export > Remote (GitHub)…; API secret in localStorage per device."""
new1 = """  - GitHub data file: set CONFIG in the script (GITHUB_TOKEN, GITHUB_REPO, GITHUB_FILE, GITHUB_BRANCH).
    The app reads/writes that file via the GitHub Contents API (PAT in page source — see security comment in script)."""
if old1 not in text:
    raise SystemExit("comment block not found")
text = text.replace(old1, new1, 1)

ins = """body.storage-loading{pointer-events:none;opacity:.94}
.github-sync-indicator{position:fixed;top:0;left:0;right:0;z-index:9999;text-align:center;padding:8px 12px;font-size:13px;font-weight:500;background:var(--accent);color:#fff;box-shadow:var(--shadow-lg)}
.github-sync-indicator[hidden]{display:none!important}
"""
marker = "body{display:flex;flex-direction:column}\n"
if marker not in text:
    raise SystemExit("body flex marker not found")
text = text.replace(marker, marker + ins, 1)

text = text.replace(
    '<div id="toast"></div>',
    '<div id="github-sync-indicator" class="github-sync-indicator" hidden aria-live="polite"></div>\n<div id="toast"></div>',
    1,
)

start = text.find("const SK = { data:")
if start == -1:
    raise SystemExit("SK not found")
end = text.find("// ─── Sample data ────────────────────────────────────────────")
if end == -1:
    raise SystemExit("Sample data marker not found")

new_block = r'''const SK = { data:'gantt_projects', theme:'gantt_theme', user:'gantt_active_user' };

// ========== CONFIG (GitHub Contents API) ==========
// ⚠️ WARNING: The GitHub PAT is exposed in client-side code.
// This is acceptable for private/internal tools only.
// For public-facing apps, route writes through a serverless function.
const GITHUB_TOKEN = 'YOUR_PAT_HERE';
const GITHUB_REPO = 'username/my-app-data';
const GITHUB_FILE = 'data.json';
const GITHUB_BRANCH = 'main';
// ==================================================

const MAX_REMOTE_BYTES = Math.floor(1.45 * 1024 * 1024);
const GITHUB_SAVE_DEBOUNCE_MS = 800;

let githubFileSha = null;
let githubSaveTimer = null;
let remoteSaveInFlight = false;

function githubConfigReady(){
  return !!(GITHUB_TOKEN && GITHUB_TOKEN !== 'YOUR_PAT_HERE' && GITHUB_REPO && GITHUB_REPO.indexOf('/') > 0);
}
function githubOwnerRepo(){
  const i = GITHUB_REPO.indexOf('/');
  return { owner: GITHUB_REPO.slice(0, i), repo: GITHUB_REPO.slice(i + 1) };
}
function githubContentsApiUrl(){
  const { owner, repo } = githubOwnerRepo();
  const path = GITHUB_FILE.split('/').map(encodeURIComponent).join('/');
  return 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
}
function githubApiHeaders(){
  return {
    'Authorization': 'Bearer ' + GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}
function base64ToUtf8(b64){
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function utf8ToBase64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(function(b){ bin += String.fromCharCode(b); });
  return btoa(bin);
}
function setGithubSyncIndicator(mode, msg){
  const el = document.getElementById('github-sync-indicator');
  if (!el) return;
  if (mode === 'hidden') {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg || (mode === 'loading' ? 'Loading from GitHub…' : 'Saving to GitHub…');
}
function serializeStateForRemote(){
  return {
    users: state.users,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    activeUser: state.activeUser,
    viewMode: state.viewMode,
    zoomLevel: state.zoomLevel
  };
}
function validateRemotePayload(d){
  return d && typeof d === 'object' && !Array.isArray(d) && (d.projects === void 0 || Array.isArray(d.projects));
}
function mergeRemoteIntoState(d){
  const src = d || {};
  state.users = src.users && src.users.length
    ? src.users.map(function(u){ return { name: String(u.name), color: String(u.color) }; })
    : DEFAULT_USERS.map(function(u){ return { name: u.name, color: u.color }; });
  state.projects = Array.isArray(src.projects) ? JSON.parse(JSON.stringify(src.projects)) : [];
  state.projects.forEach(function(p){ if (!Array.isArray(p.dependencies)) p.dependencies = []; });
  state.activeProjectId = src.activeProjectId || (state.projects[0] && state.projects[0].id) || null;
  state.activeUser = (src.activeUser && state.users.some(function(u){ return u.name === src.activeUser; }))
    ? src.activeUser : state.users[0].name;
  state.viewMode = src.viewMode === 'weekly' ? 'weekly' : 'monthly';
  state.zoomLevel = typeof src.zoomLevel === 'number' ? src.zoomLevel : 1;
  if (!state.activeProjectId && state.projects.length > 0) state.activeProjectId = state.projects[0].id;
}
function remoteSnapshotIsEmpty(d){
  return d && (!d.projects || d.projects.length === 0) && (!d.users || d.users.length === 0);
}

async function loadData(){
  if (!githubConfigReady()) throw new Error('GitHub not configured');
  const url = githubContentsApiUrl() + '?ref=' + encodeURIComponent(GITHUB_BRANCH);
  const r = await fetch(url, { headers: githubApiHeaders() });
  if (r.status === 404) {
    githubFileSha = null;
    return {};
  }
  if (!r.ok) {
    var t = await r.text().catch(function(){ return ''; });
    throw new Error('GitHub ' + r.status + (t ? ': ' + t.slice(0, 200) : ''));
  }
  const j = await r.json();
  if (!j.content || j.type !== 'file') throw new Error('Invalid GitHub response');
  githubFileSha = j.sha || null;
  var raw = base64ToUtf8(j.content.replace(/\n/g, ''));
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function saveData(data, opts){
  opts = opts || {};
  var silent = !!opts.silent;
  var keepalive = !!opts.keepalive;
  var skipIndicator = !!opts.skipIndicator;
  if (!githubConfigReady() || !state) return false;
  var bodyStr = JSON.stringify(data);
  if (bodyStr.length > MAX_REMOTE_BYTES) {
    if (!silent) showToast('Data too large for GitHub file');
    return false;
  }
  if (remoteSaveInFlight && !keepalive) return false;
  remoteSaveInFlight = true;
  if (!skipIndicator && !silent) setGithubSyncIndicator('saving', 'Saving to GitHub…');
  try {
    var attempt = async function(isRetry){
      var url = githubContentsApiUrl();
      var payload = {
        message: 'Update gantt data',
        content: utf8ToBase64(bodyStr),
        branch: GITHUB_BRANCH
      };
      if (githubFileSha) payload.sha = githubFileSha;
      var r = await fetch(url, Object.assign({
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, githubApiHeaders()),
        body: JSON.stringify(payload)
      }, keepalive ? { keepalive: true } : {}));
      if (r.status === 409 && !isRetry) {
        await loadData();
        return attempt(true);
      }
      if (r.status === 401) {
        if (!silent) showToast('GitHub: unauthorized (check PAT)');
        return false;
      }
      if (!r.ok) {
        var errBody = await r.text().catch(function(){ return ''; });
        if (!silent) showToast('GitHub save failed: ' + r.status + (errBody ? ' ' + errBody.slice(0, 80) : ''));
        return false;
      }
      var out = await r.json();
      if (out.content && out.content.sha) githubFileSha = out.content.sha;
      else if (out.commit) { await loadData(); }
      return true;
    };
    return await attempt(false);
  } catch (e) {
    if (!silent) showToast('GitHub save failed: ' + (e.message || String(e)));
    return false;
  } finally {
    remoteSaveInFlight = false;
    if (!skipIndicator && !silent) setGithubSyncIndicator('hidden');
  }
}

function schedulePersistToGitHub(){
  if (!githubConfigReady()) return;
  clearTimeout(githubSaveTimer);
  githubSaveTimer = setTimeout(function(){
    githubSaveTimer = null;
    if (!state) return;
    void saveData(serializeStateForRemote(), { silent: true, skipIndicator: true });
  }, GITHUB_SAVE_DEBOUNCE_MS);
}

function saveLocalOnly(){
  if (githubConfigReady()) {
    schedulePersistToGitHub();
  } else {
    try { sessionStorage.setItem(SK.data, JSON.stringify(state)); } catch (e) {}
    try { sessionStorage.setItem(SK.user, state.activeUser); } catch (e) {}
  }
}

function flushRemoteToGitHub(){
  if (!githubConfigReady() || !state) return;
  clearTimeout(githubSaveTimer);
  githubSaveTimer = null;
  void saveData(serializeStateForRemote(), { keepalive: true, silent: true, skipIndicator: true });
}
function setupRemoteLifecycleFlush(){
  window.addEventListener('pagehide', function(){ flushRemoteToGitHub(); });
}

async function pushRemoteState(opts){
  opts = opts || {};
  return saveData(serializeStateForRemote(), {
    keepalive: !!opts.keepalive,
    silent: opts.silent !== void 0 ? opts.silent : !!opts.keepalive,
    skipIndicator: !!opts.keepalive
  });
}

'''

text = text[:start] + new_block + text[end:]

text = text.replace(
    """function applyLocalOrSample(){
  let d = storageGet(SK.data);""",
    """function applyLocalOrSample(){
  let d = null;
  try{ const raw = sessionStorage.getItem(SK.data); d = raw ? JSON.parse(raw) : null; }catch(e){ d = null; }""",
    1,
)
text = text.replace(
    "  d.activeUser = storageGet(SK.user) || d.activeUser || d.users[0].name;",
    "  try{ const u = sessionStorage.getItem(SK.user); if(u) d.activeUser = u; }catch(e){}\n  d.activeUser = d.activeUser || d.users[0].name;",
    1,
)

text = text.replace(
    """async function loadState(){
  const secret = getRemoteApiSecret();
  if(secret){
    try{
      const data = await fetchRemoteState();
      if(validateRemotePayload(data)){
        state = {users:[],projects:[],activeProjectId:null,activeUser:null,viewMode:'monthly',zoomLevel:1};
        mergeRemoteIntoState(data);
        saveLocalOnly();
        return;
      }
    }catch(e){
      showToast('Could not load from GitHub — using local data. Check deploy and secret.');
    }
  }
  applyLocalOrSample();
}""",
    """async function loadState(){
  document.body.classList.add('storage-loading');
  setGithubSyncIndicator('loading', 'Loading from GitHub…');
  try{
    if(githubConfigReady()){
      try{
        const data = await loadData();
        if(validateRemotePayload(data)){
          state = {users:[],projects:[],activeProjectId:null,activeUser:null,viewMode:'monthly',zoomLevel:1};
          mergeRemoteIntoState(data);
          saveLocalOnly();
          return;
        }
      }catch(e){
        showToast('Could not load from GitHub: ' + (e.message || String(e)));
      }
    }
    applyLocalOrSample();
  }finally{
    setGithubSyncIndicator('hidden');
    document.body.classList.remove('storage-loading');
  }
}""",
    1,
)

text = text.replace(
    """function initTheme(){
  const saved=storageGet(SK.theme);""",
    """function initTheme(){
  let saved=null;
  try{ saved=sessionStorage.getItem(SK.theme); }catch(e){ saved=null; }""",
    1,
)
text = text.replace(
    "  storageSet(SK.theme,next);",
    "  try{ sessionStorage.setItem(SK.theme, next); }catch(e){}",
    1,
)

text = re.sub(
    r"// ─── localStorage helpers ───────────────────────────────────\n"
    r"function storageGet\(k\)\{try\{const v=localStorage\.getItem\(k\);return v\?JSON\.parse\(v\):null\}catch\(e\)\{return null\}\}\n"
    r"function storageSet\(k,v\)\{try\{localStorage\.setItem\(k,JSON\.stringify\(v\)\)\}catch\(e\)\{\}\}\n\n",
    "",
    text,
    count=1,
)

text = text.replace(
    """  document.getElementById('btn-save-server').addEventListener('click',async()=>{
    if(!getRemoteApiSecret()){
      showToast('Connect via Export → Remote (GitHub)… first');
      return;
    }
    const btn=document.getElementById('btn-save-server');
    btn.disabled=true;
    try{
      const ok=await pushRemoteState();
      if(ok){ saveLocalOnly(); showToast('Saved to server'); }
    }finally{ btn.disabled=false; }
  });""",
    """  document.getElementById('btn-save-server').addEventListener('click',async()=>{
    if(!githubConfigReady()){
      showToast('Set GITHUB_TOKEN and GITHUB_REPO in CONFIG at top of script');
      return;
    }
    const btn=document.getElementById('btn-save-server');
    btn.disabled=true;
    try{
      const ok=await saveData(serializeStateForRemote(),{silent:false});
      if(ok){ showToast('Saved to GitHub'); }
    }finally{ btn.disabled=false; }
  });""",
    1,
)

old_modal = """function showRemoteSyncModal(){
  const connected=!!getRemoteApiSecret();
  showModal(`<h3>Remote storage (GitHub)</h3><p>With cloud sync on, <strong>GitHub is the shared source of truth</strong>; this browser also keeps a local copy for speed. Paste the same API secret as in Netlify (<code>GANTT_API_SECRET</code>) — stored in <strong>local storage</strong> on this device until you disconnect. Each device enters the secret once.</p>${connected?'<p style="font-size:12px;color:var(--text-secondary)">Cloud sync: on (this browser)</p>':''}<input type="password" class="modal-input" id="modal-remote-secret" placeholder="API secret" autocomplete="off"><div id="modal-actions" style="flex-wrap:wrap;gap:8px"><button class="modal-cancel" id="mc-cancel">Close</button>${connected?'<button class="modal-danger" id="mc-disconnect">Disconnect</button>':''}<button class="modal-confirm" id="mc-load">Load from GitHub</button><button class="modal-confirm" id="mc-save">Save to GitHub now</button></div>`);
  document.getElementById('mc-cancel').addEventListener('click',closeModal);
  const disc=document.getElementById('mc-disconnect');
  if(disc)disc.addEventListener('click',()=>{setRemoteApiSecret('');closeModal();showToast('Remote disconnected');updateRemoteMenuLabel();});
  document.getElementById('mc-load').addEventListener('click',async ()=>{
    const v=document.getElementById('modal-remote-secret').value.trim();
    if(v)setRemoteApiSecret(v);
    if(!getRemoteApiSecret()){showToast('Enter API secret');return}
    closeModal();
    try{
      const data=await fetchRemoteState();
      if(!validateRemotePayload(data)){showToast('Invalid remote data');return}
      const emptyRemote=remoteSnapshotIsEmpty(data);
      const msg=emptyRemote
        ?'GitHub has no projects yet. Replace this browser's local data with an empty board?'
        :'Load state from GitHub? Unsaved local changes will be overwritten.';
      showConfirmModal('Replace local data?',msg,'Load','confirm',()=>{
        state={users:[],projects:[],activeProjectId:null,activeUser:null,viewMode:'monthly',zoomLevel:1};
        mergeRemoteIntoState(data);
        undoStack=[];redoStack=[];
        saveLocalOnly();
        updateRemoteMenuLabel();
        scrollToTodayOnce=true;
        render();
        showToast('Loaded from GitHub');
      });
    }catch(e){showToast('Load failed (check secret and Netlify)');}
  });
  document.getElementById('mc-save').addEventListener('click',async ()=>{
    const v=document.getElementById('modal-remote-secret').value.trim();
    if(v)setRemoteApiSecret(v);
    if(!getRemoteApiSecret()){showToast('Enter API secret');return}
    closeModal();
    const ok=await pushRemoteState();
    if(ok)showToast('Saved to GitHub');
    updateRemoteMenuLabel();
  });
}"""

new_modal = """function showRemoteSyncModal(){
  showModal(`<h3>GitHub configuration</h3><p>Edit the <strong>CONFIG</strong> block at the top of this file: <code>GITHUB_TOKEN</code>, <code>GITHUB_REPO</code>, <code>GITHUB_FILE</code>, and <code>GITHUB_BRANCH</code>. Reload the page after saving. The PAT is embedded in the page (see security comment in the script).</p><div id="modal-actions"><button class="modal-confirm" id="mc-cancel">OK</button></div>`);
  document.getElementById('mc-cancel').addEventListener('click',closeModal);
}"""

if old_modal not in text:
    raise SystemExit('showRemoteSyncModal block not found')
text = text.replace(old_modal, new_modal, 1)

text = text.replace(
    """function updateRemoteMenuLabel(){
  const el=document.getElementById('btn-remote-sync');
  if(!el)return;
  el.innerHTML=getRemoteApiSecret()
    ?'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="4" rx="3" ry="1.8"/><path d="M4 4v3c0 1.2 1.3 2.2 3 2.2s3-1 3-2.2V4"/><path d="M4 7v3c0 1.2 1.3 2.2 3 2.2"/></svg> Remote ●'
    :'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="4" rx="3" ry="1.8"/><path d="M4 4v3c0 1.2 1.3 2.2 3 2.2s3-1 3-2.2V4"/><path d="M4 7v3c0 1.2 1.3 2.2 3 2.2"/></svg> Remote (GitHub)…';
}""",
    """function updateRemoteMenuLabel(){
  const el=document.getElementById('btn-remote-sync');
  if(!el)return;
  el.innerHTML=githubConfigReady()
    ?'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="4" rx="3" ry="1.8"/><path d="M4 4v3c0 1.2 1.3 2.2 3 2.2s3-1 3-2.2V4"/><path d="M4 7v3c0 1.2 1.3 2.2 3 2.2"/></svg> Remote ●'
    :'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="4" rx="3" ry="1.8"/><path d="M4 4v3c0 1.2 1.3 2.2 3 2.2s3-1 3-2.2V4"/><path d="M4 7v3c0 1.2 1.3 2.2 3 2.2"/></svg> Remote (GitHub)…';
}""",
    1,
)

p.write_text(text, encoding="utf-8")
print("OK")
