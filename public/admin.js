const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'ci_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }

let allCheckins = [];
let allGroups = [];
let refreshTimer = null;
let editing = null; // { type: 'group'|'checkin', id, data }

// ---------- 初始化 ----------
function init() {
  // 防截屏：禁用右键、复制
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('copy', e => e.preventDefault());
  document.addEventListener('cut', e => e.preventDefault());

  // 管理后台水印
  setWatermark('管理员');

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
  $('modal-cancel').onclick = closeModal;
  $('modal-save').onclick = saveEdit;

  // 修改密码
  $('btn-change-pwd').onclick = openPwdModal;
  $('pwd-cancel').onclick = closePwdModal;
  $('pwd-save').onclick = changePassword;

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
  if (!allGroups.length) { body.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">暂无群组</td></tr>'; return; }
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
        <td><button class="btn-edit" onclick="editGroup(${g.id})">✏️ 编辑</button></td>
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
        <td>
          <button class="btn-edit" onclick="editCheckin(${c.id})">✏️</button>
          <button class="btn-del" onclick="delCheckin(${c.id})">删除</button>
        </td>
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

function setWatermark(name) {
  const wm = $('watermark');
  if (!wm) return;
  const text = name + ' · ' + new Date().toLocaleDateString('zh-CN');
  wm.innerHTML = Array(20).fill(`<span>${esc(text)}</span>`).join('');
}

// ---------- 编辑功能 ----------
function editGroup(id) {
  const g = allGroups.find(x => x.id === id);
  if (!g) return;
  editing = { type: 'group', id, data: { ...g } };
  $('modal-title').textContent = '编辑群组';
  $('modal-fields').innerHTML = `
    <div class="field"><label>群组名称</label><input id="ef-name" value="${esc(g.name)}"></div>
    <div class="field"><label>中心点纬度（不限制留空）</label><input id="ef-lat" value="${g.center_lat ?? ''}" placeholder="如 22.951"></div>
    <div class="field"><label>中心点经度（不限制留空）</label><input id="ef-lng" value="${g.center_lng ?? ''}" placeholder="如 113.877"></div>
    <div class="field"><label>打卡范围（米，0=不限制）</label><input id="ef-radius" type="number" value="${g.radius ?? 0}"></div>
  `;
  $('edit-modal').classList.remove('hidden');
}

function editCheckin(id) {
  const c = allCheckins.find(x => x.id === id);
  if (!c) return;
  editing = { type: 'checkin', id, data: { ...c } };
  $('modal-title').textContent = '编辑打卡记录';
  $('modal-fields').innerHTML = `
    <div class="field"><label>用户姓名</label><input id="ef-user" value="${esc(c.user_name)}"></div>
    <div class="field"><label>地点/公司名</label><input id="ef-addr" value="${esc(c.address || '')}" placeholder="如：XX公司前台"></div>
  `;
  $('edit-modal').classList.remove('hidden');
}

function closeModal() {
  editing = null;
  $('edit-modal').classList.add('hidden');
}

async function saveEdit() {
  if (!editing) return;
  try {
    if (editing.type === 'group') {
      const name = $('ef-name').value.trim();
      const lat = $('ef-lat').value.trim();
      const lng = $('ef-lng').value.trim();
      const radius = parseInt($('ef-radius').value) || 0;
      if (!name) { alert('群组名称不能为空'); return; }
      const body = { name, radius };
      if (lat && lng) { body.center_lat = parseFloat(lat); body.center_lng = parseFloat(lng); }
      else { body.center_lat = null; body.center_lng = null; }
      await fetch('/api/admin/groups/' + editing.id, {
        method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      const user_name = $('ef-user').value.trim();
      const address = $('ef-addr').value.trim();
      if (!user_name) { alert('用户名不能为空'); return; }
      await fetch('/api/admin/checkins/' + editing.id, {
        method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_name, address }),
      });
    }
    closeModal();
    loadAll();
  } catch (e) {
    alert('保存失败：' + e.message);
  }
}

// ---------- 修改密码 ----------
function openPwdModal() {
  $('pwd-old').value = '';
  $('pwd-new').value = '';
  $('pwd-confirm').value = '';
  $('pwd-error').textContent = '';
  $('pwd-modal').classList.remove('hidden');
}
function closePwdModal() {
  $('pwd-modal').classList.add('hidden');
}
async function changePassword() {
  const oldPwd = $('pwd-old').value.trim();
  const newPwd = $('pwd-new').value.trim();
  const confirmPwd = $('pwd-confirm').value.trim();
  $('pwd-error').textContent = '';
  if (!oldPwd || !newPwd || !confirmPwd) { $('pwd-error').textContent = '请填写所有字段'; return; }
  if (newPwd.length < 6) { $('pwd-error').textContent = '新密码至少 6 位'; return; }
  if (newPwd !== confirmPwd) { $('pwd-error').textContent = '两次输入的新密码不一致'; return; }
  try {
    const res = await fetch('/api/admin/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
    });
    if (res.status === 401) { $('pwd-error').textContent = '旧密码错误'; return; }
    const data = await res.json();
    if (!res.ok) { $('pwd-error').textContent = data.error || '修改失败'; return; }
    alert('密码修改成功，请重新登录');
    closePwdModal();
    logout();
  } catch (e) {
    $('pwd-error').textContent = '网络错误';
  }
}

init();
