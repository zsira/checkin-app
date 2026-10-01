const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'ci_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }

let allCheckins = [];
let allGroups = [];
let memberStats = [];
let currentAdmin = null; // { username, is_super }
let refreshTimer = null;
let editing = null; // { type: 'group'|'checkin', id, data }

// ---------- 初始化 ----------
function init() {
  // 防截屏：禁用右键、复制（输入框/文本域内不禁用，保证可正常编辑删除）
  const isEditable = (el) => el && el.closest && el.closest('input, textarea, [contenteditable="true"]');
  document.addEventListener('contextmenu', e => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('copy', e => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('cut', e => { if (!isEditable(e.target)) e.preventDefault(); });

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

  // 创建群组
  $('btn-create-group').onclick = openCreateGroup;
  $('cg-cancel').onclick = closeCreateGroup;
  $('cg-save').onclick = createGroup;
  $('cg-loc-btn').onclick = () => useCurrentLocation('cg-lat', 'cg-lng', 'cg-addr-result');
  $('cg-geo-btn').onclick = () => geocodeAddress('cg-addr', 'cg-lat', 'cg-lng', 'cg-addr-result');

  // 邀请
  $('invite-close').onclick = closeInvite;
  $('btn-copy-code').onclick = () => copyText($('invite-code').textContent);
  $('btn-copy-link').onclick = () => copyText($('invite-link').textContent);
  $('btn-share').onclick = shareInvite;

  // 修改密码
  $('btn-change-pwd').onclick = openPwdModal;
  $('pwd-cancel').onclick = closePwdModal;
  $('pwd-save').onclick = changePassword;

  // 管理员管理
  $('btn-add-admin').onclick = openAdminModal;
  $('adm-cancel').onclick = closeAdminModal;
  $('adm-save').onclick = addAdmin;

  // 休息设置
  $('rest-mode').onchange = () => {
    const mode = $('rest-mode').value;
    $('rest-days-box').style.display = mode === 'days' ? '' : 'none';
    $('rest-range-box').style.display = mode === 'range' ? '' : 'none';
  };
  $('rest-cancel').onclick = closeRestModal;
  $('rest-confirm').onclick = confirmRest;

  $('filter-person').addEventListener('input', () => { renderPersons(); });
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
  const username = $('login-username').value.trim() || 'admin';
  const password = $('login-password').value;
  $('login-error').textContent = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { $('login-error').textContent = data.error || '登录失败'; return; }
    localStorage.setItem(TOKEN_KEY, data.token);
    currentAdmin = { username: data.username, is_super: data.is_super };
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
    const [gRes, cRes, sRes, meRes] = await Promise.all([
      fetch('/api/admin/groups', { headers: authHeaders() }),
      fetch('/api/admin/checkins', { headers: authHeaders() }),
      fetch('/api/admin/stats/members', { headers: authHeaders() }),
      fetch('/api/admin/me', { headers: authHeaders() }),
    ]);
    if (gRes.status === 401 || cRes.status === 401 || meRes.status === 401) { logout(); return false; }
    allGroups = await gRes.json();
    allCheckins = await cRes.json();
    memberStats = sRes.ok ? await sRes.json() : [];
    if (meRes.ok) currentAdmin = await meRes.json();
    renderStats();
    renderGroups();
    renderPersons();
    // 超管功能
    if (currentAdmin && currentAdmin.is_super) {
      $('panel-admins').style.display = '';
      loadAdmins();
    } else {
      $('panel-admins').style.display = 'none';
    }
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
  const todayCount = allCheckins.filter(c => Number(c.created_at) >= today.getTime()).length;

  $('stats').innerHTML = [
    { num: totalGroups, label: '群组总数' },
    { num: totalCheckins, label: '打卡总数' },
    { num: uniqueUsers, label: '参与人数' },
    { num: todayCount, label: '今日打卡' },
  ].map(s => `<div class="stat-card"><div class="stat-num">${s.num}</div><div class="stat-label">${s.label}</div></div>`).join('');
}

function renderGroups() {
  const body = $('groups-body');
  if (!allGroups.length) { body.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">暂无群组</td></tr>'; return; }
  const now = Date.now();
  body.innerHTML = allGroups.map(g => {
    const range = g.radius > 0 && g.center_lat != null
      ? `${g.center_lat.toFixed(4)}, ${g.center_lng.toFixed(4)} · ${g.radius}m`
      : '<span style="color:var(--muted)">不限制</span>';
    const times = (g.checkin_times || []);
    const timesText = times.length
      ? times.map(t => `${t.start}-${t.end}`).join('<br>')
      : '<span style="color:var(--muted)">任意时间</span>';
    // 休息状态
    const resting = g.rest_until && Number(g.rest_until) > now;
    const restBadge = resting
      ? `<div style="margin-top:4px;font-size:12px;color:#e67e22">🛌 休息至 ${fmtTime(g.rest_until)}</div>`
      : '';
    const restBtn = resting
      ? `<button class="btn-del" onclick="setRest(${g.id}, true)">🛌 取消休息</button>`
      : `<button class="btn-edit" onclick="setRest(${g.id}, false)">🛌 休息</button>`;
    return `
      <tr>
        <td><b>${esc(g.name)}</b>${restBadge}</td>
        <td><span class="tag">${esc(g.code)}</span></td>
        <td>${range}</td>
        <td style="font-size:12px">${timesText}</td>
        <td>${g.checkin_count}</td>
        <td>${fmtTime(g.created_at)}</td>
        <td>
          <button class="btn-edit" onclick="inviteGroup(${g.id})">📨 邀请</button>
          <button class="btn-edit" onclick="editGroup(${g.id})">✏️ 编辑</button>
          ${restBtn}
          <button class="btn-del" onclick="delGroup(${g.id},'${esc(g.name).replace(/'/g, "\\'")}')">🗑️ 删除</button>
        </td>
      </tr>`;
  }).join('');
}

function renderPersons() {
  const fp = $('filter-person')?.value.trim().toLowerCase() || '';
  let persons = memberStats.slice();
  if (fp) persons = persons.filter(p => p.user_name.toLowerCase().includes(fp));

  const container = $('persons-container');
  if (!persons.length) {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:24px">暂无成员</div>';
    return;
  }

  // 按群组分组
  const groupMap = new Map();
  persons.forEach(p => {
    if (!groupMap.has(p.group_code)) {
      groupMap.set(p.group_code, { group_name: p.group_name, group_code: p.group_code, members: [] });
    }
    groupMap.get(p.group_code).members.push(p);
  });

  container.innerHTML = Array.from(groupMap.values()).map(g => {
    const rows = g.members
      .sort((a, b) => b.checkin_days - a.checkin_days || b.total_checkins - a.total_checkins)
      .map(p => `
        <tr>
          <td><b>${esc(p.user_name)}</b></td>
          <td>${p.checkin_days} 天</td>
          <td><b style="color:${p.absent_days > 0 ? 'var(--danger)' : 'var(--success)'}">${p.absent_days} 天</b></td>
          <td>${p.total_checkins} 次</td>
          <td><button class="btn-del" onclick="delPerson('${esc(p.user_name).replace(/'/g, "\\'")}')">清除记录</button></td>
        </tr>`).join('');
    return `
      <div style="margin-bottom:20px">
        <h3 style="font-size:15px;margin-bottom:8px;color:var(--primary)">${esc(g.group_name)} <span class="tag">${esc(g.group_code)}</span></h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>人员</th><th>打卡天数</th><th>缺卡天数</th><th>总计</th><th>操作</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
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

function fmtTime(ts) { return new Date(Number(ts)).toLocaleString('zh-CN'); }
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
  const times = g.checkin_times || [];
  const timesHtml = times.map((t, i) => renderTimeRow(i, t)).join('');
  $('modal-title').textContent = '编辑群组';
  $('modal-fields').innerHTML = `
    <div class="field"><label>群组名称</label><input id="ef-name" value="${esc(g.name)}"></div>
    <div class="field">
      <label>📍 定位或地址识别</label>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn-save" onclick="useCurrentLocation('ef-lat','ef-lng','ef-addr-result')" style="flex:1;padding:10px;font-size:13px">使用当前位置</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="ef-addr" type="text" placeholder="输入地址自动识别坐标" style="flex:1;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;font-size:14px;outline:none;box-sizing:border-box">
        <button type="button" class="btn-save" onclick="geocodeAddress('ef-addr','ef-lat','ef-lng','ef-addr-result')" style="flex:none;padding:10px 14px;font-size:13px">识别</button>
      </div>
      <div id="ef-addr-result" style="font-size:12px;color:var(--success);margin-top:4px;min-height:16px"></div>
    </div>
    <div class="field"><label>中心点纬度（不限制留空）</label><input id="ef-lat" value="${g.center_lat ?? ''}" placeholder="如 22.951"></div>
    <div class="field"><label>中心点经度（不限制留空）</label><input id="ef-lng" value="${g.center_lng ?? ''}" placeholder="如 113.877"></div>
    <div class="field"><label>打卡范围（米，0=不限制）</label><input id="ef-radius" type="number" value="${g.radius ?? 0}"></div>
    <div class="field">
      <label>打卡时间段（留空=不限制时间）</label>
      <div id="time-rows">${timesHtml || '<p class="muted" style="font-size:12px;margin:4px 0">未设置，任意时间可打卡</p>'}</div>
      <button type="button" class="btn btn-secondary" style="margin-top:8px;padding:6px 12px;font-size:13px" onclick="addTimeRow()">+ 添加时段</button>
    </div>
  `;
  $('edit-modal').classList.remove('hidden');
}

function renderTimeRow(i, t) {
  return `
    <div class="time-row" data-idx="${i}" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <input type="time" value="${t?.start || '08:00'}" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:14px">
      <span style="color:var(--muted)">至</span>
      <input type="time" value="${t?.end || '09:00'}" style="flex:1;padding:8px;border:1.5px solid var(--border);border-radius:8px;font-size:14px">
      <button type="button" class="btn-del" style="color:var(--danger);background:none;border:none;cursor:pointer;font-size:18px" onclick="this.parentElement.remove()">×</button>
    </div>`;
}

function addTimeRow() {
  const container = $('time-rows');
  const idx = container.children.length;
  // 清除"未设置"提示
  if (container.querySelector('.muted')) container.innerHTML = '';
  container.insertAdjacentHTML('beforeend', renderTimeRow(idx, { start: '08:00', end: '09:00' }));
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
      // 收集打卡时间段
      const timeRows = document.querySelectorAll('.time-row');
      const checkin_times = [];
      timeRows.forEach(row => {
        const inputs = row.querySelectorAll('input[type="time"]');
        if (inputs.length === 2) {
          checkin_times.push({ start: inputs[0].value, end: inputs[1].value });
        }
      });
      const body = { name, radius, checkin_times };
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

// ---------- 管理员管理 ----------
async function loadAdmins() {
  try {
    const res = await fetch('/api/admin/admins', { headers: authHeaders() });
    if (!res.ok) return;
    const admins = await res.json();
    $('admins-body').innerHTML = admins.map(a => `
      <tr>
        <td><b>${esc(a.username)}</b></td>
        <td>${a.is_super ? '<span class="tag" style="background:#fef3c7;color:#d97706">超级管理员</span>' : '<span class="tag">管理员</span>'}</td>
        <td>${fmtTime(a.created_at)}</td>
        <td>${a.is_super ? '-' : `<button class="btn-del" onclick="delAdmin(${a.id},'${esc(a.username)}')">删除</button>`}</td>
      </tr>
    `).join('');
  } catch (e) {}
}
function openAdminModal() {
  $('adm-username').value = '';
  $('adm-password').value = '';
  $('adm-error').textContent = '';
  $('admin-modal').classList.remove('hidden');
}
function closeAdminModal() {
  $('admin-modal').classList.add('hidden');
}
async function addAdmin() {
  const username = $('adm-username').value.trim();
  const password = $('adm-password').value.trim();
  $('adm-error').textContent = '';
  if (!username) { $('adm-error').textContent = '请输入账号'; return; }
  if (password.length < 6) { $('adm-error').textContent = '密码至少 6 位'; return; }
  try {
    const res = await fetch('/api/admin/admins', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { $('adm-error').textContent = data.error || '添加失败'; return; }
    closeAdminModal();
    loadAdmins();
    alert('管理员添加成功');
  } catch (e) {
    $('adm-error').textContent = '网络错误';
  }
}
async function delAdmin(id, name) {
  if (!confirm(`确定删除管理员「${name}」？`)) return;
  await fetch('/api/admin/admins/' + id, { method: 'DELETE', headers: authHeaders() });
  loadAdmins();
}

// ---------- 删除群组 ----------
async function delGroup(id, name) {
  if (!confirm(`确定删除群组「${name}」？\n该群组的所有打卡记录将一并删除，且不可恢复！`)) return;
  await fetch('/api/admin/groups/' + id, { method: 'DELETE', headers: authHeaders() });
  loadAll();
}

// ---------- 群休息 ----------
let restingGroupId = null;

function setRest(id, isResting) {
  if (isResting) {
    // 取消休息
    if (!confirm('确定取消该群组的休息状态？成员将恢复打卡。')) return;
    fetch('/api/admin/groups/' + id + '/rest', {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rest_until: null, rest_reason: null })
    }).then(() => loadAll());
    return;
  }
  // 打开休息设置弹窗
  restingGroupId = id;
  const g = allGroups.find(x => x.id === id);
  $('rest-group-name').textContent = g ? g.name : '';
  $('rest-mode').value = 'days';
  $('rest-days').value = '1';
  $('rest-reason').value = '';
  $('rest-start').value = '';
  $('rest-end').value = '';
  $('rest-days-box').style.display = '';
  $('rest-range-box').style.display = 'none';
  $('rest-modal').classList.remove('hidden');
}

function closeRestModal() {
  $('rest-modal').classList.add('hidden');
  restingGroupId = null;
}

async function confirmRest() {
  if (!restingGroupId) return;
  let restUntil = 0;
  const mode = $('rest-mode').value;
  const reason = $('rest-reason').value.trim();

  if (mode === 'days') {
    const days = parseFloat($('rest-days').value);
    if (!days || days <= 0) { alert('请输入有效的休息天数'); return; }
    restUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  } else {
    const start = $('rest-start').value;
    const end = $('rest-end').value;
    if (!start || !end) { alert('请选择开始和结束时间'); return; }
    const endTs = new Date(end).getTime();
    if (endTs <= Date.now()) { alert('结束时间必须晚于当前时间'); return; }
    restUntil = endTs;
  }

  await fetch('/api/admin/groups/' + restingGroupId + '/rest', {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ rest_until: restUntil, rest_reason: reason })
  });
  closeRestModal();
  loadAll();
}

// ---------- 创建群组 ----------
function openCreateGroup() {
  $('cg-name').value = '';
  $('cg-lat').value = '';
  $('cg-lng').value = '';
  $('cg-radius').value = '0';
  $('cg-addr').value = '';
  $('cg-addr-result').textContent = '';
  $('cg-error').textContent = '';
  $('create-group-modal').classList.remove('hidden');
}
function closeCreateGroup() {
  $('create-group-modal').classList.add('hidden');
}

// ---------- 定位与地址识别 ----------
function useCurrentLocation(latId, lngId, resultId) {
  const resultEl = $(resultId);
  resultEl.style.color = 'var(--muted)';
  resultEl.textContent = '正在获取定位...';
  if (!window.isSecureContext) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '非 HTTPS 环境无法定位';
    return;
  }
  if (!navigator.geolocation) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '浏览器不支持定位';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $(latId).value = pos.coords.latitude.toFixed(6);
      $(lngId).value = pos.coords.longitude.toFixed(6);
      resultEl.style.color = 'var(--success)';
      resultEl.textContent = `已定位：${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}（精度 ${Math.round(pos.coords.accuracy)}m）`;
    },
    (err) => {
      resultEl.style.color = 'var(--danger)';
      if (err.code === 1) resultEl.textContent = '定位权限被拒绝，请在浏览器设置中允许';
      else if (err.code === 2) resultEl.textContent = '无法获取位置，请检查 GPS/定位服务';
      else if (err.code === 3) resultEl.textContent = '定位超时，请重试';
      else resultEl.textContent = err.message || '定位失败';
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

async function geocodeAddress(addrId, latId, lngId, resultId) {
  const address = $(addrId).value.trim();
  const resultEl = $(resultId);
  if (!address) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '请先输入地址';
    return;
  }
  resultEl.style.color = 'var(--muted)';
  resultEl.textContent = '正在识别地址...';
  try {
    const res = await fetch('/api/admin/geocode?address=' + encodeURIComponent(address), { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      resultEl.style.color = 'var(--danger)';
      resultEl.textContent = data.error || '识别失败';
      return;
    }
    $(latId).value = data.lat.toFixed(6);
    $(lngId).value = data.lng.toFixed(6);
    resultEl.style.color = 'var(--success)';
    resultEl.textContent = `已识别：${data.address || address}`;
  } catch (e) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = '网络错误';
  }
}

async function createGroup() {
  const name = $('cg-name').value.trim();
  const lat = $('cg-lat').value.trim();
  const lng = $('cg-lng').value.trim();
  const radius = parseInt($('cg-radius').value) || 0;
  $('cg-error').textContent = '';
  if (!name) { $('cg-error').textContent = '请输入群组名称'; return; }
  try {
    const body = { name };
    if (lat && lng) {
      body.center_lat = parseFloat(lat);
      body.center_lng = parseFloat(lng);
      body.radius = radius;
    }
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { $('cg-error').textContent = data.error || '创建失败'; return; }
    closeCreateGroup();
    alert(`群组「${data.name}」创建成功！\n邀请码：${data.code}`);
    loadAll();
    // 创建成功后直接打开邀请弹窗
    inviteGroup(data.id);
  } catch (e) {
    $('cg-error').textContent = '网络错误';
  }
}

// ---------- 邀请 ----------
function inviteGroup(id) {
  const g = allGroups.find(x => x.id === id);
  if (!g) return;
  $('invite-group-name').textContent = g.name;
  $('invite-code').textContent = g.code;
  const link = location.origin + location.pathname.replace('admin.html', 'index.html') + '?code=' + g.code;
  $('invite-link').textContent = link;
  // 系统分享按钮
  const shareBtn = $('btn-share');
  if (navigator.share) {
    shareBtn.style.display = '';
  } else {
    shareBtn.style.display = 'none';
  }
  $('invite-modal').classList.remove('hidden');
}
function closeInvite() {
  $('invite-modal').classList.add('hidden');
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('已复制到剪贴板');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); alert('已复制到剪贴板'); }
    catch { alert('复制失败，请手动复制'); }
    ta.remove();
  }
}
async function shareInvite() {
  if (!navigator.share) return;
  const code = $('invite-code').textContent;
  const name = $('invite-group-name').textContent;
  const link = $('invite-link').textContent;
  try {
    await navigator.share({
      title: '打卡邀请',
      text: `邀请你加入「${name}」打卡群\n邀请码：${code}`,
      url: link,
    });
  } catch (e) {}
}

init();
