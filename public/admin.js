const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'ci_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }

let allCheckins = [];
let allGroups = [];
let memberStats = [];
let allLeaves = [];
let currentAdmin = null; // { username, is_super }
let refreshTimer = null;
let editing = null; // { type: 'group'|'checkin', id, data }

// 四个固定打卡时段
const PUNCH_SLOTS = [
  { type: 0, short: '早上班', name: '早上上班卡', time: '07:30', icon: '🌅' },
  { type: 1, short: '午下班', name: '中午下班卡', time: '12:00', icon: '🍱' },
  { type: 2, short: '午上班', name: '下午上班卡', time: '13:30', icon: '☀️' },
  { type: 3, short: '晚下班', name: '下午下班卡', time: '18:00', icon: '🌙' },
];
function punchSlotOf(r) {
  if (r.punch_type != null) return Number(r.punch_type);
  const d = new Date(Number(r.created_at));
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins < 9 * 60 + 45) return 0;
  if (mins < 12 * 60 + 45) return 1;
  if (mins < 15 * 60 + 45) return 2;
  return 3;
}
function dayKeyOf(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
// 上班卡迟到判定：0=07:30，2=13:30；延后超过10分钟记迟到
const WORK_ON_STANDARD = { 0: 7 * 60 + 30, 2: 13 * 60 + 30 };
function punchLateOf(r) {
  const slot = punchSlotOf(r);
  const standard = WORK_ON_STANDARD[slot];
  if (standard === undefined) return { late: false, lateMinutes: 0 };
  const d = new Date(Number(r.created_at));
  const diff = d.getHours() * 60 + d.getMinutes() - standard;
  return diff > 10 ? { late: true, lateMinutes: diff } : { late: false, lateMinutes: 0 };
}

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

  // 人员详情弹窗
  $('person-modal-close').onclick = () => { $('person-modal').classList.add('hidden'); currentPersonKey = ''; };
  $('person-modal').addEventListener('click', (e) => {
    if (e.target.id === 'person-modal') { $('person-modal').classList.add('hidden'); currentPersonKey = ''; }
  });

  // 补卡弹窗
  $('makeup-cancel').onclick = closeMakeup;
  $('makeup-confirm').onclick = confirmMakeup;
  $('makeup-time').onchange = previewMakeupSlot;

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
    const [gRes, cRes, sRes, meRes, lRes] = await Promise.all([
      fetch('/api/admin/groups', { headers: authHeaders() }),
      fetch('/api/admin/checkins', { headers: authHeaders() }),
      fetch('/api/admin/stats/members', { headers: authHeaders() }),
      fetch('/api/admin/me', { headers: authHeaders() }),
      fetch('/api/admin/leaves', { headers: authHeaders() }),
    ]);
    if (gRes.status === 401 || cRes.status === 401 || meRes.status === 401) { logout(); return false; }
    allGroups = await gRes.json();
    allCheckins = await cRes.json();
    memberStats = sRes.ok ? await sRes.json() : [];
    allLeaves = lRes.ok ? await lRes.json() : [];
    if (meRes.ok) currentAdmin = await meRes.json();
    renderStats();
    renderLeaves();
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

function renderLeaves() {
  const box = $('leaves-list');
  if (!box) return;
  const active = allLeaves.filter(l => l.active);
  // 顶部请假中提示计数
  const badge = $('leave-badge');
  if (badge) badge.textContent = active.length;
  if (!allLeaves.length) { box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:16px">暂无请假记录</div>'; return; }
  box.innerHTML = allLeaves.slice(0, 50).map(l => {
    const days = Math.ceil((Number(l.end_ts) - Number(l.start_ts)) / 86400000);
    const tag = l.active
      ? '<span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:12px;margin-left:6px">请假中</span>'
      : '<span style="background:#f0f0f0;color:#999;padding:2px 8px;border-radius:10px;font-size:12px;margin-left:6px">已结束</span>';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f0f0f0;flex-wrap:wrap;gap:8px">
        <div>
          <b>${esc(l.user_name)}</b>
          <span class="tag" style="margin:0 6px">${esc(l.group_name)}</span>
          ${tag}
          <div style="font-size:13px;color:var(--muted);margin-top:4px">${fmtTime(l.start_ts)} ~ ${fmtTime(l.end_ts)}（${days}天）${l.reason ? ' · ' + esc(l.reason) : ''}</div>
        </div>
        <button class="btn-del" onclick="delLeave(${l.id})">删除</button>
      </div>`;
  }).join('');
}

async function delLeave(id) {
  if (!confirm('确定删除该请假记录？删除后对应日期可能计入缺卡。')) return;
  await fetch('/api/admin/leaves/' + id, { method: 'DELETE', headers: authHeaders() });
  loadAll();
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

function todayDots(p) {
  const done = new Set(p.today_slots || []);
  const late = new Set(p.today_late || []);
  return PUNCH_SLOTS.map(s => {
    const ok = done.has(s.type);
    const isLate = late.has(s.type);
    const icon = isLate ? '⚠️' : (ok ? '✅' : s.icon);
    return `<span title="${s.name} ${s.time}${isLate ? ' 迟到' : ''}" style="display:inline-block;min-width:20px;text-align:center;font-size:13px;opacity:${ok ? '1' : '0.3'}">${icon}</span>`;
  }).join('');
}

function statusBadge(p) {
  if (p.on_leave_today) return '<span style="background:#fff3e0;color:#e65100;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600">📝 请假中</span>';
  const n = (p.today_slots || []).length;
  const lateToday = (p.today_late || []).length;
  const lateTag = lateToday ? ` <span style="background:#fff3e0;color:#e65100;padding:3px 8px;border-radius:10px;font-size:12px;font-weight:600">迟到${lateToday}次</span>` : '';
  if (n >= 4) return '<span style="background:#e8f5e9;color:#2e7d32;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600">✓ 今日已满卡</span>' + lateTag;
  if (n > 0) return `<span style="background:#eef2ff;color:#4f46e5;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600">今日已打${n}/4</span>` + lateTag;
  return '<span style="background:#f5f5f5;color:#999;padding:3px 10px;border-radius:10px;font-size:12px">今日未打卡</span>';
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
      .sort((a, b) => (b.today_slots || []).length - (a.today_slots || []).length || b.checkin_days - a.checkin_days)
      .map(p => {
        const args = `'${esc(p.group_code).replace(/'/g, "\\'")}','${esc(p.user_name).replace(/'/g, "\\'")}'`;
        return `
        <tr>
          <td>
            <a href="javascript:void(0)" onclick="openPerson(${args})" style="color:var(--primary);font-weight:700;text-decoration:none">${esc(p.user_name)}</a>
            <div style="margin-top:4px">${statusBadge(p)}</div>
          </td>
          <td style="white-space:nowrap">${todayDots(p)}</td>
          <td>${p.checkin_days} 天</td>
          <td><b style="color:#4f46e5">${p.full_days || 0} 天</b></td>
          <td><b style="color:${p.absent_days > 0 ? 'var(--danger)' : 'var(--success)'}">${p.absent_days} 天</b></td>
          <td style="color:#e67e22">${p.leave_days || 0} 天</td>
          <td><b style="color:${p.late_count > 0 ? '#e65100' : 'var(--success)'}">${p.late_count || 0} 次</b></td>
          <td>${p.total_checkins} 次</td>
          <td style="white-space:nowrap">
            <button class="btn-edit" onclick="openPerson(${args})">📋 记录</button>
            <button class="btn-edit" style="color:#0277bd" onclick="openMakeup(${args})">🔧 补卡</button>
            <button class="btn-del" onclick="delPerson(${args})">清除</button>
          </td>
        </tr>`;
      }).join('');
    return `
      <div style="margin-bottom:20px">
        <h3 style="font-size:15px;margin-bottom:8px;color:var(--primary)">${esc(g.group_name)} <span class="tag">${esc(g.group_code)}</span>（${g.members.length}人）</h3>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>人员</th><th>今日打卡</th><th>打卡天数</th><th>完整卡天数</th>
              <th>缺卡天数</th><th>请假天数</th><th>迟到次数</th><th>总计</th><th>操作</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

// ---------- 人员详情弹窗 ----------
let currentPersonKey = '';

async function openPerson(code, user) {
  currentPersonKey = code + '|' + user;
  const p = memberStats.find(m => m.group_code === code && m.user_name === user);
  $('person-makeup-btn').onclick = () => openMakeup(code, user);
  $('person-modal-title').textContent = '👤 ' + user;
  $('person-modal-group').textContent = p ? `${p.group_name}（${p.group_code}）` : code;
  // 统计徽标
  $('person-modal-stats').innerHTML = p ? [
    `打卡 <b>${p.checkin_days}</b> 天`,
    `完整卡 <b style="color:#4f46e5">${p.full_days || 0}</b> 天`,
    `缺卡 <b style="color:${p.absent_days > 0 ? 'var(--danger)' : 'var(--success)'}">${p.absent_days}</b> 天`,
    `请假 <b style="color:#e67e22">${p.leave_days || 0}</b> 天`,
    `迟到 <b style="color:${p.late_count > 0 ? '#e65100' : 'var(--success)'}">${p.late_count || 0}</b> 次`,
    `共 <b>${p.total_checkins}</b> 次`,
  ].map(t => `<span style="background:#f7f8fa;border:1px solid var(--border);border-radius:8px;padding:5px 10px;font-size:13px">${t}</span>`).join('') : '';
  // 今日四卡种
  const done = new Set(p ? (p.today_slots || []) : []);
  const todayLate = new Set(p ? (p.today_late || []) : []);
  $('person-modal-today').innerHTML = PUNCH_SLOTS.map(s => {
    const ok = done.has(s.type);
    const isLate = todayLate.has(s.type);
    const bg = isLate ? '#fff3e0' : (ok ? '#e8f5e9' : '#f5f5f5');
    const fg = isLate ? '#e65100' : (ok ? '#2e7d32' : '#999');
    const bd = isLate ? '#ffcc80' : (ok ? '#a5d6a7' : '#eee');
    const icon = isLate ? '⚠️' : (ok ? '✅' : s.icon);
    return `<div style="flex:1;text-align:center;padding:8px 2px;border-radius:10px;font-size:12px;background:${bg};color:${fg};border:1px solid ${bd}">
      <div style="font-size:16px">${icon}</div>
      <div style="margin-top:2px;font-weight:600">${s.short}${isLate ? '<br>迟到' : ''}</div><div>${s.time}</div>
    </div>`;
  }).join('');
  $('person-records').innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">加载中...</div>';
  $('person-modal').classList.remove('hidden');

  try {
    const res = await fetch('/api/admin/persons/checkins?code=' + encodeURIComponent(code) + '&user=' + encodeURIComponent(user), { headers: authHeaders() });
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error);
    renderPersonRecords(rows);
  } catch (e) {
    $('person-records').innerHTML = '<div style="color:var(--danger);padding:16px">加载失败：' + esc(e.message) + '</div>';
  }
}

function renderPersonRecords(rows) {
  const box = $('person-records');
  if (!rows.length) {
    box.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">暂无打卡记录</div>';
    return;
  }
  // 按日期分组
  const dayMap = new Map();
  rows.forEach(r => {
    const k = dayKeyOf(r.created_at);
    if (!dayMap.has(k)) dayMap.set(k, []);
    dayMap.get(k).push(r);
  });
  box.innerHTML = Array.from(dayMap.entries()).map(([day, list]) => {
    const slots = new Set(list.map(punchSlotOf));
    const full = slots.size >= 4;
    const d = new Date(Number(list[0].created_at));
    const dateStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
    const items = list.map(r => {
      const s = PUNCH_SLOTS[punchSlotOf(r)];
      const lateInfo = punchLateOf(r);
      const t = new Date(Number(r.created_at));
      const hm = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
      const lateTag = lateInfo.late
        ? `<span style="background:#fff3e0;color:#e65100;border:1px solid #ffcc80;border-radius:6px;padding:0 6px;font-size:12px;margin-left:6px;font-weight:600">⚠️ 迟到${lateInfo.lateMinutes}分钟</span>`
        : '';
      const makeupTag = r.is_makeup
        ? `<span style="background:#e0f7fa;color:#0277bd;border:1px solid #80deea;border-radius:6px;padding:0 6px;font-size:12px;margin-left:6px;font-weight:600">🔧 补卡·正常</span>`
        : '';
      const loc = r.is_makeup
        ? `<span style="color:var(--muted)">管理员补卡${r.makeup_reason ? ' · ' + esc(r.makeup_reason) : ''}</span>`
        : (r.lat != null ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" style="color:var(--primary)">${r.address ? esc(r.address) : '📍 地图位置'}</a>` : '');
      return `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f5f5f5">
          <div style="width:56px;font-weight:600;font-size:13px;color:${lateInfo.late ? '#e65100' : 'var(--primary)'}">${s.icon} ${hm}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px">${s.name}${lateTag}${makeupTag}</div>
            <div style="font-size:12px;color:var(--muted)">${loc}${r.accuracy ? ` · 精度${Math.round(r.accuracy)}m` : ''}</div>
          </div>
          <button class="btn-del" onclick="delCheckinRefresh(${r.id})">删除</button>
        </div>`;
    }).join('');
    return `
      <div style="margin-bottom:14px">
        <div style="font-weight:700;font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between">
          <span>${dateStr} ${full ? '<span style="color:#2e7d32;font-weight:600">✓ 完整卡</span>' : `<span style="color:#e67e22">${slots.size}/4 卡</span>`}</span>
        </div>
        ${items}
      </div>`;
  }).join('');
}

async function delCheckinRefresh(id) {
  if (!confirm('确定删除这条打卡记录？')) return;
  await fetch('/api/admin/checkins/' + id, { method: 'DELETE', headers: authHeaders() });
  await loadAll();
  if (currentPersonKey) {
    const [code, user] = currentPersonKey.split('|');
    openPerson(code, user);
  }
}

async function delPerson(code, user) {
  if (!confirm(`确定清除「${user}」在该群组的所有打卡记录？`)) return;
  await fetch('/api/admin/persons/checkins?code=' + encodeURIComponent(code) + '&user=' + encodeURIComponent(user), {
    method: 'DELETE', headers: authHeaders(),
  });
  loadAll();
}

// ---------- 补卡 ----------
let makeupTarget = null; // { code, user }

function localDatetimeValue(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openMakeup(code, user) {
  makeupTarget = { code, user };
  const p = memberStats.find(m => m.group_code === code && m.user_name === user);
  $('makeup-user').textContent = user;
  $('makeup-group').textContent = p ? `${p.group_name}（${p.group_code}）` : code;
  $('makeup-time').value = localDatetimeValue();
  $('makeup-reason').value = '';
  previewMakeupSlot();
  $('makeup-modal').classList.remove('hidden');
}

function closeMakeup() {
  $('makeup-modal').classList.add('hidden');
  makeupTarget = null;
}

function previewMakeupSlot() {
  const v = $('makeup-time').value;
  const box = $('makeup-slot-preview');
  if (!v) { box.innerHTML = ''; return; }
  const ts = new Date(v).getTime();
  const slot = PUNCH_SLOTS[punchSlotOf({ punch_type: null, created_at: ts })];
  box.innerHTML = `将记为：${slot.icon} <b>${slot.name}</b>（标准 ${slot.time}），状态：<b style="color:#2e7d32">正常</b>`;
}

async function confirmMakeup() {
  if (!makeupTarget) return;
  const v = $('makeup-time').value;
  if (!v) { alert('请选择补卡时间'); return; }
  const ts = new Date(v).getTime();
  if (ts > Date.now()) { alert('补卡时间不能晚于当前时间'); return; }
  const reason = $('makeup-reason').value.trim();
  try {
    const res = await fetch('/api/admin/persons/makeup-checkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ code: makeupTarget.code, user: makeupTarget.user, ts, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeMakeup();
    await loadAll();
    // 若详情弹窗打开着则刷新
    if (currentPersonKey) {
      const [code, user] = currentPersonKey.split('|');
      openPerson(code, user);
    }
  } catch (e) {
    alert('补卡失败：' + e.message);
  }
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
