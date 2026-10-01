const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'ci_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }

let allCheckins = [];
let allGroups = [];
let refreshTimer = null;

// ---------- 初始化 ----------
function init() {
  const token = getToken();
  if (token) {
    // 验证 token 是否有效
    loadAll().then(ok => {
      if (ok) showAdmin(); else showLogin();
    });
  } else {
    showLogin();
  }

  $('btn-login').onclick = doLogin;
  $('login-password').onkeydown = (e) => e.key === 'Enter' && doLogin();
  $('btn-logout').onclick = logout;
  $('btn-export').onclick = doExport;

  ['filter-group', 'filter-user', 'filter-keyword', 'filter-person'].forEach(id => {
    $(id).addEventListener('input', () => { renderCheckins(); renderPersons(); });
  });
}

function showLogin() {
  $('login-screen').classList.remove('hidden');
  $('admin-content').classList.add('hidden');
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function showAdmin() {
  $('login-screen').classList.add('hidden');
  $('admin-content').classList.remove('hidden');
  if (!refreshTimer) refreshTimer = setInterval(loadAll, 30000);
}

async function doLogin() {
  const password = $('login-password').value;
  $('login-error').textContent = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) { $('login-error').textContent = data.error || '登录失败'; return; }
    localStorage.setItem(TOKEN_KEY, data.token);
    showAdmin();
    await loadAll();
  } catch (e) {
    $('login-error').textContent = '网络错误';
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

// ---------- 数据加载 ----------
async function loadAll() {
  try {
    const [gRes, cRes] = await Promise.all([
      fetch('/api/admin/groups', { headers: authHeaders() }),
      fetch('/api/admin/checkins', { headers: authHeaders() }),
    ]);
    if (gRes.status === 401 || cRes.status === 401) { logout(); return false; }
    allGroups = await gRes.json();
    allCheckins = await cRes.json();
    renderStats();
    renderGroups();
    renderPersons();
    renderCheckins();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function renderStats() {
  const totalCheckins = allCheckins.length;
  const totalGroups = allGroups.length;
  const uniqueUsers = new Set(allCheckins.map(c => c.user_name)).size;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayCount = allCheckins.filter(c => c.created_at >= today.getTime()).length;

  $('stats').innerHTML = [
    { num: totalGroups, label: '群组总数' },
    { num: totalCheckins, label: '打卡总数' },
    { num: uniqueUsers, label: '参与人数' },
    { num: todayCount, label: '今日打卡' },
  ].map(s => `<div class="stat-card"><div class="stat-num">${s.num}</div><div class="stat-label">${s.label}</div></div>`).join('');
}

function renderGroups() {
  const body = $('groups-body');
  if (!allGroups.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">暂无群组</td></tr>'; return; }
  body.innerHTML = allGroups.map(g => {
    const range = g.radius > 0 && g.center_lat != null
      ? `${g.center_lat.toFixed(4)}, ${g.center_lng.toFixed(4)} · ${g.radius}m`
      : '<span style="color:var(--muted)">不限制</span>';
    return `
      <tr>
        <td><b>${esc(g.name)}</b></td>
        <td><span class="tag">${esc(g.code)}</span></td>
        <td>${range}</td>
        <td>${g.checkin_count}</td>
        <td>${fmtTime(g.created_at)}</td>
      </tr>`;
  }).join('');
}

function renderPersons() {
  const fp = $('filter-person')?.value.trim().toLowerCase() || '';
  const map = new Map();
  allCheckins.forEach(c => {
    const key = c.user_name;
    if (!map.has(key)) {
      map.set(key, { name: key, count: 0, groups: new Set(), first: c.created_at, last: c.created_at });
    }
    const p = map.get(key);
    p.count++;
    p.groups.add(c.group_name);
    if (c.created_at < p.first) p.first = c.created_at;
    if (c.created_at > p.last) p.last = c.created_at;
  });
  let persons = Array.from(map.values()).sort((a, b) => b.count - a.count);
  if (fp) persons = persons.filter(p => p.name.toLowerCase().includes(fp));

  const body = $('persons-body');
  if (!persons.length) { body.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">暂无成员</td></tr>'; return; }
  body.innerHTML = persons.map(p => `
    <tr>
      <td><b>${esc(p.name)}</b></td>
      <td><span class="tag">${p.count} 次</span></td>
      <td>${Array.from(p.groups).map(g => esc(g)).join('、')}</td>
      <td>${fmtTime(p.first)}</td>
      <td>${fmtTime(p.last)}</td>
      <td><button class="btn-del" onclick="delPerson('${esc(p.name).replace(/'/g, "\\'")}')">清除记录</button></td>
    </tr>
  `).join('');
}

async function delPerson(name) {
  if (!confirm(`确定清除「${name}」的所有打卡记录？`)) return;
  const ids = allCheckins.filter(c => c.user_name === name).map(c => c.id);
  for (const id of ids) {
    await fetch('/api/admin/checkins/' + id, { method: 'DELETE', headers: authHeaders() });
  }
  loadAll();
}

function renderCheckins() {
  const fg = $('filter-group').value.trim().toLowerCase();
  const fu = $('filter-user').value.trim().toLowerCase();
  const fk = $('filter-keyword').value.trim().toLowerCase();

  const filtered = allCheckins.filter(c => {
    if (fg && !c.group_name.toLowerCase().includes(fg) && !c.group_code.toLowerCase().includes(fg)) return false;
    if (fu && !c.user_name.toLowerCase().includes(fu)) return false;
    if (fk && !(c.address || '').toLowerCase().includes(fk)) return false;
    return true;
  });

  const body = $('checkins-body');
  if (!filtered.length) { body.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">暂无记录</td></tr>'; return; }
  body.innerHTML = filtered.map(c => {
    const loc = c.lat != null
      ? `<a href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" style="color:var(--primary);text-decoration:none">地图</a>`
      : '-';
    return `
      <tr>
        <td>${fmtTime(c.created_at)}</td>
        <td><b>${esc(c.user_name)}</b></td>
        <td><span class="tag">${esc(c.group_code)}</span> ${esc(c.group_name)}</td>
        <td class="addr-cell">${c.address ? esc(c.address) : '-'}<br>${loc}${c.accuracy ? ` · 精度${Math.round(c.accuracy)}m` : ''}</td>
        <td><button class="btn-del" onclick="delCheckin(${c.id})">删除</button></td>
      </tr>`;
  }).join('');
}

async function delCheckin(id) {
  if (!confirm('确定删除这条打卡记录？')) return;
  await fetch('/api/admin/checkins/' + id, { method: 'DELETE', headers: authHeaders() });
  loadAll();
}

function doExport() {
  const url = '/api/admin/export?token=' + encodeURIComponent(getToken());
  window.location.href = url;
}

function fmtTime(ts) { return new Date(ts).toLocaleString('zh-CN'); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

init();
