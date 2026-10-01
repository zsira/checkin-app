const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 代理（沙箱环境需要，生产环境可留空）
// https-proxy-agent v9 是 ESM-only，需动态导入
let proxyAgent = null;
(async () => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    try {
      const mod = await import('https-proxy-agent');
      proxyAgent = new mod.HttpsProxyAgent(proxyUrl);
    } catch (e) {
      console.error('[代理] 加载 https-proxy-agent 失败:', e.message);
    }
  }
})();

app.use(express.json());

// manifest.json 用正确的 content-type，确保 PWA 可安装
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 数据库初始化 (PostgreSQL) ----------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[错误] 未设置 DATABASE_URL 环境变量，无法连接 PostgreSQL。');
  console.error('请在 Railway 环境变量中设置 DATABASE_URL 为 Supabase 的连接串。');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

// 建表（PostgreSQL 语法）
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      center_lat DOUBLE PRECISION,
      center_lng DOUBLE PRECISION,
      radius INTEGER DEFAULT 0,
      creator TEXT,
      checkin_times TEXT DEFAULT '[]',
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      address TEXT,
      accuracy DOUBLE PRECISION,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkins_group ON checkins(group_id);
    CREATE INDEX IF NOT EXISTS idx_checkins_time ON checkins(created_at);
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_super BOOLEAN DEFAULT false,
      created_at BIGINT NOT NULL
    );
  `);

  // 初始化超级管理员
  const envPassword = process.env.ADMIN_PASSWORD;
  const superPwd = envPassword || 'admin123';
  const superAdmin = await pool.query('SELECT id FROM admins WHERE is_super = true');
  if (superAdmin.rows.length === 0) {
    await pool.query(
      'INSERT INTO admins (username, password, is_super, created_at) VALUES ($1, $2, true, $3)',
      ['admin', superPwd, Date.now()]
    );
  }
  // 兼容旧密码配置
  if (envPassword) {
    await pool.query('UPDATE admins SET password = $1 WHERE is_super = true', [envPassword]);
  }

  console.log('[数据库] PostgreSQL 连接成功，表结构已就绪');
}

initDb().catch(err => {
  console.error('[数据库] 初始化失败:', err.message);
});

async function verifyAdmin(username, password) {
  const res = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  const row = res.rows[0];
  if (!row || row.password !== password) return null;
  return row;
}

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
const validTokens = new Map();

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const uname = username || 'admin';
    const admin = await verifyAdmin(uname, password);
    if (!admin) return res.status(401).json({ error: '用户名或密码错误' });
    const token = crypto.randomBytes(32).toString('hex');
    validTokens.set(token, { id: admin.id, username: admin.username, is_super: admin.is_super });
    res.json({ token, username: admin.username, is_super: admin.is_super });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// 修改当前管理员密码
app.put('/api/admin/password', auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const admin = req.admin;
    const row = await pool.query('SELECT password FROM admins WHERE id = $1', [admin.id]);
    if (row.rows.length === 0 || row.rows[0].password !== oldPassword) return res.status(401).json({ error: '旧密码错误' });
    await pool.query('UPDATE admins SET password = $1 WHERE id = $2', [newPassword, admin.id]);
    validTokens.delete(req.token);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 管理员列表（仅超级管理员）
app.get('/api/admin/admins', auth, async (req, res) => {
  try {
    if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
    const rows = await pool.query('SELECT id, username, is_super, created_at FROM admins ORDER BY is_super DESC, id');
    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 添加管理员（仅超级管理员）
app.post('/api/admin/admins', auth, async (req, res) => {
  try {
    if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
    const { username, password } = req.body || {};
    if (!username || !username.trim()) return res.status(400).json({ error: '用户名不能为空' });
    if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    await pool.query(
      'INSERT INTO admins (username, password, is_super, created_at) VALUES ($1, $2, false, $3)',
      [username.trim(), password, Date.now()]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('duplicate key')) return res.status(400).json({ error: '用户名已存在' });
    res.status(500).json({ error: '创建失败' });
  }
});

// 删除管理员（仅超级管理员，不能删自己）
app.delete('/api/admin/admins/:id', auth, async (req, res) => {
  try {
    if (!req.admin.is_super) return res.status(403).json({ error: '无权限' });
    const id = parseInt(req.params.id);
    if (id === req.admin.id) return res.status(400).json({ error: '不能删除自己' });
    const target = await pool.query('SELECT is_super FROM admins WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: '管理员不存在' });
    if (target.rows[0].is_super) return res.status(400).json({ error: '不能删除超级管理员' });
    await pool.query('DELETE FROM admins WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 群组 API ----------
app.post('/api/groups', async (req, res) => {
  try {
    const { name, userName } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '请输入群组名称' });
    let code, existing;
    do {
      code = genCode();
      const r = await pool.query('SELECT id FROM groups WHERE code = $1', [code]);
      existing = r.rows[0];
    } while (existing);
    const creator = (userName || '').trim() || null;
    const info = await pool.query(
      'INSERT INTO groups (code, name, creator, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [code, name.trim(), creator, now()]
    );
    res.json({ id: info.rows[0].id, code, name: name.trim(), creator, center_lat: null, center_lng: null, radius: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/groups/:code', async (req, res) => {
  try {
    const group = await pool.query('SELECT * FROM groups WHERE code = $1', [req.params.code]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const g = group.rows[0];
    try { g.checkin_times = JSON.parse(g.checkin_times || '[]'); } catch { g.checkin_times = []; }
    res.json(g);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置打卡范围
app.patch('/api/groups/:code', async (req, res) => {
  try {
    const { center_lat, center_lng, radius, userName } = req.body || {};
    const group = await pool.query('SELECT * FROM groups WHERE code = $1', [req.params.code]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const g = group.rows[0];

    if (g.creator && g.creator !== (userName || '').trim()) {
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
    await pool.query(
      'UPDATE groups SET center_lat = $1, center_lng = $2, radius = $3 WHERE code = $4',
      [center_lat ?? null, center_lng ?? null, radius ?? 0, req.params.code]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 打卡 API ----------
app.post('/api/checkins', async (req, res) => {
  try {
    const { groupCode, userName, lat, lng, address, accuracy } = req.body || {};
    if (!groupCode || !userName) return res.status(400).json({ error: '缺少参数' });
    const group = await pool.query('SELECT * FROM groups WHERE code = $1', [groupCode]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const g = group.rows[0];

    // 范围校验
    if (g.radius > 0 && g.center_lat != null && g.center_lng != null && lat != null && lng != null) {
      const dist = distance(lat, lng, g.center_lat, g.center_lng);
      if (dist > g.radius) {
        return res.status(403).json({
          error: `超出打卡范围（当前距离中心 ${Math.round(dist)} 米，允许范围 ${g.radius} 米）`,
          distance: Math.round(dist),
          radius: g.radius
        });
      }
    }

    // 打卡时间校验
    try {
      const times = JSON.parse(g.checkin_times || '[]');
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

    const isCoord = /^\-?\d+\.\d+,\s*\-?\d+\.\d+$/.test(address || '');
    const displayAddr = (address && !isCoord) ? address : `${lat?.toFixed(5)}, ${lng?.toFixed(5)}`;
    const info = await pool.query(
      `INSERT INTO checkins (group_id, user_name, lat, lng, address, accuracy, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [g.id, userName.trim(), lat ?? null, lng ?? null, displayAddr, accuracy ?? null, now()]
    );
    const checkin = await pool.query('SELECT * FROM checkins WHERE id = $1', [info.rows[0].id]);
    res.json(checkin.rows[0]);

    // 后台异步获取详细地址
    if (isCoord && lat != null && lng != null) {
      reverseGeocode(lat, lng).then(addr => {
        if (addr) {
          pool.query('UPDATE checkins SET address = $1 WHERE id = $2', [addr, info.rows[0].id]).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/groups/:code/checkins', async (req, res) => {
  try {
    const group = await pool.query('SELECT id FROM groups WHERE code = $1', [req.params.code]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const rows = await pool.query('SELECT * FROM checkins WHERE group_id = $1 ORDER BY created_at DESC', [group.rows[0].id]);
    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 后台 API（需认证） ----------
app.get('/api/admin/groups', auth, async (req, res) => {
  try {
    const groups = await pool.query(
      `SELECT g.*, (SELECT COUNT(*) FROM checkins c WHERE c.group_id = g.id)::int AS checkin_count
       FROM groups g ORDER BY g.created_at DESC`
    );
    groups.rows.forEach(g => {
      try { g.checkin_times = JSON.parse(g.checkin_times || '[]'); } catch { g.checkin_times = []; }
    });
    res.json(groups.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 成员打卡统计（按群组、按天，4次打卡=1天）
app.get('/api/admin/stats/members', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT c.user_name, g.name AS group_name, g.code AS group_code, c.created_at
       FROM checkins c JOIN groups g ON c.group_id = g.id
       ORDER BY c.created_at DESC`
    );
    const dayKey = (ts) => new Date(ts).toLocaleDateString('zh-CN');
    const map = new Map();
    rows.rows.forEach(r => {
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
    const result = Array.from(map.values()).map(p => {
      const fullDays = Array.from(p.days.values()).filter(c => c >= 4).length;
      const checkinDays = p.days.size;
      return {
        user_name: p.user_name,
        group_name: p.group_name,
        group_code: p.group_code,
        total_checkins: p.totalCheckins,
        checkin_days: checkinDays,
        full_days: fullDays,
        first_checkin: p.first,
        last_checkin: p.last,
      };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/checkins', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT c.*, g.code AS group_code, g.name AS group_name
       FROM checkins c JOIN groups g ON c.group_id = g.id
       ORDER BY c.created_at DESC LIMIT 500`
    );
    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/checkins/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM checkins WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 编辑打卡记录（用户名、地址）
app.put('/api/admin/checkins/:id', auth, async (req, res) => {
  try {
    const { user_name, address } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (user_name !== undefined) { fields.push(`user_name = $${idx++}`); values.push(user_name); }
    if (address !== undefined) { fields.push(`address = $${idx++}`); values.push(address); }
    if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
    values.push(req.params.id);
    await pool.query(`UPDATE checkins SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 编辑群组信息（名称、中心点、范围、打卡时间）
app.put('/api/admin/groups/:id', auth, async (req, res) => {
  try {
    const { name, center_lat, center_lng, radius, creator, checkin_times } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (center_lat !== undefined) { fields.push(`center_lat = $${idx++}`); values.push(center_lat); }
    if (center_lng !== undefined) { fields.push(`center_lng = $${idx++}`); values.push(center_lng); }
    if (radius !== undefined) { fields.push(`radius = $${idx++}`); values.push(radius); }
    if (creator !== undefined) { fields.push(`creator = $${idx++}`); values.push(creator); }
    if (checkin_times !== undefined) { fields.push(`checkin_times = $${idx++}`); values.push(JSON.stringify(checkin_times || [])); }
    if (!fields.length) return res.status(400).json({ error: '没有可更新的字段' });
    values.push(req.params.id);
    await pool.query(`UPDATE groups SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 导出 CSV
app.get('/api/admin/export', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT c.created_at, c.user_name, g.name AS group_name, g.code AS group_code,
              c.lat, c.lng, c.address, c.accuracy
       FROM checkins c JOIN groups g ON c.group_id = g.id
       ORDER BY c.created_at DESC`
    );

    const headers = ['时间', '用户', '群组', '邀请码', '纬度', '经度', '地址', '精度(米)'];
    const escapeCsv = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows.rows) {
      lines.push([
        new Date(r.created_at).toLocaleString('zh-CN'),
        r.user_name, r.group_name, r.group_code,
        r.lat ?? '', r.lng ?? '', r.address ?? '', r.accuracy ?? ''
      ].map(escapeCsv).join(','));
    }
    const csv = '\uFEFF' + lines.join('\n');
    const filename = `打卡记录_${new Date().toISOString().slice(0, 10)}.csv`;
    const encodedName = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="checkin.csv"; filename*=UTF-8''${encodedName}`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 启动 ----------
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP]  打卡应用: http://localhost:${PORT}`);
});

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
