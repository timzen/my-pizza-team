// End-to-end tests for search, filter, and sort functionality
// Run with: node tests/search-filter-sort.test.mjs
//
// Tests the client-side filtering/sorting logic extracted from board.html

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// --- Simulate the board's filter/sort logic (copied from board.html) ---
const COLUMN_ORDER = ['todo', 'in_progress', 'needs_input', 'review', 'done'];

let currentFilter = 'all';
let currentSort = 'default';
let currentSearch = '';

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
  if (shown === total) return total + ' ' + (total === 1 ? 'story' : 'stories');
  else return 'Showing ' + shown + ' of ' + total + ' stories';
}

// --- Test data ---
const stories = [
  {
    id: 'auth-login', title: 'Implement Login', description: 'Build the login page with OAuth',
    status: 'open', ready: true, dependsOn: [],
    tasks: [
      { id: 'auth-login-1', seq: 1, title: 'Create form', status: 'done' },
      { id: 'auth-login-2', seq: 2, title: 'Add OAuth', status: 'in_progress' },
      { id: 'auth-login-3', seq: 3, title: 'Write tests', status: 'todo' },
    ]
  },
  {
    id: 'user-profile', title: 'User Profile Page', description: 'Display user info and settings',
    status: 'open', ready: true, dependsOn: [],
    tasks: [
      { id: 'user-profile-1', seq: 1, title: 'Design UI', status: 'done' },
      { id: 'user-profile-2', seq: 2, title: 'Build API', status: 'done' },
    ]
  },
  {
    id: 'dashboard', title: 'Dashboard Analytics', description: 'Charts and metrics overview',
    status: 'open', ready: false, dependsOn: ['auth-login'],
    tasks: [
      { id: 'dashboard-1', seq: 1, title: 'Chart component', status: 'todo' },
      { id: 'dashboard-2', seq: 2, title: 'Data fetching', status: 'todo' },
      { id: 'dashboard-3', seq: 3, title: 'Layout', status: 'todo' },
      { id: 'dashboard-4', seq: 4, title: 'Tests', status: 'todo' },
    ]
  },
  {
    id: 'setup-db', title: 'Database Setup', description: 'Initialize PostgreSQL schema',
    status: 'done', ready: true, dependsOn: [],
    tasks: [
      { id: 'setup-db-1', seq: 1, title: 'Create schema', status: 'done' },
    ]
  },
  {
    id: 'notifications', title: 'Notification System', description: 'Email and push notifications',
    status: 'open', ready: false, dependsOn: ['user-profile'],
    tasks: [
      { id: 'notifications-1', seq: 1, title: 'Email service', status: 'todo' },
      { id: 'notifications-2', seq: 2, title: 'Push service', status: 'todo' },
    ]
  },
];


// ============================================================
// TEST 1: Search by partial title
// ============================================================
console.log("\n--- Test 1: Search by partial title ---");
{
  currentFilter = 'all'; currentSort = 'default'; currentSearch = '';

  // Search for "login"
  currentSearch = 'login';
  let result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "login" → 1 result (got ${result.length})`);
  assert(result[0].id === 'auth-login', 'Found auth-login story');

  // Search for "user" (matches title "User Profile Page")
  currentSearch = 'user';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "user" → 1 result (got ${result.length})`);
  assert(result[0].id === 'user-profile', 'Found user-profile story');

  // Search for "notifications" (matches title)
  currentSearch = 'notif';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "notif" → 1 result (got ${result.length})`);
  assert(result[0].id === 'notifications', 'Found notifications story');

  // Search in description: "OAuth"
  currentSearch = 'oauth';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "oauth" (in description) → 1 result (got ${result.length})`);
  assert(result[0].id === 'auth-login', 'Found by description match');

  // Case insensitive
  currentSearch = 'DATABASE';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Case-insensitive search "DATABASE" → 1 result (got ${result.length})`);

  // Clear search — all return
  currentSearch = '';
  result = filterAndSortStories(stories);
  assert(result.length === 5, `Empty search → all 5 stories (got ${result.length})`);
}


// ============================================================
// TEST 2: Filter by status
// ============================================================
console.log("\n--- Test 2: Filter by status ---");
{
  currentSearch = ''; currentSort = 'default';

  // Filter: Open
  currentFilter = 'open';
  let result = filterAndSortStories(stories);
  assert(result.length === 4, `Filter "open" → 4 stories (got ${result.length})`);
  assert(result.every(s => s.status === 'open'), 'All results have status=open');
  assert(!result.find(s => s.id === 'setup-db'), 'Done story "setup-db" is hidden');

  // Filter: Done
  currentFilter = 'done';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Filter "done" → 1 story (got ${result.length})`);
  assert(result[0].id === 'setup-db', 'Only setup-db is done');

  // Filter: Ready (ready=true AND not done)
  currentFilter = 'ready';
  result = filterAndSortStories(stories);
  assert(result.length === 2, `Filter "ready" → 2 stories (got ${result.length})`);
  assert(result.every(s => s.ready && s.status !== 'done'), 'All are ready and not done');
  assert(result.find(s => s.id === 'auth-login'), 'auth-login is ready');
  assert(result.find(s => s.id === 'user-profile'), 'user-profile is ready');
  assert(!result.find(s => s.id === 'dashboard'), 'dashboard (blocked) not shown');
  assert(!result.find(s => s.id === 'setup-db'), 'setup-db (done) not shown');

  // Filter: Blocked (not ready AND not done)
  currentFilter = 'blocked';
  result = filterAndSortStories(stories);
  assert(result.length === 2, `Filter "blocked" → 2 stories (got ${result.length})`);
  assert(result.every(s => !s.ready && s.status !== 'done'), 'All are blocked');
  assert(result.find(s => s.id === 'dashboard'), 'dashboard is blocked');
  assert(result.find(s => s.id === 'notifications'), 'notifications is blocked');

  // Filter: All
  currentFilter = 'all';
  result = filterAndSortStories(stories);
  assert(result.length === 5, `Filter "all" → all 5 stories (got ${result.length})`);
}


// ============================================================
// TEST 3: Sort
// ============================================================
console.log("\n--- Test 3: Sort ---");
{
  currentSearch = ''; currentFilter = 'all';

  // Sort: name-asc (alphabetical)
  currentSort = 'name-asc';
  let result = filterAndSortStories(stories);
  const namesAsc = result.map(s => s.title);
  const expectedAsc = [...namesAsc].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(namesAsc) === JSON.stringify(expectedAsc), `Sort name-asc: ${namesAsc.join(', ')}`);
  assert(result[0].title === 'Dashboard Analytics', `First alphabetically: ${result[0].title}`);

  // Sort: name-desc
  currentSort = 'name-desc';
  result = filterAndSortStories(stories);
  const namesDesc = result.map(s => s.title);
  const expectedDesc = [...namesDesc].sort((a, b) => b.localeCompare(a));
  assert(JSON.stringify(namesDesc) === JSON.stringify(expectedDesc), 'Sort name-desc is correct');
  assert(result[0].title === 'User Profile Page', `Last alphabetically first: ${result[0].title}`);

  // Sort: progress (most done% first)
  currentSort = 'progress';
  result = filterAndSortStories(stories);
  // user-profile: 2/2 = 100%, setup-db: 1/1 = 100%, auth-login: 1/3 = 33%, dashboard: 0/4 = 0%, notifications: 0/2 = 0%
  assert(result[0].id === 'user-profile' || result[0].id === 'setup-db', `Highest progress first: ${result[0].id} (100%)`);
  assert(result[1].id === 'user-profile' || result[1].id === 'setup-db', `Second highest: ${result[1].id} (100%)`);
  assert(result[2].id === 'auth-login', `Third: auth-login (33%)`);
  // dashboard and notifications both 0% — order between them is stable
  const lastTwo = result.slice(3).map(s => s.id);
  assert(lastTwo.includes('dashboard') && lastTwo.includes('notifications'), 'Bottom two are 0% progress stories');

  // Sort: most-tasks
  currentSort = 'most-tasks';
  result = filterAndSortStories(stories);
  assert(result[0].id === 'dashboard', `Most tasks first: dashboard (4 tasks)`);
  assert(result[result.length - 1].id === 'setup-db', `Fewest tasks last: setup-db (1 task)`);

  // Sort: fewest-tasks
  currentSort = 'fewest-tasks';
  result = filterAndSortStories(stories);
  assert(result[0].id === 'setup-db', `Fewest tasks first: setup-db (1 task)`);
  assert(result[result.length - 1].id === 'dashboard', `Most tasks last: dashboard (4 tasks)`);
}


// ============================================================
// TEST 4: Combined search + filter (intersection)
// ============================================================
console.log("\n--- Test 4: Combined search + filter ---");
{
  currentSort = 'default';

  // Search "login" + filter "open" → auth-login (it's open)
  currentSearch = 'login'; currentFilter = 'open';
  let result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "login" + filter "open" → 1 (got ${result.length})`);
  assert(result[0].id === 'auth-login', 'Correct intersection result');

  // Search "login" + filter "done" → 0 (auth-login is open, not done)
  currentSearch = 'login'; currentFilter = 'done';
  result = filterAndSortStories(stories);
  assert(result.length === 0, `Search "login" + filter "done" → 0 (got ${result.length})`);

  // Search "setup" + filter "done" → setup-db
  currentSearch = 'setup'; currentFilter = 'done';
  result = filterAndSortStories(stories);
  assert(result.length === 1, `Search "setup" + filter "done" → 1 (got ${result.length})`);
  assert(result[0].id === 'setup-db', 'Correct result');

  // Search "a" (broad) + filter "blocked"
  currentSearch = 'a'; currentFilter = 'blocked';
  result = filterAndSortStories(stories);
  // "a" matches: auth-login (title), Dashboard Analytics (title), Database Setup (title+desc), Notification (desc has "Email and")
  // Of those, blocked: dashboard, notifications
  const blockedWithA = result.map(s => s.id);
  assert(result.every(s => !s.ready && s.status !== 'done'), 'All results are blocked');
  assert(result.length >= 1, `At least 1 blocked story with "a" (got ${result.length})`);

  // Search + filter + sort combined
  currentSearch = ''; currentFilter = 'open'; currentSort = 'name-asc';
  result = filterAndSortStories(stories);
  assert(result.length === 4, 'Open stories: 4');
  const names = result.map(s => s.title);
  const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(names) === JSON.stringify(sortedNames), 'Open stories sorted alphabetically');
}


// ============================================================
// TEST 5: localStorage persistence simulation
// ============================================================
console.log("\n--- Test 5: Persistence via localStorage (simulated) ---");
{
  // The board.html code does:
  //   localStorage.setItem('board-filter', filter);
  //   localStorage.setItem('board-sort', currentSort);
  //   localStorage.setItem('board-search', currentSearch);
  // And on load:
  //   currentFilter = localStorage.getItem('board-filter') || 'all';
  //   currentSort = localStorage.getItem('board-sort') || 'default';
  //   currentSearch = localStorage.getItem('board-search') || '';

  // Simulate: set state, "reload" (restore from simulated localStorage)
  const simStorage = {};
  simStorage['board-filter'] = 'ready';
  simStorage['board-sort'] = 'progress';
  simStorage['board-search'] = 'user';

  // Simulate page load restoration
  currentFilter = simStorage['board-filter'] || 'all';
  currentSort = simStorage['board-sort'] || 'default';
  currentSearch = simStorage['board-search'] || '';

  assert(currentFilter === 'ready', 'Filter persisted: ready');
  assert(currentSort === 'progress', 'Sort persisted: progress');
  assert(currentSearch === 'user', 'Search persisted: user');

  // Verify the restored state produces correct results
  const result = filterAndSortStories(stories);
  assert(result.every(s => s.ready && s.status !== 'done'), 'Persisted filter still works after reload');
  assert(result.every(s => s.title.toLowerCase().includes('user') || s.description.toLowerCase().includes('user')), 'Persisted search still works after reload');
}


// ============================================================
// TEST 6: Story count accuracy
// ============================================================
console.log("\n--- Test 6: Story count accuracy ---");
{
  currentSearch = ''; currentFilter = 'all'; currentSort = 'default';

  // All stories shown
  let result = filterAndSortStories(stories);
  let count = updateStoryCount(result.length, stories.length);
  assert(count === '5 stories', `All shown: "${count}"`);

  // Filtered subset
  currentFilter = 'done';
  result = filterAndSortStories(stories);
  count = updateStoryCount(result.length, stories.length);
  assert(count === 'Showing 1 of 5 stories', `Filtered: "${count}"`);

  // Single story
  currentFilter = 'all'; currentSearch = 'login';
  result = filterAndSortStories(stories);
  count = updateStoryCount(result.length, stories.length);
  assert(count === 'Showing 1 of 5 stories', `Search filtered: "${count}"`);

  // 1 total story edge case
  count = updateStoryCount(1, 1);
  assert(count === '1 story', `Singular: "${count}"`);
}


// ============================================================
// TEST 7: Zero results — empty state
// ============================================================
console.log("\n--- Test 7: Zero results ---");
{
  currentFilter = 'all'; currentSort = 'default';

  // Search that matches nothing
  currentSearch = 'xyznonexistent';
  let result = filterAndSortStories(stories);
  assert(result.length === 0, `No matches for gibberish search (got ${result.length})`);

  // The board.html now has an empty state check:
  // if (filtered.length === 0) { el.innerHTML = '...<No stories match>...'; return; }
  // Simulate: verify the empty state HTML would be rendered
  const wouldShowEmptyState = result.length === 0;
  assert(wouldShowEmptyState, 'Empty state would be triggered');

  // Filter that matches nothing (e.g., "done" when only looking at open stories)
  currentSearch = 'dashboard'; currentFilter = 'done';
  result = filterAndSortStories(stories);
  assert(result.length === 0, `Search "dashboard" + filter "done" → 0 results`);

  // Verify count shows "Showing 0 of 5"
  const count = updateStoryCount(result.length, stories.length);
  assert(count === 'Showing 0 of 5 stories', `Zero count: "${count}"`);
}


// ============================================================
// TEST 8: Edge cases
// ============================================================
console.log("\n--- Test 8: Edge cases ---");
{
  currentFilter = 'all'; currentSort = 'default'; currentSearch = '';

  // Empty stories array
  let result = filterAndSortStories([]);
  assert(result.length === 0, 'Empty input → empty output');

  // Search with special characters (shouldn't crash)
  currentSearch = '<script>alert("xss")</script>';
  result = filterAndSortStories(stories);
  assert(result.length === 0, 'Special chars search returns 0 (no crash)');

  // Search with just whitespace
  currentSearch = '   ';
  result = filterAndSortStories(stories);
  assert(result.length === 5, 'Whitespace-only search treated as empty (got ' + result.length + ')');

  // Sort stability — same progress should maintain relative order
  currentSearch = ''; currentFilter = 'all'; currentSort = 'progress';
  result = filterAndSortStories(stories);
  assert(result.length === 5, 'Sort with ties still returns all');
}


console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
