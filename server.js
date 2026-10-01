const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 代理（沙箱环境需要，生产环境可留空）
const proxyAgent = (process.env.HTTPS_PROXY || process.env.https_proxy)
  ? new HttpsProxyAgent(process.env.HTTPS_PROXY || process.env.https_proxy)
  : null;

app.use(express.json());

// manifest.json 用正确的 content-type，确保 PWA 可安装
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 数据库初始化 ----------
const dbPath = process.env.DB_PATH || path.join(__dirname, 'checkin.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    center_lat REAL,
    center_lng REAL,
    radius INTEGER DEFAULT 0,
    creator TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    lat REAL,
    lng REAL,
    address TEXT,
    accuracy REAL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (group_id) REFERENCES groups(id)
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_group ON checkins(group_id);
  CREATE INDEX IF NOT EXISTS idx_checkins_time ON checkins(created_at);
`);

// 迁移：为旧表添加字段（不存在时）
function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}
addColumnIfMissing('groups', 'center_lat', 'REAL');
addColumnIfMissing('groups', 'center_lng', 'REAL');
addColumnIfMissing('groups', 'radius', 'INTEGER DEFAULT 0');
addColumnIfMissing('groups', 'creator', 'TEXT');

// 管理员设置表（存储密码等配置）
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// 管理员账号表（支持多管理员）
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_super INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);
// 初始化超级管理员
const envPassword = process.env.ADMIN_PASSWORD;
const superPwd = envPassword || 'admin123';
const superAdmin = db.prepare('SELECT id FROM admins WHERE is_super = 1').get();
if (!superAdmin) {
  db.prepare('INSERT INTO admins (username, password, is_super, created_at) VALUES (?, ?, 1, ?)')
    .run('admin', superPwd, Date.now());
}
// 兼容旧密码配置
if (envPassword) {
  db.prepare('UPDATE admins SET password = ? WHERE is_super = 1').run(envPassword);
}
function verifyAdmin(username, password) {
  const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!row || row.password !== password) return null;
  return row;
}

// 为群组表添加打卡时间配置字段
addColumnIfMissing('groups', 'checkin_times', 'TEXT');

// ---------- 工具函数 ----------
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function now() { return Date.now(); }

// Haversine 距离（米）
function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 反向地理编码
// 优先级：高德地图(AMAP_KEY) > 天地图(TIANDITU_KEY) > BigDataCloud(免key)
const AMAP_KEY = process.env.AMAP_KEY || '';
const TIANDITU_KEY = process.env.TIANDITU_KEY || '';

function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    if (lat == null || lng == null) return resolve(null);

    // 1. 高德地图（精确到街道/门牌号/POI）
    if (AMAP_KEY) {
      const url = `https://restapi.amap.com/v3/geocode/regeo?key=${AMAP_KEY}&location=${lng},${lat}&extensions=base&output=json`;
      https.get(url, { agent: proxyAgent, timeout: 6000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.status === '1' && j.regeocode) return resolve(j.regeocode.formatted_address || null);
          } catch {}
          resolve(null);
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
      return;
    }

    // 2. 天地图（国家平台，个人可注册免费，精确到街道）
    if (TIANDITU_KEY) {
      const ds = JSON.stringify({ lon: lng, lat: lat, ver: 1 });
      const url = `https://api.tianditu.gov.cn/geocoder?ds=${encodeURIComponent(ds)}&tk=${TIANDITU_KEY}`;
      https.get(url, { agent: proxyAgent, timeout: 6000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.status === '0' && j.result) return resolve(j.result.formatted_address || null);
          } catch {}
          resolve(null);
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
      return;
    }

    // 3. 降级：BigDataCloud（免 key，省/市/镇级）
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=zh`;
    https.get(url, { agent: proxyAgent, timeout: 6000, headers: { 'User-Agent': 'checkin-app/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const parts = [j.principalSubdivision, j.city, j.locality].filter(Boolean);
          resolve(parts.join(' ') || null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

// ---------- 登录认证 ----------
// token -> 管理员信息
const validTokens = new Map();

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  // 兼容旧版：只传密码时用 admin 账号
  const uname = username || 'admin';
  const admin = verifyAdmin(uname, password);
  if (!admin) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, { id: admin.id, username: admin.username, is_super: admin.is_super });
  res.json({ token, username: admin.username, is_super: admin.is_super });
});

// 修改当前管理员密码
app.put('/api/admin/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const admin = req.admin;
  const row = db.prepare('SELECT password FROM admins WHERE id = ?').get(admin.id);
  if (!row || row.password !== oldPassword) return res.status(401).json({ error: '旧密码错误' });
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(newPassword, admin.id);
  // 清除当前 token
  validTokens.delete(req.token);
  res.json({ ok: true });
});

// 管理员列表（仅超级管理员）
app.get('/api/admin/admins', auth, (req, res) => {
  if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
  const rows = db.prepare('SELECT id, username, is_super, created_at FROM admins ORDER BY is_super DESC, id').all();
  res.json(rows);
});

// 添加管理员（仅超级管理员）
app.post('/api/admin/admins', auth, (req, res) => {
  if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
  const { username, password } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: '用户名不能为空' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  try {
    db.prepare('INSERT INTO admins (username, password, is_super, created_at) VALUES (?, ?, 0, ?)')
      .run(username.trim(), password, Date.now());
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: '创建失败' });
  }
});

// 删除管理员（仅超级管理员，不能删自己）
app.delete('/api/admin/admins/:id', auth, (req, res) => {
  if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
  const id = parseInt(req.params.id);
  if (id === req.admin.id) return res.status(400).json({ error: '不能删除自己' });
  const target = db.prepare('SELECT is_super FROM admins WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: '管理员不存在' });
  if (target.is_super) return res.status(400).json({ error: '不能删除超级管理员' });
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  res.json({ ok: true });
});

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  const admin = validTokens.get(token);
  if (!admin) return res.status(401).json({ error: '未登录' });
  req.admin = admin;
  req.token = token;
  next();
}

// ---------- 群组 API ----------
app.post('/api/groups', (req, res) => {
  const { name, userName } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: '请输入群组名称' });
  let code, existing;
  do { code = genCode(); existing = db.prepare('SELECT id FROM groups WHERE code = ?').get(code); } while (existing);
  const creator = (userName || '').trim() || null;
  const info = db.prepare(
    'INSERT INTO groups (code, name, creator, created_at) VALUES (?, ?, ?, ?)'
  ).run(code, name.trim(), creator, now());
  res.json({ id: info.lastInsertRowid, code, name: name.trim(), creator, center_lat: null, center_lng: null, radius: 0 });
});

app.get('/api/groups/:code', (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(req.params.code);
  if (!group) return res.status(404).json({ error: '群组不存在' });
  try { group.checkin_times = JSON.parse(group.checkin_times || '[]'); } catch { group.checkin_times = []; }
  res.json(group);
});

// 设置打卡范围（仅群组创建者或管理员可修改）
app.patch('/api/groups/:code', (req, res) => {
  const { center_lat, center_lng, radius, userName } = req.body || {};
  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(req.params.code);
  if (!group) return res.status(404).json({ error: '群组不存在' });

  // 权限校验：只有群组创建者能修改（创建者为空时兼容旧群组，允许修改）
  if (group.creator && group.creator !== (userName || '').trim()) {
    // 检查是否为管理员
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) {
      return res.status(403).json({ error: '只有群主（创建者）才能修改打卡范围' });
    }
  }

  if (radius != null && (isNaN(radius) || radius < 0 || radius > 100000)) {
    return res.status(400).json({ error: '半径需在 0-100000 米之间' });
  }
  if (center_lat != null && center_lng != null) {
    if (isNaN(center_lat) || isNaN(center_lng) || center_lat < -90 || center_lat > 90 || center_lng < -180 || center_lng > 180) {
      return res.status(400).json({ error: '经纬度不合法' });
    }
  }
  db.prepare(
    'UPDATE groups SET center_lat = ?, center_lng = ?, radius = ? WHERE code = ?'
  ).run(center_lat ?? null, center_lng ?? null, radius ?? 0, req.params.code);
  res.json({ ok: true });
});

// ---------- 打卡 API ----------
app.post('/api/checkins', (req, res) => {
  const { groupCode, userName, lat, lng, address, accuracy } = req.body || {};
  if (!groupCode || !userName) return res.status(400).json({ error: '缺少参数' });
  const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(groupCode);
  if (!group) return res.status(404).json({ error: '群组不存在' });

  // 范围校验
  if (group.radius > 0 && group.center_lat != null && group.center_lng != null && lat != null && lng != null) {
    const dist = distance(lat, lng, group.center_lat, group.center_lng);
    if (dist > group.radius) {
      return res.status(403).json({
        error: `超出打卡范围（当前距离中心 ${Math.round(dist)} 米，允许范围 ${group.radius} 米）`,
        distance: Math.round(dist),
        radius: group.radius
      });
    }
  }

  // 打卡时间校验
  try {
    const times = JSON.parse(group.checkin_times || '[]');
    if (times.length > 0) {
      const now = new Date();
      const curMins = now.getHours() * 60 + now.getMinutes();
      const inWindow = times.some(t => {
        const [sh, sm] = (t.start || '00:00').split(':').map(Number);
        const [eh, em] = (t.end || '23:59').split(':').map(Number);
        const startMins = sh * 60 + sm;
        const endMins = eh * 60 + em;
        return curMins >= startMins && curMins <= endMins;
      });
      if (!inWindow) {
        const windows = times.map(t => `${t.start}-${t.end}`).join('、');
        return res.status(403).json({ error: `不在打卡时间内，允许打卡时段：${windows}` });
      }
    }
  } catch (e) {}

  // 先用前端传来的地址，立即返回不阻塞
  // 判断是否为经纬度格式（用户未手动填写地点）
  const isCoord = /^\-?\d+\.\d+,\s*\-?\d+\.\d+$/.test(address || '');
  const displayAddr = (address && !isCoord) ? address : `${lat?.toFixed(5)}, ${lng?.toFixed(5)}`;
  const info = db.prepare(
    `INSERT INTO checkins (group_id, user_name, lat, lng, address, accuracy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(group.id, userName.trim(), lat ?? null, lng ?? null, displayAddr, accuracy ?? null, now());
  const checkin = db.prepare('SELECT * FROM checkins WHERE id = ?').get(info.lastInsertRowid);
  res.json(checkin);

  // 后台异步获取详细地址并更新（仅当用户未手动填写地点时）
  if (isCoord && lat != null && lng != null) {
    reverseGeocode(lat, lng).then(addr => {
      if (addr) {
        db.prepare('UPDATE checkins SET address = ? WHERE id = ?').run(addr, info.lastInsertRowid);
      }
    }).catch(() => {});
  }
});

app.get('/api/groups/:code/checkins', (req, res) => {
  const group = db.prepare('SELECT id FROM groups WHERE code = ?').get(req.params.code);
  if (!group) return res.status(404).json({ error: '群组不存在' });
  const rows = db.prepare('SELECT * FROM checkins WHERE group_id = ? ORDER BY created_at DESC').all(group.id);
  res.json(rows);
});

// ---------- 后台 API（需认证） ----------
app.get('/api/admin/groups', auth, (req, res) => {
  const groups = db.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM checkins c WHERE c.group_id = g.id) AS checkin_count
     FROM groups g ORDER BY g.created_at DESC`
  ).all();
  groups.forEach(g => {
    try { g.checkin_times = JSON.parse(g.checkin_times || '[]'); } catch { g.checkin_times = []; }
  });
  res.json(groups);
});

// 成员打卡统计（按群组、按天，4次打卡=1天）
app.get('/api/admin/stats/members', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.user_name, g.name AS group_name, g.code AS group_code, c.created_at
     FROM checkins c JOIN groups g ON c.group_id = g.id
     ORDER BY c.created_at DESC`
  ).all();
  // 按 群组+用户+日期 分组，统计每天打卡次数
  const dayKey = (ts) => new Date(ts).toLocaleDateString('zh-CN');
  const map = new Map(); // key: group|user -> { name, group, days: Set, totalCheckins }
  rows.forEach(r => {
    const key = r.group_code + '|' + r.user_name;
    if (!map.has(key)) {
      map.set(key, { user_name: r.user_name, group_name: r.group_name, group_code: r.group_code, days: new Map(), totalCheckins: 0, first: r.created_at, last: r.created_at });
    }
    const p = map.get(key);
    const dk = dayKey(r.created_at);
    p.days.set(dk, (p.days.get(dk) || 0) + 1);
    p.totalCheckins++;
    if (r.created_at < p.first) p.first = r.created_at;
    if (r.created_at > p.last) p.last = r.created_at;
  });
  // 打卡天数：每天打卡 >= 4 次才算 1 天
  const result = Array.from(map.values()).map(p => {
    const fullDays = Array.from(p.days.values()).filter(c => c >= 4).length;
    const checkinDays = p.days.size; // 实际打卡的天数
    return {
      user_name: p.user_name,
      group_name: p.group_name,
      group_code: p.group_code,
      total_checkins: p.totalCheckins,
      checkin_days: checkinDays,
      full_days: fullDays, // 满4次的天数
      first_checkin: p.first,
      last_checkin: p.last,
    };
  });
  res.json(result);
});

app.get('/api/admin/checkins', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, g.code AS group_code, g.name AS group_name
     FROM checkins c JOIN groups g ON c.group_id = g.id
     ORDER BY c.created_at DESC LIMIT 500`
  ).all();
  res.json(rows);
});

app.delete('/api/admin/checkins/:id', auth, (req, res) => {
  db.prepare('DELETE FROM checkins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 编辑打卡记录（用户名、地址）
app.put('/api/admin/checkins/:id', auth, (req, res) => {
  const { user_name, address } = req.body;
  const fields = [];
  const values = [];
  if (user_name !== undefined) { fields.push('user_name = ?'); values.push(user_name); }
  if (address !== undefined) { fields.push('address = ?'); values.push(address); }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  values.push(req.params.id);
  db.prepare(`UPDATE checkins SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// 编辑群组信息（名称、中心点、范围、打卡时间）
app.put('/api/admin/groups/:id', auth, (req, res) => {
  const { name, center_lat, center_lng, radius, creator, checkin_times } = req.body;
  const fields = [];
  const values = [];
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (center_lat !== undefined) { fields.push('center_lat = ?'); values.push(center_lat); }
  if (center_lng !== undefined) { fields.push('center_lng = ?'); values.push(center_lng); }
  if (radius !== undefined) { fields.push('radius = ?'); values.push(radius); }
  if (creator !== undefined) { fields.push('creator = ?'); values.push(creator); }
  if (checkin_times !== undefined) { fields.push('checkin_times = ?'); values.push(JSON.stringify(checkin_times || [])); }
  if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
  values.push(req.params.id);
  db.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// 导出 CSV（Excel 可直接打开）
app.get('/api/admin/export', auth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.created_at, c.user_name, g.name AS group_name, g.code AS group_code,
            c.lat, c.lng, c.address, c.accuracy
     FROM checkins c JOIN groups g ON c.group_id = g.id
     ORDER BY c.created_at DESC`
  ).all();

  const headers = ['时间', '用户', '群组', '邀请码', '纬度', '经度', '地址', '精度(米)'];
  const escapeCsv = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      new Date(r.created_at).toLocaleString('zh-CN'),
      r.user_name, r.group_name, r.group_code,
      r.lat ?? '', r.lng ?? '', r.address ?? '', r.accuracy ?? ''
    ].map(escapeCsv).join(','));
  }
  // 加 BOM 让 Excel 正确识别 UTF-8 中文
  const csv = '\uFEFF' + lines.join('\n');
  const filename = `打卡记录_${new Date().toISOString().slice(0, 10)}.csv`;
  // HTTP 头不允许非 ASCII，用 RFC 5987 编码中文文件名
  const encodedName = encodeURIComponent(filename);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="checkin.csv"; filename*=UTF-8''${encodedName}`);
  res.send(csv);
});

// ---------- 启动 ----------
// HTTP 服务器（localhost 可用；手机需用 HTTPS）
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP]  打卡应用: http://localhost:${PORT}`);
});

// HTTPS 服务器（手机定位 + 安装到桌面必须用 HTTPS）
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  https.createServer(options, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[HTTPS] 打卡应用: https://localhost:${HTTPS_PORT}`);
    console.log(`[HTTPS] 管理后台: https://localhost:${HTTPS_PORT}/admin.html`);
    console.log(`[提示] 手机访问请用 HTTPS 地址，首次会提示证书不安全，点"高级/继续访问"即可`);
    console.log(`后台默认密码: ${ADMIN_PASSWORD}（可通过环境变量 ADMIN_PASSWORD 修改）`);
    console.log(AMAP_KEY
      ? `[地理编码] 高德地图已启用（精确到街道/公司）`
      : TIANDITU_KEY
        ? `[地理编码] 天地图已启用（精确到街道）`
        : `[地理编码] BigDataCloud（镇级）。设置 AMAP_KEY 或 TIANDITU_KEY 可获取精确地址`);
  });
} else {
  console.log('[警告] 未找到证书文件，HTTPS 未启动。手机端定位和安装功能需要 HTTPS。');
  console.log(`后台默认密码: ${ADMIN_PASSWORD}`);
  console.log(AMAP_KEY || TIANDITU_KEY
    ? `[地理编码] 已启用`
    : `[地理编码] BigDataCloud（镇级）。设置 AMAP_KEY 或 TIANDITU_KEY 可获取精确地址`);
}
