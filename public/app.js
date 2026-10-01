// ---------- 状态 ----------
const state = {
  userName: localStorage.getItem('ci_name') || '',
  groupCode: localStorage.getItem('ci_group') || '',
  groupName: localStorage.getItem('ci_group_name') || '',
  isCreator: false,
  centerLat: null,
  centerLng: null,
  radius: 0,
};

const $ = (id) => document.getElementById(id);

// ---------- 引导文案 ----------
const GUIDE_CONTENT = {
  install: {
    title: '📲 安装到手机桌面（全屏无地址栏）',
    subtitle: '必须选择「安装应用」才能像 App 一样全屏使用',
    android: [
      '点击浏览器右上角 <b>⋮</b> 菜单按钮',
      '选择「<b>安装应用</b>」（⚠️ 不要选"添加到主屏幕"，那个会显示网址）',
      '确认安装，桌面会出现打卡图标',
      '从桌面图标打开就是全屏 App，没有地址栏',
    ],
    ios: [
      '用 <b>Safari</b> 浏览器打开本页面',
      '点击底部的 <b>分享按钮</b>（方框 + 向上箭头）',
      '在弹出菜单中选择「<b>添加到主屏幕</b>」',
      '点击右上角「<b>添加</b>」',
      '从桌面图标打开就是全屏 App，没有地址栏',
    ],
    tip: '⚠️ 安卓必须选「安装应用」而非「添加到主屏幕」；必须用 Chrome/Edge/Safari，微信内无法安装。如果之前装过，先删掉旧图标再重新安装。',
  },
  location: {
    title: '📍 开启定位权限',
    subtitle: '打卡需要获取你的位置，请按以下步骤授权',
    android: [
      '点击地址栏左侧的 <b>🔒 锁图标</b>',
      '找到「<b>位置</b>」权限，改为「<b>允许</b>」',
      '<b>刷新页面</b>，然后重新点击打卡',
    ],
    ios: [
      '点击地址栏左侧的 <b>大小按钮</b>（如「aA」）',
      '选择「<b>网站设置</b>」→「<b>位置</b>」→「<b>允许</b>」',
      '<b>刷新页面</b>，然后重新点击打卡',
    ],
    tip: '同时请确保手机系统的「定位服务 / GPS」已开启，且在室外或窗边使用。',
  },
};

let currentGuideOS = 'android';

function showGuide(type) {
  const content = GUIDE_CONTENT[type];
  if (!content) return;
  $('guide-title').textContent = content.title;
  $('guide-subtitle').textContent = content.subtitle;
  currentGuideOS = detectOS();
  renderGuideSteps(content);
  $('guide-modal').classList.remove('hidden');
}

function renderGuideSteps(content) {
  document.querySelectorAll('.guide-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.os === currentGuideOS);
  });
  const steps = content[currentGuideOS];
  const html = steps.map((s, i) => `
    <div class="guide-step">
      <div class="step-num">${i + 1}</div>
      <div class="step-text">${s}</div>
    </div>
  `).join('') + (content.tip ? `<div class="guide-tip">💡 ${content.tip}</div>` : '');
  $('guide-steps').innerHTML = html;
}

function detectOS() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'android';
}

// ---------- 视图切换 ----------
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
}

// ---------- Toast ----------
let toastTimer;
function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// 生成全屏水印（半透明显示用户名，截屏可追溯来源）
function setWatermark(name) {
  const wm = $('watermark');
  if (!wm) return;
  const text = name + ' · ' + new Date().toLocaleDateString('zh-CN');
  wm.innerHTML = Array(20).fill(`<span>${escapeHtml(text)}</span>`).join('');
}

// ---------- 初始化 ----------
let deferredPrompt = null;

function init() {
  // 注册 Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  // 防截屏：禁用右键、复制、拖拽
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('copy', e => e.preventDefault());
  document.addEventListener('cut', e => e.preventDefault());
  document.addEventListener('dragstart', e => e.preventDefault());

  // 生成水印（显示当前用户名，截屏可追溯）
  const name = localStorage.getItem('ci_name') || '';
  if (name) setWatermark(name);

  // PWA 安装提示
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // 安装按钮始终显示，这里仅记录 deferredPrompt 供原生安装使用
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    toast('已安装到桌面 🎉');
  });

  // 检查 URL 中的邀请码
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) {
    state.groupCode = urlCode.toUpperCase();
    localStorage.setItem('ci_group', state.groupCode);
  }

  if (!state.userName) {
    showView('setup');
  } else if (state.groupCode) {
    enterGroup(state.groupCode, state.groupName);
  } else {
    showGroupView();
  }

  bindEvents();
}

function bindEvents() {
  $('btn-continue').onclick = () => {
    const name = $('input-name').value.trim();
    if (!name) return toast('请输入名字');
    state.userName = name;
    localStorage.setItem('ci_name', name);
    setWatermark(name);
    showGroupView();
  };

  $('btn-change-name').onclick = () => {
    localStorage.removeItem('ci_name');
    state.userName = '';
    showView('setup');
  };

  $('btn-create-group').onclick = createGroup;
  $('btn-join-group').onclick = joinGroup;

  $('btn-checkin').onclick = doCheckin;
  $('btn-refresh').onclick = loadRecords;
  $('btn-invite').onclick = openInvite;
  $('btn-leave').onclick = leaveGroup;
  $('btn-install').onclick = installApp;

  $('btn-copy-code').onclick = () => copyText(state.groupCode);
  $('btn-copy-link').onclick = () => copyText(getInviteLink());
  $('btn-share').onclick = shareInvite;
  $('btn-close-invite').onclick = () => $('invite-modal').classList.add('hidden');

  // 打卡范围
  $('btn-set-range').onclick = openRangeModal;
  $('btn-set-range2').onclick = openRangeModal;
  $('btn-close-range').onclick = () => $('range-modal').classList.add('hidden');
  $('btn-use-location').onclick = useCurrentLocationAsCenter;
  $('btn-clear-center').onclick = clearCenter;
  $('btn-save-range').onclick = saveRange;

  // 回车
  $('input-name').onkeydown = (e) => e.key === 'Enter' && $('btn-continue').click();
  $('input-group-name').onkeydown = (e) => e.key === 'Enter' && $('btn-create-group').click();
  $('input-group-code').onkeydown = (e) => e.key === 'Enter' && $('btn-join-group').click();

  // 引导弹窗
  $('btn-close-guide').onclick = () => $('guide-modal').classList.add('hidden');
  $('guide-modal').addEventListener('click', (e) => {
    if (e.target.id === 'guide-modal') $('guide-modal').classList.add('hidden');
  });
  document.querySelectorAll('.guide-tab').forEach(tab => {
    tab.onclick = () => {
      currentGuideOS = tab.dataset.os;
      const type = $('guide-title').textContent.includes('安装') ? 'install' : 'location';
      renderGuideSteps(GUIDE_CONTENT[type]);
    };
  });
}

// ---------- 群组 ----------
function showGroupView() {
  $('greeting-name').textContent = state.userName;
  showView('group');
}

async function createGroup() {
  const name = $('input-group-name').value.trim();
  if (!name) return toast('请输入群组名称');
  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userName: state.userName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.groupCode = data.code;
    state.groupName = data.name;
    state.isCreator = true;
    localStorage.setItem('ci_group', data.code);
    localStorage.setItem('ci_group_name', data.name);
    enterGroup(data.code, data.name);
  } catch (e) {
    toast(e.message || '创建失败');
  }
}

async function joinGroup() {
  const code = $('input-group-code').value.trim().toUpperCase();
  if (!code) return toast('请输入邀请码');
  try {
    const res = await fetch('/api/groups/' + encodeURIComponent(code));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.groupCode = data.code;
    state.groupName = data.name;
    state.isCreator = !!data.creator && data.creator === state.userName;
    localStorage.setItem('ci_group', data.code);
    localStorage.setItem('ci_group_name', data.name);
    enterGroup(data.code, data.name);
  } catch (e) {
    toast(e.message || '群组不存在');
  }
}

function enterGroup(code, name) {
  state.groupCode = code;
  state.groupName = name || '';
  $('group-name').textContent = name || '群组 ' + code;
  $('group-code-label').textContent = code;
  showView('main');
  loadRecords();
  loadGroupSettings();
}

async function loadGroupSettings() {
  try {
    const res = await fetch('/api/groups/' + encodeURIComponent(state.groupCode));
    const g = await res.json();
    if (!res.ok) return;
    state.centerLat = g.center_lat;
    state.centerLng = g.center_lng;
    state.radius = g.radius || 0;
    // 更新创建者判断
    state.isCreator = !!g.creator && g.creator === state.userName;
    // 非创建者隐藏"设置打卡范围"按钮
    const setRangeBtn = $('btn-set-range');
    const setRangeBtn2 = $('btn-set-range2');
    if (setRangeBtn) setRangeBtn.style.display = state.isCreator ? '' : 'none';
    if (setRangeBtn2) setRangeBtn2.style.display = state.isCreator ? '' : 'none';
    // 同步群组名（邀请链接进入时可能旧）
    if (g.name && g.name !== state.groupName) {
      state.groupName = g.name;
      localStorage.setItem('ci_group_name', g.name);
      $('group-name').textContent = g.name;
    }
    updateRangeDisplay();
  } catch (e) {}
}

function updateRangeDisplay() {
  const el = $('range-info');
  const text = $('range-text');
  if (state.radius > 0 && state.centerLat != null) {
    el.classList.add('has-range');
    text.textContent = `打卡范围：中心点 ${state.centerLat.toFixed(5)}, ${state.centerLng.toFixed(5)} · 半径 ${state.radius} 米`;
  } else {
    el.classList.remove('has-range');
    text.textContent = '未设置打卡范围（任意位置可打卡）';
  }
}

function leaveGroup() {
  if (!confirm('确定退出当前群组？')) return;
  state.groupCode = '';
  state.groupName = '';
  localStorage.removeItem('ci_group');
  localStorage.removeItem('ci_group_name');
  showGroupView();
}

// ---------- 打卡 ----------
async function doCheckin() {
  const btn = $('btn-checkin');
  const status = $('location-status');
  btn.disabled = true;
  status.className = 'location-status';
  status.textContent = '正在获取定位...';

  let pos;
  try {
    pos = await getLocation();
  } catch (e) {
    btn.disabled = false;
    status.className = 'location-status error';
    const denied = /拒绝|denied|非安全/i.test(e.message || '');
    status.innerHTML = '定位失败：' + (e.message || '请允许定位权限') +
      (denied ? ' <a href="#" id="btn-location-guide" style="color:var(--primary);text-decoration:underline;margin-left:4px">查看授权步骤 →</a>' : '');
    const link = $('btn-location-guide');
    if (link) link.onclick = (ev) => { ev.preventDefault(); showGuide('location'); };
    return;
  }

  status.className = 'location-status success';
  status.textContent = `定位成功 (精度 ${Math.round(pos.coords.accuracy)}m)，正在提交...`;

  // 地址：用户手动填写的地点优先，否则用经纬度（后端会自动补充地理编码地址）
  const note = $('input-location-note')?.value.trim() || '';
  let address = note || `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
  // 后台异步尝试获取详细地址（仅当用户未手动填写时，超时 4 秒，失败不影响打卡）
  if (!note) {
    reverseGeocode(pos.coords.latitude, pos.coords.longitude).then(addr => {
      if (addr) address = addr;
    }).catch(() => {});
  }

  try {
    const res = await fetch('/api/checkins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupCode: state.groupCode,
        userName: state.userName,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        address,
        accuracy: pos.coords.accuracy,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    status.className = 'location-status success';
    status.textContent = '✓ 打卡成功！';
    toast('打卡成功 🎉');
    loadRecords();
  } catch (e) {
    status.className = 'location-status error';
    status.textContent = '提交失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function getLocation() {
  return new Promise(async (resolve, reject) => {
    if (!window.isSecureContext) {
      return reject(new Error('当前非安全连接（非 HTTPS），浏览器禁止定位。请用 https:// 地址打开'));
    }
    if (!navigator.geolocation) return reject(new Error('浏览器不支持定位'));

    // 预检查权限状态
    let permState = 'prompt';
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const p = await navigator.permissions.query({ name: 'geolocation' });
        permState = p.state;
      }
    } catch (e) {}

    if (permState === 'denied') {
      return reject(new Error('定位权限已被拒绝。请在浏览器设置中找到本网站，将位置权限改为"允许"，然后刷新页面重试。'));
    }

    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      let msg;
      if (err.code === 1) {
        msg = '定位权限被拒绝。请点击浏览器地址栏左侧的锁/图标，将位置权限设为"允许"，然后刷新页面。';
      } else if (err.code === 2) {
        msg = '无法获取位置，请检查手机 GPS/定位服务是否已开启';
      } else if (err.code === 3) {
        msg = '定位超时，请重试（建议在室外或窗边使用）';
      } else {
        msg = err.message || '定位失败';
      }
      reject(new Error(msg));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

// 反向地理编码（OpenStreetMap Nominatim，免费）
async function reverseGeocode(lat, lng) {
  // 国内网络访问 OpenStreetMap 可能很慢，加 4 秒超时
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&accept-language=zh`,
      { signal: controller.signal }
    );
    const data = await res.json();
    return data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } catch (e) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 记录列表 ----------
async function loadRecords() {
  if (!state.groupCode) return;
  try {
    const res = await fetch('/api/groups/' + encodeURIComponent(state.groupCode) + '/checkins');
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error);
    renderRecords(rows);
  } catch (e) {
    console.error(e);
  }
}

function renderRecords(rows) {
  const list = $('records-list');
  if (!rows.length) {
    list.innerHTML = '<div class="empty">还没有打卡记录，快来第一个打卡吧！</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const initial = (r.user_name || '?').charAt(0).toUpperCase();
    const time = new Date(r.created_at).toLocaleString('zh-CN');
    const addr = r.address
      ? `<div class="record-addr">📍 ${escapeHtml(r.address)}</div>`
      : (r.lat != null ? `<div class="record-addr"><a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank">📍 ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</a></div>` : '');
    return `
      <div class="record-item">
        <div class="record-avatar">${escapeHtml(initial)}</div>
        <div class="record-body">
          <div class="record-user">${escapeHtml(r.user_name)}</div>
          <div class="record-time">${time}</div>
          ${addr}
        </div>
      </div>`;
  }).join('');
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---------- 邀请 ----------
function getInviteLink() {
  const base = location.origin + location.pathname;
  return `${base}?code=${state.groupCode}`;
}

function openInvite() {
  $('invite-code').textContent = state.groupCode;
  $('invite-link').textContent = getInviteLink();
  // 系统分享按钮
  if (navigator.share) {
    $('btn-share').classList.remove('hidden');
  } else {
    $('btn-share').classList.add('hidden');
  }
  $('invite-modal').classList.remove('hidden');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (e) {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch { toast('复制失败，请手动复制'); }
    ta.remove();
  }
}

async function shareInvite() {
  if (!navigator.share) return;
  try {
    await navigator.share({
      title: '一起打卡吧',
      text: `邀请你加入「${state.groupName}」打卡群，邀请码：${state.groupCode}`,
      url: getInviteLink(),
    });
  } catch (e) {}
}

// ---------- 打卡范围 ----------
let pendingCenter = null; // { lat, lng }

function openRangeModal() {
  pendingCenter = (state.centerLat != null) ? { lat: state.centerLat, lng: state.centerLng } : null;
  $('input-radius').value = state.radius || 200;
  updateCenterDisplay();
  $('range-modal').classList.remove('hidden');
}

function updateCenterDisplay() {
  const el = $('range-center-display');
  if (pendingCenter) {
    el.textContent = `${pendingCenter.lat.toFixed(6)}, ${pendingCenter.lng.toFixed(6)}`;
  } else {
    el.textContent = '未设置（任意位置可打卡）';
  }
}

async function useCurrentLocationAsCenter() {
  try {
    const pos = await getLocation();
    pendingCenter = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    updateCenterDisplay();
    toast('已获取当前位置');
  } catch (e) {
    toast('定位失败：' + e.message);
  }
}

function clearCenter() {
  pendingCenter = null;
  updateCenterDisplay();
}

async function saveRange() {
  const radius = parseInt($('input-radius').value, 10);
  if (isNaN(radius) || radius < 0) return toast('请输入有效的半径');
  if (radius > 0 && !pendingCenter) return toast('请先设置中心点');

  try {
    const body = { radius, userName: state.userName };
    if (pendingCenter) {
      body.center_lat = pendingCenter.lat;
      body.center_lng = pendingCenter.lng;
    } else {
      body.center_lat = null;
      body.center_lng = null;
    }
    const res = await fetch('/api/groups/' + encodeURIComponent(state.groupCode), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.centerLat = pendingCenter ? pendingCenter.lat : null;
    state.centerLng = pendingCenter ? pendingCenter.lng : null;
    state.radius = radius;
    updateRangeDisplay();
    $('range-modal').classList.add('hidden');
    toast(radius > 0 ? `打卡范围已设为 ${radius} 米` : '已取消打卡范围限制');
  } catch (e) {
    toast(e.message || '保存失败');
  }
}

// ---------- PWA 安装 ----------
async function installApp() {
  if (!deferredPrompt) {
    // 浏览器未提供原生安装提示，展示手动引导
    showGuide('install');
    return;
  }
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  if (choice.outcome === 'accepted') {
    toast('正在安装...');
  }
  deferredPrompt = null;
}

init();
