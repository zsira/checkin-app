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

// ---------- 四个固定打卡时段 ----------
// 0=早上上班卡 07:30，1=中午下班卡 12:00，2=下午上班卡 13:30，3=下午下班卡 18:00
const PUNCH_SLOTS = [
  { type: 0, short: '早上班', name: '早上上班卡', time: '07:30', icon: '🌅' },
  { type: 1, short: '午下班', name: '中午下班卡', time: '12:00', icon: '🍱' },
  { type: 2, short: '午上班', name: '下午上班卡', time: '13:30', icon: '☀️' },
  { type: 3, short: '晚下班', name: '下午下班卡', time: '18:00', icon: '🌙' },
];
function currentPunchSlot(date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes();
  if (mins < 9 * 60 + 45) return 0;
  if (mins < 12 * 60 + 45) return 1;
  if (mins < 15 * 60 + 45) return 2;
  return 3;
}
function punchSlotOf(r) {
  if (r.punch_type != null) return Number(r.punch_type);
  return currentPunchSlot(new Date(Number(r.created_at)));
}
// 上班卡标准时间：0=07:30，2=13:30；提前或延后10分钟内正常，超过记迟到；管理员补卡一律正常
const WORK_ON_STANDARD = { 0: 7 * 60 + 30, 2: 13 * 60 + 30 };
function punchLateOf(r) {
  if (r.is_makeup) return { late: false, lateMinutes: 0 };
  const slot = punchSlotOf(r);
  const standard = WORK_ON_STANDARD[slot];
  if (standard === undefined) return { late: false, lateMinutes: 0 };
  const d = new Date(Number(r.created_at));
  const diff = d.getHours() * 60 + d.getMinutes() - standard;
  return diff > 10 ? { late: true, lateMinutes: diff } : { late: false, lateMinutes: 0 };
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
function dayKeyOf(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

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

  // 推送开关按钮（进入群组后生效）
  const pushBtn = $('btn-push-toggle');
  if (pushBtn) pushBtn.onclick = enablePush;

  // 页面打开时，Service Worker 把服务端推送转发为页面内轻提示
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'server-push') {
        const p = e.data.payload || {};
        toast(p.title || '新通知');
        if ((p.tag || '').startsWith('makeup-')) {
          const id = Number(String(p.tag).replace('makeup-', ''));
          if (id) notifiedMakeupIds.add(id);
          loadRecords();
        }
        if ((p.tag || '').startsWith('rest-')) loadGroupSettings();
      }
    });
  }

  // 防截屏：禁用右键、复制、拖拽（输入框/文本域内不禁用）
  const isEditable = (el) => el && el.closest && el.closest('input, textarea, [contenteditable="true"]');
  document.addEventListener('contextmenu', e => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('copy', e => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('cut', e => { if (!isEditable(e.target)) e.preventDefault(); });
  document.addEventListener('dragstart', e => { if (!isEditable(e.target)) e.preventDefault(); });

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

  $('btn-join-group').onclick = joinGroup;

  $('btn-checkin').onclick = doCheckin;
  $('btn-refresh').onclick = () => { loadRecords(); loadLeaves(); };
  $('btn-leave').onclick = leaveGroup;
  $('btn-install').onclick = installApp;

  // 请假
  $('btn-ask-leave').onclick = openLeaveModal;
  $('btn-close-leave').onclick = () => $('leave-modal').classList.add('hidden');
  $('btn-submit-leave').onclick = submitLeave;
  $('leave-mode').onchange = () => {
    const mode = $('leave-mode').value;
    $('leave-days-box').style.display = mode === 'days' ? '' : 'none';
    $('leave-range-box').style.display = mode === 'range' ? '' : 'none';
  };

  // 每分钟刷新当前卡种显示
  updateCurrentPunch();
  setInterval(updateCurrentPunch, 60000);

  // 打卡范围
  $('btn-set-range').onclick = openRangeModal;
  $('btn-set-range2').onclick = openRangeModal;
  $('btn-close-range').onclick = () => $('range-modal').classList.add('hidden');
  $('btn-use-location').onclick = useCurrentLocationAsCenter;
  $('btn-clear-center').onclick = clearCenter;
  $('btn-save-range').onclick = saveRange;

  // 回车
  $('input-name').onkeydown = (e) => e.key === 'Enter' && $('btn-continue').click();
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
  updateCurrentPunch();
  updatePushButton();
  syncPushSubscription();
  loadRecords();
  loadLeaves();
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
    // 打卡范围由管理员统一管理，用户端不显示设置按钮
    const setRangeBtn = $('btn-set-range');
    const setRangeBtn2 = $('btn-set-range2');
    if (setRangeBtn) setRangeBtn.style.display = 'none';
    if (setRangeBtn2) setRangeBtn2.style.display = 'none';
    // 同步群组名
    if (g.name && g.name !== state.groupName) {
      state.groupName = g.name;
      localStorage.setItem('ci_group_name', g.name);
      $('group-name').textContent = g.name;
    }
    updateRangeDisplay();
    // 休息状态处理
    handleRestStatus(g.rest_until, g.rest_reason);
  } catch (e) {}
}

function handleRestStatus(restUntil, restReason) {
  const notice = $('rest-notice');
  const noticeText = $('rest-notice-text');
  const btn = $('btn-checkin');
  const until = restUntil ? Number(restUntil) : 0;
  const now = Date.now();

  if (until > now) {
    // 休息中
    const d = new Date(until);
    const timeStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    let text = `休息截止：${timeStr}`;
    if (restReason) text += `\n原因：${restReason}`;
    noticeText.textContent = text;
    noticeText.style.whiteSpace = 'pre-line';
    notice.classList.remove('hidden');
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
    btn.querySelector('.checkin-text').textContent = '休息中';
    btn.querySelector('.checkin-sub').textContent = '暂停打卡';
    // 注：后台/锁屏通知由服务端 Web Push 统一发送，页面打开时此处已有休息提示条，不重复弹通知
  } else {
    // 未休息
    notice.classList.add('hidden');
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.querySelector('.checkin-text').textContent = '点击打卡';
    btn.querySelector('.checkin-sub').textContent = '自动获取定位';
  }
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
    status.style.color = '';
    const punchName = data.punch_name || '';
    if (data.duplicated) {
      status.textContent = `✓ ${punchName}已打过卡（重复记录）${data.late ? `，迟到${data.late_minutes}分钟` : ''}`;
      toast(`${punchName}今天已打过卡`);
    } else if (data.late) {
      status.className = 'location-status';
      status.style.color = '#e65100';
      status.textContent = `⚠️ ${punchName}打卡成功，迟到 ${data.late_minutes} 分钟`;
      toast(`${punchName}迟到 ${data.late_minutes} 分钟 ⚠️`);
    } else {
      status.textContent = `✓ ${punchName} 打卡成功！`;
      toast(`${punchName}打卡成功 🎉`);
    }
    loadRecords();
  } catch (e) {
    status.className = 'location-status error';
    status.textContent = '提交失败：' + e.message;
    // 如果是休息期间错误，刷新群组设置（会禁用打卡按钮）
    if (/休息/i.test(e.message)) {
      loadGroupSettings();
    }
  } finally {
    // 休息期间保持按钮禁用
    const notice = $('rest-notice');
    if (notice && !notice.classList.contains('hidden')) {
      btn.disabled = true;
    } else {
      btn.disabled = false;
    }
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

    // 尝试高精度定位（GPS），失败后降级用网络定位
    function tryHighAccuracy() {
      navigator.geolocation.getCurrentPosition(resolve, (err) => {
        if (err.code === 1) {
          return reject(new Error('定位权限被拒绝。请点击浏览器地址栏左侧的锁/图标，将位置权限设为"允许"，然后刷新页面。'));
        }
        // 高精度失败，降级用网络定位
        tryLowAccuracy();
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    }

    function tryLowAccuracy() {
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
      }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 30000 });
    }

    tryHighAccuracy();
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
let myRecords = [];

async function loadRecords() {
  if (!state.groupCode) return;
  try {
    // 仅获取当前用户自己的打卡记录
    const res = await fetch('/api/groups/' + encodeURIComponent(state.groupCode) + '/checkins?user_name=' + encodeURIComponent(state.userName));
    const rows = await res.json();
    if (!res.ok) throw new Error(rows.error);
    myRecords = rows;
    renderRecords(rows);
    renderPunchProgress(rows);
    detectNewMakeup(rows);
  } catch (e) {
    console.error(e);
  }
}

// ---------- 管理员补卡推送 ----------
let knownMakeupIds = null;
let notifiedMakeupIds = new Set();
let makeupPollTimer = null;

function startMakeupPolling() {
  if (makeupPollTimer) return;
  makeupPollTimer = setInterval(() => {
    // 仅在已进入群组且主页可见时轮询
    const mainView = document.getElementById('view-main');
    if (state.groupCode && (!mainView || !mainView.classList.contains('hidden'))) {
      loadRecords(true);
    }
  }, 30000);
}

function detectNewMakeup(rows) {
  const makeupRows = rows.filter(r => r.is_makeup);
  if (knownMakeupIds === null) {
    // 首次加载只建立基线，不推送历史补卡
    knownMakeupIds = new Set(makeupRows.map(r => r.id));
    startMakeupPolling();
    return;
  }
  const fresh = makeupRows.filter(r => !knownMakeupIds.has(r.id));
  fresh.forEach(r => {
    knownMakeupIds.add(r.id);
    // 服务端推送（SW）已提示过的不重复弹；未走推送通道时用轮询兜底提示
    if (!notifiedMakeupIds.has(r.id)) {
      notifiedMakeupIds.add(r.id);
      toast('🔧 收到一条管理员补卡记录');
    }
  });
}

// ---------- Web Push 后台推送 ----------
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// 详细诊断当前环境，返回各项能力与失败原因
function diagnosePushEnv() {
  const d = {
    isSecure: location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1',
    sw: 'serviceWorker' in navigator,
    push: 'PushManager' in window,
    notification: 'Notification' in window,
    permission: ('Notification' in window) ? Notification.permission : 'unsupported',
    isStandalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true,
    ua: navigator.userAgent,
  };
  // 常见国产/不完整支持浏览器识别
  d.browserHint = (() => {
    const ua = d.ua;
    if (/; wv\)/.test(ua)) return 'webview'; // 微信/QQ/应用内 WebView
    if (/MicroMessenger/i.test(ua)) return 'wechat';
    if (/QQBrowser|MQQBrowser/i.test(ua)) return 'qqbrowser';
    if (/UCBrowser/i.test(ua)) return 'uc';
    if (/MiuiBrowser/i.test(ua)) return 'mi';
    if (/HeyTap|OPPO|ColorOS/i.test(ua)) return 'oppo';
    if (/VivoBrowser|vivo/i.test(ua)) return 'vivo';
    if (/HuaweiBrowser|HONOR/i.test(ua)) return 'huawei';
    if (/Baidu|BIDUBrowser/i.test(ua)) return 'baidu';
    if (/SamsungBrowser/i.test(ua)) return 'samsung';
    if (/Chrome\//i.test(ua) && !/Edg|OPR|Vivo|Miui|HeyTap|Huawei|UCBrowser|QQBrowser/i.test(ua)) return 'chrome';
    if (/^((?!chrome|android).)*safari/i.test(ua)) return 'safari';
    return 'other';
  })();
  return d;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

// 已授权时自动（重新）注册并绑定当前群组+人员；返回 {ok, stage, error}
async function syncPushSubscription() {
  if (!('Notification' in window)) return { ok: false, stage: '环境检测', error: '浏览器不支持通知' };
  if (Notification.permission !== 'granted') return { ok: false, stage: '通知权限', error: '权限状态：' + Notification.permission };
  if (!state.groupCode || !state.userName) return { ok: false, stage: '登录状态', error: '请先进入群组' };
  if (!('serviceWorker' in navigator)) return { ok: false, stage: '环境检测', error: '浏览器不支持 Service Worker（网页后台推送的必要能力）' };
  if (!('PushManager' in window)) return { ok: false, stage: '环境检测', error: '浏览器不支持 PushManager（推送服务未接入）' };
  let reg, keyRes, key, sub, upRes;
  try {
    try {
      reg = await navigator.serviceWorker.ready;
    } catch (e) { return { ok: false, stage: '注册后台服务', error: e.message || String(e) }; }
    try {
      keyRes = await fetch('/api/push/vapid-key');
      const data = await keyRes.json();
      key = data.key;
    } catch (e) { return { ok: false, stage: '获取推送密钥', error: e.message || String(e) }; }
    if (!key) return { ok: false, stage: '获取推送密钥', error: '服务器未返回推送密钥（服务端可能未完成初始化，请稍后刷新重试）' };
    try {
      sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
      }
    } catch (e) {
      const name = e.name || '';
      let hint = e.message || String(e);
      if (name === 'NotAllowedError') hint = '订阅被拒绝（通知权限可能仅对当前会话有效，请关闭网页重新进入，或重装/更换浏览器）';
      if (name === 'AbortError') hint = '浏览器推送服务不可用（常见于 vivo/OPPO/小米/华为/UC/QQ 等自带浏览器，需改用 Chrome）';
      return { ok: false, stage: '向浏览器申请推送通道', error: hint };
    }
    try {
      upRes = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub, scope: 'user', group_code: state.groupCode, user_name: state.userName }),
      });
      if (!upRes.ok) {
        const t = await upRes.text().catch(() => '');
        return { ok: false, stage: '登记到服务器', error: 'HTTP ' + upRes.status + ' ' + t };
      }
    } catch (e) { return { ok: false, stage: '登记到服务器', error: e.message || String(e) }; }
    updatePushButton();
    return { ok: true };
  } catch (e) {
    return { ok: false, stage: '未知步骤', error: e.message || String(e) };
  }
}

async function enablePush() {
  // 先做环境体检
  const env = diagnosePushEnv();
  if (!env.sw || !env.push || !env.notification) {
    showPushDiag(env, null);
    return;
  }
  try {
    let perm = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; }
    }
    if (perm !== 'granted') {
      showPushHelp(env);
      updatePushButton();
      return;
    }
    const r = await syncPushSubscription();
    if (r.ok) {
      toast('🔔 已开启后台推送，锁屏或关闭页面也能收到通知');
    } else {
      showPushDiag(env, r);
    }
    updatePushButton();
  } catch (e) {
    showPushDiag(env, { ok: false, stage: '未知', error: e.message || String(e) });
  }
}

const BROWSER_NAME = {
  wechat: '微信内置浏览器', qqbrowser: 'QQ 浏览器', uc: 'UC 浏览器', mi: '小米/MIUI 浏览器',
  oppo: 'OPPO/一加 浏览器', vivo: 'vivo 浏览器', huawei: '华为/荣耀浏览器', baidu: '百度浏览器',
  samsung: '三星浏览器', chrome: 'Chrome', safari: 'Safari', webview: '应用内置 WebView', other: '当前浏览器',
};

function showPushDiag(env, result) {
  let mask = document.getElementById('push-help-mask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'push-help-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(mask);
  }
  const bname = BROWSER_NAME[env.browserHint] || '当前浏览器';
  const isLimited = ['wechat', 'qqbrowser', 'uc', 'mi', 'oppo', 'vivo', 'huawei', 'baidu', 'webview'].includes(env.browserHint);
  const failLine = result
    ? `<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:10px;padding:10px 12px;margin:10px 0;font-size:13px;color:#bf360c">
         <b>失败环节：</b>${result.stage}<br><b>原因：</b>${result.error}
       </div>`
    : '';
  mask.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:430px;width:100%;max-height:90vh;overflow-y:auto;padding:22px 20px">
      <div style="font-size:18px;font-weight:700;margin-bottom:6px">🔔 推送无法开启</div>
      <div style="font-size:13px;color:#888;margin-bottom:8px">检测到：${bname}${env.isStandalone ? '（主屏幕模式）' : ''}</div>
      <div style="font-size:13px;line-height:1.9">
        HTTPS 安全连接：${env.isSecure ? '✅' : '❌'}<br>
        通知能力：${env.notification ? '✅' : '❌'}<br>
        后台服务能力：${env.sw ? '✅' : '❌'}<br>
        <b>推送通道（PushManager）：${env.push ? '✅' : '❌ 不支持'}</b><br>
        通知权限：${env.permission === 'granted' ? '✅ 已允许' : env.permission === 'denied' ? '❌ 已拒绝' : '➖ 未授权'}
      </div>
      ${failLine}
      <div style="font-size:14px;line-height:1.7;color:#333;margin-top:12px">
        ${(!env.push || (result && result.stage === '向浏览器申请推送通道')) ? `
          <b style="color:#e65100">这是浏览器限制，不是设置问题。</b><br>
          ${bname}没有接入网页推送服务，即使打开通知权限也无法后台推送。请按以下顺序尝试：<br><br>
          <b>① 使用 Chrome 浏览器</b>（最可靠）<br>
          复制本站网址，用 <b>Chrome</b> 打开，登录后点「🔔 开启打卡推送提醒」。<br>
          <span style="color:#888;font-size:12px">注：华为等无谷歌服务的手机，Chrome 推送也可能不可用。</span><br><br>
          <b>② 添加到主屏幕</b><br>
          在 Chrome 菜单中选择「添加到主屏幕 / 安装应用」，从桌面图标进入后再开启。<br><br>
          <b>③ 兜底方式</b><br>
          保持打卡页面在后台打开，应用每 30 秒自动刷新一次，补卡等消息仍会在页面内提示。
        ` : `
          <b style="color:#4f46e5">请先允许通知权限：</b><br>
          点网址左边的 <b>🔒 小锁图标</b> → 权限/网站设置 → 通知 → <b>允许</b>，然后关闭本弹窗再点一次开启按钮。<br><br>
          若仍失败，请尝试用 Chrome 打开本站。
        `}
      </div>
      <button id="push-help-close" style="margin-top:16px;width:100%;padding:12px;border:none;border-radius:10px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600">我知道了</button>
    </div>`;
  mask.classList.remove('hidden');
  mask.onclick = (e) => { if (e.target === mask || e.target.id === 'push-help-close') mask.classList.add('hidden'); };
}

// 兼容旧调用：仅权限问题时展示帮助
function showPushHelp(env) {
  showPushDiag(env || diagnosePushEnv(), null);
}

function updatePushButton() {
  const btn = $('btn-push-toggle');
  if (!btn) return;
  if (!pushSupported()) {
    btn.textContent = '🔕 设备不支持后台推送';
    btn.disabled = true;
    btn.style.opacity = '0.55';
    return;
  }
  btn.disabled = false;
  btn.style.opacity = '';
  if (Notification.permission === 'granted') btn.textContent = '🔔 推送提醒已开启';
  else if (Notification.permission === 'denied') btn.textContent = '🔕 通知被禁用（点此查看帮助）';
  else btn.textContent = '🔔 开启打卡推送提醒';
}

// 顶部显示当前应打卡种
function updateCurrentPunch() {
  const box = $('current-punch');
  if (!box) return;
  // 仅在主页可见时更新
  const mainView = document.getElementById('view-main');
  if (mainView && mainView.classList.contains('hidden')) return;
  const slot = PUNCH_SLOTS[currentPunchSlot()];
  box.innerHTML = `当前应打：<span style="color:#e67e22">${slot.icon} ${slot.name}（${slot.time}）</span>`;
}

// 今日四次打卡进度
function renderPunchProgress(rows) {
  const box = $('punch-progress');
  if (!box) return;
  const tk = todayKey();
  const done = new Set();
  const late = new Set();
  rows.forEach(r => {
    if (dayKeyOf(r.created_at) === tk) {
      done.add(punchSlotOf(r));
      if (punchLateOf(r).late) late.add(punchSlotOf(r));
    }
  });
  box.innerHTML = PUNCH_SLOTS.map(s => {
    const ok = done.has(s.type);
    const isLate = late.has(s.type);
    const bg = isLate ? '#fff3e0' : (ok ? '#e8f5e9' : '#f5f5f5');
    const fg = isLate ? '#e65100' : (ok ? '#2e7d32' : '#999');
    const bd = isLate ? '#ffcc80' : (ok ? '#a5d6a7' : '#eee');
    const icon = isLate ? '⚠️' : (ok ? '✅' : s.icon);
    return `<div style="flex:1;text-align:center;padding:8px 2px;border-radius:10px;font-size:12px;background:${bg};color:${fg};border:1px solid ${bd}">
      <div style="font-size:16px">${icon}</div>
      <div style="margin-top:2px;font-weight:600">${s.short}${isLate ? '<br>迟到' : ''}</div>
      <div>${s.time}</div>
    </div>`;
  }).join('');
}

function renderRecords(rows) {
  const list = $('records-list');
  if (!rows.length) {
    list.innerHTML = '<div class="empty">还没有打卡记录，快来第一个打卡吧！</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const initial = (r.user_name || '?').charAt(0).toUpperCase();
    const time = new Date(Number(r.created_at)).toLocaleString('zh-CN');
    const slot = PUNCH_SLOTS[punchSlotOf(r)];
    const lateInfo = punchLateOf(r);
    const slotTag = `<span style="display:inline-block;background:#eef2ff;color:#4f46e5;border-radius:8px;padding:1px 7px;font-size:12px;margin-right:6px">${slot.icon} ${slot.name}</span>`;
    const lateTag = lateInfo.late
      ? `<span style="display:inline-block;background:#fff3e0;color:#e65100;border:1px solid #ffcc80;border-radius:8px;padding:0 7px;font-size:12px;margin-right:6px;font-weight:600">⚠️ 迟到${lateInfo.lateMinutes}分钟</span>`
      : '';
    const makeupTag = r.is_makeup
      ? `<span style="display:inline-block;background:#e0f7fa;color:#0277bd;border:1px solid #80deea;border-radius:8px;padding:0 7px;font-size:12px;margin-right:6px;font-weight:600">🔧 补卡·正常</span>`
      : '';
    const addr = r.is_makeup
      ? `<div class="record-addr">🔧 管理员补卡${r.makeup_reason ? ' · ' + escapeHtml(r.makeup_reason) : ''}</div>`
      : (r.address
        ? `<div class="record-addr">📍 ${escapeHtml(r.address)}</div>`
        : (r.lat != null ? `<div class="record-addr"><a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank">📍 ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</a></div>` : ''));
    return `
      <div class="record-item"${r.is_makeup ? ' style="border-left:3px solid #0277bd;background:#f5fcfe"' : ''}>
        <div class="record-avatar">${escapeHtml(initial)}</div>
        <div class="record-body">
          <div class="record-user">${slotTag}${lateTag}${makeupTag}${escapeHtml(r.user_name)}</div>
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

// ---------- 请假 ----------
function fmtLeaveTs(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function openLeaveModal() {
  $('leave-mode').value = 'days';
  $('leave-days').value = '1';
  $('leave-reason').value = '';
  $('leave-start').value = '';
  $('leave-end').value = '';
  $('leave-days-box').style.display = '';
  $('leave-range-box').style.display = 'none';
  $('leave-modal').classList.remove('hidden');
}

async function submitLeave() {
  let startTs, endTs;
  const mode = $('leave-mode').value;
  const reason = $('leave-reason').value.trim();
  if (mode === 'days') {
    const days = parseFloat($('leave-days').value);
    if (!days || days <= 0) { alert('请输入有效的请假天数'); return; }
    startTs = Date.now();
    endTs = startTs + days * 86400000;
  } else {
    const s = $('leave-start').value, e = $('leave-end').value;
    if (!s || !e) { alert('请选择开始和结束时间'); return; }
    startTs = new Date(s).getTime();
    endTs = new Date(e).getTime();
    if (endTs <= startTs) { alert('结束时间必须晚于开始时间'); return; }
  }
  try {
    const res = await fetch('/api/leaves', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: state.groupCode, userName: state.userName, start_ts: startTs, end_ts: endTs, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    $('leave-modal').classList.add('hidden');
    toast('请假申请已提交 📝');
    loadLeaves();
  } catch (e) {
    alert(e.message);
  }
}

async function loadLeaves() {
  const box = $('leave-status');
  if (!box) return;
  try {
    const res = await fetch('/api/leaves?groupCode=' + encodeURIComponent(state.groupCode) + '&userName=' + encodeURIComponent(state.userName));
    const rows = await res.json();
    if (!res.ok) return;
    const now = Date.now();
    const active = rows.filter(r => Number(r.end_ts) > now);
    if (!active.length) { box.innerHTML = ''; return; }
    box.innerHTML = active.map(r => {
      const days = Math.ceil((Number(r.end_ts) - Number(r.start_ts)) / 86400000);
      return `<div style="background:#fff3e0;border:1px solid #ffe0b2;border-radius:8px;padding:8px 10px;margin-bottom:6px;color:#e65100">
        📝 请假中：${fmtLeaveTs(r.start_ts)} ~ ${fmtLeaveTs(r.end_ts)}（${days}天）${r.reason ? ' · ' + escapeHtml(r.reason) : ''}
      </div>`;
    }).join('');
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
