// Board HTML template for the kanban web UI
//
// This is a self-contained vanilla HTML/JS single-page app that:
// - Polls GET /api/stories, GET /api/team, GET /api/status every 3 seconds
// - Renders stories as swimlanes with task cards in status columns
// - Provides search, filter (All/Open/Done/Ready/Blocked), and sort controls
// - Supports full task CRUD: create, view detail, edit, delete, move status
// - Supports story creation via modal with inline task definitions
// - Persists filter/sort/search preferences in localStorage
//
// The workflow transitions are fetched from GET /api/status and used to
// determine which status moves are available for the lead on each task card.


const BOARD_HTML = `<!DOCTYPE html>
<html><head><title>🍕 pi-pizza-team board</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { margin-bottom: 20px; font-size: 1.5em; }
  .team-bar { display: flex; gap: 16px; margin-bottom: 20px; padding: 12px; background: #16213e; border-radius: 8px; flex-wrap: wrap; }
  .member { font-size: 0.85em; }
  .member-working { color: #4caf50; }
  .member-idle { color: #888; }
  .refresh { font-size: 0.7em; color: #555; }
  .swimlane { margin-bottom: 24px; border: 1px solid #0f3460; border-radius: 8px; overflow: hidden; }
  .swimlane-header { background: #0f3460; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; }
  .swimlane-title { font-weight: 600; font-size: 0.95em; }
  .swimlane-meta { font-size: 0.75em; color: #888; display: flex; align-items: center; gap: 8px; }
  .btn-add-task-inline { background: none; border: 1px solid #1a4080; color: #7c83ff; padding: 3px 8px; border-radius: 4px; font-size: 0.85em; cursor: pointer; transition: all 0.15s; }
  .btn-add-task-inline:hover { background: #0f3460; border-color: #7c83ff; }
  .swimlane-blocked { opacity: 0.5; }
  .swimlane-blocked .swimlane-header { background: #1a1a2e; border-bottom: 1px solid #0f3460; }
  .board { display: flex; gap: 2px; min-height: 60px; }
  .column { flex: 1; min-width: 140px; background: #16213e; padding: 10px; }
  .column h2 { font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.05em; color: #7c83ff; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #0f3460; }
  .card { background: #0f3460; border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; transition: background 0.15s; position: relative; }
  .card:hover { background: #1a4080; }
  .card:hover .card-actions { opacity: 1; }
  .card-title { font-size: 0.8em; font-weight: 600; margin-bottom: 3px; }
  .card-meta { font-size: 0.7em; color: #888; }
  .card-assignee { font-size: 0.7em; color: #7c83ff; margin-top: 2px; }
  .card-msg { font-size: 0.7em; color: #ffa500; margin-top: 2px; }
  .card-desc { font-size: 0.72em; color: #aaa; margin-top: 4px; max-height: 60px; overflow: hidden; white-space: pre-wrap; line-height: 1.4; }
  .card-actions { position: absolute; top: 4px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
  .card-actions button { background: none; border: none; color: #888; cursor: pointer; font-size: 0.75em; padding: 2px 4px; border-radius: 3px; }
  .card-actions button:hover { color: #e0e0e0; background: rgba(255,255,255,0.1); }
  .card-actions .btn-del:hover { color: #ff5252; }
  .card-move { margin-top: 4px; }
  .card-move select { background: #1a1a2e; border: 1px solid #0f3460; color: #aaa; border-radius: 4px; padding: 2px 4px; font-size: 0.7em; cursor: pointer; outline: none; }
  .card-move select:focus { border-color: #7c83ff; }
  .progress { font-size: 0.75em; color: #4caf50; }
  .empty-col { min-height: 20px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .toolbar h1 { margin-bottom: 0; }
  .btn-add-story { background: #7c83ff; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; font-size: 0.85em; font-weight: 600; cursor: pointer; transition: background 0.15s; }
  .btn-add-story:hover { background: #5a62d9; }
  .btn-add-story:active { background: #4a51b8; }
  /* Filter/Sort toolbar */
  .controls-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; padding: 12px 14px; background: #16213e; border-radius: 8px; flex-wrap: wrap; }
  .controls-bar .search-input { background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 6px 10px; font-size: 0.82em; font-family: inherit; outline: none; min-width: 180px; transition: border-color 0.15s; }
  .controls-bar .search-input:focus { border-color: #7c83ff; }
  .controls-bar .search-input::placeholder { color: #555; }
  .filter-group { display: flex; gap: 4px; align-items: center; }
  .filter-btn { background: #0f3460; border: 1px solid #1a4080; color: #aaa; padding: 5px 10px; border-radius: 5px; font-size: 0.78em; cursor: pointer; transition: all 0.15s; }
  .filter-btn:hover { border-color: #7c83ff; color: #e0e0e0; }
  .filter-btn.active { background: #7c83ff; border-color: #7c83ff; color: #fff; }
  .sort-select { background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 5px 8px; font-size: 0.78em; font-family: inherit; outline: none; cursor: pointer; }
  .sort-select:focus { border-color: #7c83ff; }
  .controls-label { font-size: 0.7em; color: #666; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .story-count { font-size: 0.78em; color: #888; margin-left: auto; }
  /* Modal styles */
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: flex-start; padding: 40px 20px; overflow-y: auto; }
  .modal { background: #16213e; border: 1px solid #0f3460; border-radius: 10px; width: 100%; max-width: 580px; padding: 24px; position: relative; }
  .modal h2 { font-size: 1.1em; margin-bottom: 16px; color: #e0e0e0; }
  .modal-close { position: absolute; top: 12px; right: 16px; background: none; border: none; color: #888; font-size: 1.3em; cursor: pointer; }
  .modal-close:hover { color: #e0e0e0; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 0.78em; font-weight: 600; color: #aaa; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.03em; }
  .form-group input, .form-group textarea { width: 100%; background: #0f3460; border: 1px solid #1a4080; color: #e0e0e0; border-radius: 5px; padding: 8px 10px; font-size: 0.85em; font-family: inherit; outline: none; transition: border-color 0.15s; }
  .form-group input:focus, .form-group textarea:focus { border-color: #7c83ff; }
  .form-group textarea { resize: vertical; min-height: 60px; }
  .form-group .hint { font-size: 0.7em; color: #666; margin-top: 3px; }
  .form-error { font-size: 0.78em; color: #ff5252; margin-bottom: 12px; display: none; padding: 8px 10px; background: rgba(255,82,82,0.1); border-radius: 5px; }
  .tasks-section { margin-top: 18px; border-top: 1px solid #0f3460; padding-top: 14px; }
  .tasks-section h3 { font-size: 0.85em; color: #aaa; margin-bottom: 10px; }
  .task-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; background: #0f3460; border-radius: 6px; padding: 10px; position: relative; }
  .task-row .task-num { font-size: 0.75em; color: #7c83ff; font-weight: 700; min-width: 20px; padding-top: 8px; }
  .task-row .task-fields { flex: 1; display: flex; flex-direction: column; gap: 6px; }
  .task-row .task-fields input, .task-row .task-fields textarea { width: 100%; background: #1a1a2e; border: 1px solid #16213e; color: #e0e0e0; border-radius: 4px; padding: 6px 8px; font-size: 0.8em; font-family: inherit; outline: none; }
  .task-row .task-fields input:focus, .task-row .task-fields textarea:focus { border-color: #7c83ff; }
  .task-row .task-fields textarea { resize: vertical; min-height: 40px; }
  .task-actions { display: flex; flex-direction: column; gap: 2px; }
  .task-actions button { background: none; border: none; color: #888; cursor: pointer; font-size: 0.85em; padding: 2px 4px; border-radius: 3px; }
  .task-actions button:hover { color: #e0e0e0; background: #1a1a2e; }
  .task-actions .btn-remove:hover { color: #ff5252; }
  .btn-add-task { background: none; border: 1px dashed #0f3460; color: #7c83ff; padding: 8px 14px; border-radius: 6px; font-size: 0.8em; cursor: pointer; width: 100%; margin-top: 6px; }
  .btn-add-task:hover { background: #0f3460; border-color: #7c83ff; }
  .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #0f3460; }
  .btn-cancel { background: none; border: 1px solid #0f3460; color: #aaa; padding: 8px 16px; border-radius: 6px; font-size: 0.85em; cursor: pointer; }
  .btn-cancel:hover { background: #0f3460; color: #e0e0e0; }
  .btn-submit { background: #7c83ff; color: #fff; border: none; padding: 8px 20px; border-radius: 6px; font-size: 0.85em; font-weight: 600; cursor: pointer; }
  .btn-submit:hover { background: #5a62d9; }
  .btn-submit:disabled { background: #3a3f6e; cursor: not-allowed; }
</style></head><body>
<div class="toolbar">
  <h1>🍕 pi-pizza-team board <span class="refresh" id="refresh"></span></h1>
  <button class="btn-add-story" id="btn-add-story" onclick="openAddStoryModal()">+ Add Story</button>
</div>
<div class="team-bar" id="team"></div>
<div class="controls-bar">
  <input type="text" class="search-input" id="search-input" placeholder="🔍 Search stories..." oninput="applyFilters()" />
  <span class="controls-label">Filter:</span>
  <div class="filter-group">
    <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
    <button class="filter-btn" data-filter="open" onclick="setFilter('open')">Open</button>
    <button class="filter-btn" data-filter="done" onclick="setFilter('done')">Done</button>
    <button class="filter-btn" data-filter="ready" onclick="setFilter('ready')">Ready</button>
    <button class="filter-btn" data-filter="blocked" onclick="setFilter('blocked')">Blocked</button>
  </div>
  <span class="controls-label">Sort:</span>
  <select class="sort-select" id="sort-select" onchange="applyFilters()">
    <option value="default">Default</option>
    <option value="name-asc">Name (A-Z)</option>
    <option value="name-desc">Name (Z-A)</option>
    <option value="progress">Progress</option>
    <option value="most-tasks">Most tasks</option>
    <option value="fewest-tasks">Fewest tasks</option>
  </select>
  <span class="story-count" id="story-count"></span>
</div>
<div id="board"></div>

<!-- Add Story Modal -->
<div class="modal-overlay" id="add-story-modal">
  <div class="modal" role="dialog" aria-labelledby="modal-title" aria-modal="true">
    <button class="modal-close" onclick="closeAddStoryModal()" aria-label="Close">&times;</button>
    <h2 id="modal-title">Add Story</h2>
    <div class="form-error" id="form-error"></div>
    <div class="form-group">
      <label for="story-id">ID *</label>
      <input type="text" id="story-id" placeholder="e.g. auth-login" />
    </div>
    <div class="form-group">
      <label for="story-title">Title *</label>
      <input type="text" id="story-title" placeholder="e.g. Implement login flow" />
    </div>
    <div class="form-group">
      <label for="story-desc">Description *</label>
      <textarea id="story-desc" placeholder="What this story delivers..."></textarea>
    </div>
    <div class="form-group">
      <label for="story-depends">Depends On</label>
      <input type="text" id="story-depends" placeholder="Comma-separated story IDs (optional)" />
      <div class="hint">e.g. setup-db, auth-core</div>
    </div>
    <div class="form-group">
      <label for="story-dir">Working Directory</label>
      <input type="text" id="story-dir" placeholder="Optional, e.g. ~/Workspace/my-project" />
      <div class="hint">Hint for teammates about where to work</div>
    </div>
    <div class="tasks-section">
      <h3>Tasks (optional)</h3>
      <div id="task-list"></div>
      <button class="btn-add-task" onclick="addTaskRow()">+ Add Task</button>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeAddStoryModal()">Cancel</button>
      <button class="btn-submit" id="btn-submit" onclick="submitStory()">Create Story</button>
    </div>
  </div>
</div>

<!-- Task Modal (create/edit) -->
<div class="modal-overlay" id="task-modal">
  <div class="modal" role="dialog" aria-modal="true">
    <button class="modal-close" onclick="closeTaskModal()" aria-label="Close">&times;</button>
    <h2 id="task-modal-title">Add Task</h2>
    <div class="form-error" id="task-form-error"></div>
    <div class="form-group">
      <label for="task-title-input">Title *</label>
      <input type="text" id="task-title-input" placeholder="Task title" />
    </div>
    <div class="form-group">
      <label for="task-desc-input">Description *</label>
      <textarea id="task-desc-input" rows="6" placeholder="Full task description..."></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeTaskModal()">Cancel</button>
      <button class="btn-submit" id="task-modal-submit" onclick="submitTaskModal()">Create</button>
    </div>
  </div>
</div>

<!-- Task Detail Modal -->
<div class="modal-overlay" id="task-detail-modal">
  <div class="modal" role="dialog" aria-modal="true">
    <button class="modal-close" onclick="closeTaskDetailModal()" aria-label="Close">&times;</button>
    <h2 id="task-detail-title"></h2>
    <div style="font-size:0.78em;color:#888;margin-bottom:12px;" id="task-detail-meta"></div>
    <div style="white-space:pre-wrap;font-size:0.85em;line-height:1.5;color:#ccc;background:#0f3460;padding:14px;border-radius:6px;max-height:400px;overflow-y:auto;" id="task-detail-desc"></div>
    <div class="modal-footer">
      <button class="btn-cancel" onclick="closeTaskDetailModal()">Close</button>
    </div>
  </div>
</div>
<script>
const POLL_MS = 3000;
const COLUMN_ORDER = ['todo', 'in_progress', 'needs_input', 'review', 'done'];

// --- State ---
let allStories = [];
let workflowTransitions = {};
let taskDataMap = {}; // id -> task object for modal access
let currentFilter = localStorage.getItem('board-filter') || 'all';
let currentSort = localStorage.getItem('board-sort') || 'default';
let currentSearch = localStorage.getItem('board-search') || '';

// Task modal state
let taskModalMode = 'create'; // 'create' or 'edit'
let taskModalStoryId = null;
let taskModalTaskId = null;

// Restore persisted state on load
(function initControls() {
  document.getElementById('search-input').value = currentSearch;
  document.getElementById('sort-select').value = currentSort;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === currentFilter);
  });
})();

function setFilter(filter) {
  currentFilter = filter;
  localStorage.setItem('board-filter', filter);
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  applyFilters();
}

function applyFilters() {
  currentSearch = document.getElementById('search-input').value;
  currentSort = document.getElementById('sort-select').value;
  localStorage.setItem('board-search', currentSearch);
  localStorage.setItem('board-sort', currentSort);
  renderBoard(allStories);
}

function filterAndSortStories(stories) {
  let filtered = stories;
  const search = currentSearch.trim().toLowerCase();
  if (search) {
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(search) ||
      s.description.toLowerCase().includes(search)
    );
  }
  if (currentFilter === 'open') filtered = filtered.filter(s => s.status === 'open');
  else if (currentFilter === 'done') filtered = filtered.filter(s => s.status === 'done');
  else if (currentFilter === 'ready') filtered = filtered.filter(s => s.ready && s.status !== 'done');
  else if (currentFilter === 'blocked') filtered = filtered.filter(s => !s.ready && s.status !== 'done');

  if (currentSort === 'name-asc') filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  else if (currentSort === 'name-desc') filtered = [...filtered].sort((a, b) => b.title.localeCompare(a.title));
  else if (currentSort === 'progress') {
    filtered = [...filtered].sort((a, b) => {
      const pa = a.tasks.length ? a.tasks.filter(t => t.status === 'done').length / a.tasks.length : 0;
      const pb = b.tasks.length ? b.tasks.filter(t => t.status === 'done').length / b.tasks.length : 0;
      return pb - pa;
    });
  } else if (currentSort === 'most-tasks') filtered = [...filtered].sort((a, b) => b.tasks.length - a.tasks.length);
  else if (currentSort === 'fewest-tasks') filtered = [...filtered].sort((a, b) => a.tasks.length - b.tasks.length);
  return filtered;
}

function updateStoryCount(shown, total) {
  const el = document.getElementById('story-count');
  if (shown === total) el.textContent = total + ' ' + (total === 1 ? 'story' : 'stories');
  else el.textContent = 'Showing ' + shown + ' of ' + total + ' stories';
}

// --- Add Story Modal ---
function openAddStoryModal() {
  const modal = document.getElementById('add-story-modal');
  modal.style.display = 'flex';
  document.getElementById('story-id').value = '';
  document.getElementById('story-title').value = '';
  document.getElementById('story-desc').value = '';
  document.getElementById('story-depends').value = '';
  document.getElementById('story-dir').value = '';
  document.getElementById('task-list').innerHTML = '';
  hideError();
  document.getElementById('btn-submit').disabled = false;
  document.getElementById('btn-submit').textContent = 'Create Story';
  setTimeout(() => document.getElementById('story-id').focus(), 50);
}

function closeAddStoryModal() {
  document.getElementById('add-story-modal').style.display = 'none';
}

function hideError() {
  const el = document.getElementById('form-error');
  el.style.display = 'none';
  el.textContent = '';
}

function showError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function renumberTasks() {
  const rows = document.querySelectorAll('#task-list .task-row');
  rows.forEach((row, i) => { row.querySelector('.task-num').textContent = (i + 1) + '.'; });
}

function addTaskRow() {
  const list = document.getElementById('task-list');
  const idx = list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'task-row';
  row.innerHTML = '<div class="task-num">' + idx + '.</div>'
    + '<div class="task-fields">'
    + '<input type="text" placeholder="Task title" class="task-title-input" />'
    + '<textarea placeholder="Task description" class="task-desc-input"></textarea>'
    + '</div>'
    + '<div class="task-actions">'
    + '<button onclick="moveTask(this,-1)" title="Move up">&#9650;</button>'
    + '<button onclick="moveTask(this,1)" title="Move down">&#9660;</button>'
    + '<button class="btn-remove" onclick="removeTask(this)" title="Remove">&times;</button>'
    + '</div>';
  list.appendChild(row);
  row.querySelector('.task-title-input').focus();
}

function removeTask(btn) { btn.closest('.task-row').remove(); renumberTasks(); }

function moveTask(btn, dir) {
  const row = btn.closest('.task-row');
  const list = document.getElementById('task-list');
  const rows = Array.from(list.children);
  const idx = rows.indexOf(row);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= rows.length) return;
  if (dir === -1) list.insertBefore(row, rows[newIdx]);
  else list.insertBefore(row, rows[newIdx].nextSibling);
  renumberTasks();
}

async function submitStory() {
  hideError();
  const id = document.getElementById('story-id').value.trim();
  const title = document.getElementById('story-title').value.trim();
  const description = document.getElementById('story-desc').value.trim();
  const dependsRaw = document.getElementById('story-depends').value.trim();
  const dir = document.getElementById('story-dir').value.trim();
  if (!id) { showError('ID is required.'); return; }
  if (!title) { showError('Title is required.'); return; }
  if (!description) { showError('Description is required.'); return; }
  const dependsOn = dependsRaw ? dependsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const taskRows = document.querySelectorAll('#task-list .task-row');
  const tasks = [];
  for (const row of taskRows) {
    const t = row.querySelector('.task-title-input').value.trim();
    const d = row.querySelector('.task-desc-input').value.trim();
    if (t) tasks.push({ title: t, description: d || t });
  }
  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.textContent = 'Creating...';
  try {
    const res = await fetch('/api/stories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, description, dependsOn, dir: dir || undefined, tasks: tasks.length ? tasks : undefined })
    });
    const data = await res.json();
    if (!res.ok || !data.success) { showError(data.error || 'Failed'); btn.disabled = false; btn.textContent = 'Create Story'; return; }
    closeAddStoryModal(); refresh();
  } catch (e) { showError('Network error: ' + e.message); btn.disabled = false; btn.textContent = 'Create Story'; }
}

// --- Task Modal (create/edit) ---
function openCreateTaskModal(storyId) {
  taskModalMode = 'create';
  taskModalStoryId = storyId;
  taskModalTaskId = null;
  document.getElementById('task-modal-title').textContent = 'Add Task';
  document.getElementById('task-title-input').value = '';
  document.getElementById('task-desc-input').value = '';
  document.getElementById('task-modal-submit').textContent = 'Create';
  document.getElementById('task-form-error').style.display = 'none';
  document.getElementById('task-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('task-title-input').focus(), 50);
}

function openEditTaskModal(taskId) {
  const task = taskDataMap[taskId];
  if (!task) return;
  taskModalMode = 'edit';
  taskModalStoryId = null;
  taskModalTaskId = taskId;
  document.getElementById('task-modal-title').textContent = 'Edit Task';
  document.getElementById('task-title-input').value = task.title;
  document.getElementById('task-desc-input').value = task.description || '';
  document.getElementById('task-modal-submit').textContent = 'Save';
  document.getElementById('task-form-error').style.display = 'none';
  document.getElementById('task-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('task-title-input').focus(), 50);
}

function closeTaskModal() {
  document.getElementById('task-modal').style.display = 'none';
}

async function submitTaskModal() {
  const errEl = document.getElementById('task-form-error');
  errEl.style.display = 'none';
  const title = document.getElementById('task-title-input').value.trim();
  const description = document.getElementById('task-desc-input').value.trim();
  if (!title) { errEl.textContent = 'Title is required'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('task-modal-submit');
  btn.disabled = true;

  try {
    let res;
    if (taskModalMode === 'create') {
      if (!description) { errEl.textContent = 'Description is required'; errEl.style.display = 'block'; btn.disabled = false; return; }
      res = await fetch('/api/stories/' + encodeURIComponent(taskModalStoryId) + '/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description })
      });
    } else {
      res = await fetch('/api/tasks/' + encodeURIComponent(taskModalTaskId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: description || undefined })
      });
    }
    const data = await res.json();
    if (!res.ok || !data.success) { errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; btn.disabled = false; return; }
    closeTaskModal(); refresh();
  } catch (e) { errEl.textContent = 'Network error: ' + e.message; errEl.style.display = 'block'; }
  btn.disabled = false;
}

// --- Task Detail Modal ---
function openTaskDetailModal(taskId) {
  const task = taskDataMap[taskId];
  if (!task) return;
  document.getElementById('task-detail-title').textContent = task.title;
  document.getElementById('task-detail-meta').textContent = '#' + task.seq + ' — ' + task.status.replace(/_/g, ' ') + (task.assignee ? ' (assigned to ' + task.assignee + ')' : '');
  document.getElementById('task-detail-desc').textContent = task.description || '(no description)';
  document.getElementById('task-detail-modal').style.display = 'flex';
}

function closeTaskDetailModal() {
  document.getElementById('task-detail-modal').style.display = 'none';
}

// --- Delete Task ---
async function deleteTaskConfirm(taskId, title) {
  if (!confirm('Delete task "' + title + '"? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(taskId), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) { alert(data.error || 'Delete failed'); return; }
    refresh();
  } catch (e) { alert('Network error: ' + e.message); }
}

// --- Move Task ---
async function moveTaskStatus(taskId, newStatus) {
  try {
    const res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (!res.ok || !data.success) { alert(data.error || 'Move failed'); return; }
    refresh();
  } catch (e) { alert('Network error: ' + e.message); }
}

function getLeadTransitions(currentStatus) {
  const transitions = workflowTransitions[currentStatus] || {};
  return Object.entries(transitions)
    .filter(([_, perm]) => perm === 'lead' || perm === 'any')
    .map(([state]) => state);
}

// --- Keyboard / modal handling ---
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if (document.getElementById('task-detail-modal').style.display === 'flex') { closeTaskDetailModal(); return; }
    if (document.getElementById('task-modal').style.display === 'flex') { closeTaskModal(); return; }
    if (document.getElementById('add-story-modal').style.display === 'flex') { closeAddStoryModal(); return; }
  }
});

document.getElementById('add-story-modal').addEventListener('click', function(e) { if (e.target === this) closeAddStoryModal(); });
document.getElementById('task-modal').addEventListener('click', function(e) { if (e.target === this) closeTaskModal(); });
document.getElementById('task-detail-modal').addEventListener('click', function(e) { if (e.target === this) closeTaskDetailModal(); });

// --- Data fetching ---
async function refresh() {
  try {
    const [storiesRes, teamRes, statusRes] = await Promise.all([
      fetch('/api/stories').then(r => r.json()),
      fetch('/api/team').then(r => r.json()),
      fetch('/api/status').then(r => r.json())
    ]);
    renderTeam(teamRes.members);
    allStories = storiesRes.stories;
    if (statusRes.workflow) workflowTransitions = statusRes.workflow.transitions || {};
    renderBoard(allStories);
    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh').textContent = 'error: ' + e.message;
  }
}

function renderTeam(members) {
  const el = document.getElementById('team');
  if (members.length === 0) { el.innerHTML = '<span class="member member-idle">No teammates yet</span>'; return; }
  el.innerHTML = members.map(m => {
    const cls = m.status === 'working' ? 'member-working' : 'member-idle';
    const icon = m.status === 'working' ? '\ud83d\udd28' : '\u2615';
    const task = m.currentTask ? ' \u2192 ' + m.currentTask : '';
    return '<span class="member ' + cls + '">' + icon + ' ' + m.name + task + '</span>';
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderBoard(stories) {
  const el = document.getElementById('board');
  const filtered = filterAndSortStories(stories);
  updateStoryCount(filtered.length, stories.length);
  taskDataMap = {};

  const allStates = new Set(COLUMN_ORDER);
  for (const story of filtered) {
    for (const task of story.tasks) allStates.add(task.status);
  }
  const columns = [...allStates].sort((a, b) => {
    const ai = COLUMN_ORDER.indexOf(a), bi = COLUMN_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  el.innerHTML = filtered.map(story => {
    const blocked = !story.ready && story.status !== 'done';
    const doneCount = story.tasks.filter(t => t.status === 'done').length;
    const blockedClass = blocked ? ' swimlane-blocked' : '';
    const blockedLabel = blocked ? ' (blocked: ' + story.dependsOn.join(', ') + ')' : '';

    const columnsHtml = columns.map(state => {
      const tasks = story.tasks.filter(t => t.status === state);
      const cards = tasks.map(t => {
        taskDataMap[t.id] = t;
        const assignee = t.assignee ? '<div class="card-assignee">\u2192 ' + escHtml(t.assignee) + '</div>' : '';
        const msg = t.hasMessages ? '<div class="card-msg">\ud83d\udcec messages</div>' : '';
        const desc = t.description ? '<div class="card-desc">' + escHtml(t.description.slice(0, 120)) + (t.description.length > 120 ? '...' : '') + '</div>' : '';

        // Move dropdown
        const validMoves = getLeadTransitions(t.status);
        let moveHtml = '';
        if (validMoves.length > 0) {
          moveHtml = '<div class="card-move" onclick="event.stopPropagation()"><select onchange="moveTaskStatus(\'' + escHtml(t.id) + '\', this.value); this.value=\'\';">' 
            + '<option value="">Move to...</option>'
            + validMoves.map(s => '<option value="' + s + '">' + s.replace(/_/g, ' ') + '</option>').join('')
            + '</select></div>';
        }

        // Action buttons
        const actions = '<div class="card-actions">'
          + '<button onclick="event.stopPropagation(); openEditTaskModal(\'' + escHtml(t.id) + '\');" title="Edit">\u270f\ufe0f</button>'
          + '<button class="btn-del" onclick="event.stopPropagation(); deleteTaskConfirm(\'' + escHtml(t.id) + '\', \'' + escHtml(t.title).replace(/'/g, "\\'") + '\');" title="Delete">\ud83d\uddd1\ufe0f</button>'
          + '</div>';

        return '<div class="card" onclick="openTaskDetailModal(\'' + escHtml(t.id) + '\')">' 
          + actions
          + '<div class="card-title">' + escHtml(t.title) + '</div>'
          + '<div class="card-meta">#' + t.seq + '</div>'
          + desc + assignee + msg + moveHtml
          + '</div>';
      }).join('');
      const label = state.replace(/_/g, ' ');
      const content = cards || '<div class="empty-col"></div>';
      return '<div class="column"><h2>' + label + '</h2>' + content + '</div>';
    }).join('');

    const addBtn = '<button class="btn-add-task-inline" onclick="openCreateTaskModal(\'' + escHtml(story.id) + '\')">+ Task</button>';

    return '<div class="swimlane' + blockedClass + '">'
      + '<div class="swimlane-header">'
      + '<span class="swimlane-title">' + escHtml(story.title) + (story.dir ? ' <span style="font-size:0.75em;color:#888;font-weight:400;">\ud83d\udcc2 ' + escHtml(story.dir) + '</span>' : '') + '</span>'
      + '<span class="swimlane-meta">' + addBtn + ' <span class="progress">' + doneCount + '/' + story.tasks.length + '</span>' + blockedLabel + '</span>'
      + '</div>'
      + '<div class="board">' + columnsHtml + '</div>'
      + '</div>';
  }).join('');
}

refresh();
setInterval(refresh, POLL_MS);
</script>
</body></html>`;

export { BOARD_HTML };
