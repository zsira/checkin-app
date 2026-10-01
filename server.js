const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

// 强制 IPv4 优先（部分云平台如 Railway 不支持 IPv6 出站）
dns.setDefaultResultOrder('ipv4first');

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
    CREATE TABLE IF NOT EXISTS leaves (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      start_ts BIGINT NOT NULL,
      end_ts BIGINT NOT NULL,
      reason TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leaves_group_user ON leaves(group_id, user_name);
  `);

  // 兼容性：添加休息字段（如已存在则跳过）
  try { await pool.query('ALTER TABLE groups ADD COLUMN rest_until BIGINT'); } catch {}
  try { await pool.query('ALTER TABLE groups ADD COLUMN rest_reason TEXT'); } catch {}

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

// 日期 key（本地时区，按天）
function dayKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

// 根据请假记录生成请假日期集合（Set of dayKey）
function buildLeaveDateSet(leaveRows) {
  const set = new Set();
  for (const l of leaveRows) {
    const start = new Date(Number(l.start_ts)); start.setHours(0, 0, 0, 0);
    const end = new Date(Number(l.end_ts)); end.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      set.add(dayKey(t));
    }
  }
  return set;
}

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

// 正向地理编码（地址 -> 坐标）
function geocode(address) {
  return new Promise((resolve) => {
    if (!address) return resolve(null);

    // 1. 高德地图
    if (AMAP_KEY) {
      const url = `https://restapi.amap.com/v3/geocode/geo?key=${AMAP_KEY}&address=${encodeURIComponent(address)}&output=json`;
      https.get(url, { agent: proxyAgent, timeout: 6000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.status === '1' && j.geocodes && j.geocodes.length > 0) {
              const loc = j.geocodes[0].location.split(',');
              return resolve({ lat: parseFloat(loc[1]), lng: parseFloat(loc[0]), address: j.geocodes[0].formatted_address || address });
            }
          } catch {}
          resolve(null);
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
      return;
    }

    // 2. 天地图
    if (TIANDITU_KEY) {
      const ds = JSON.stringify({ keyWord: address, level: 12, mapBound: '-180,-90,180,90', queryType: 7, start: 0, count: 1 });
      const url = `https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(ds)}&type=query&tk=${TIANDITU_KEY}`;
      https.get(url, { agent: proxyAgent, timeout: 6000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.coverages && j.coverages.length > 0 && j.coverages[0].Position) {
              const [lng, lat] = j.coverages[0].Position.split(' ');
              return resolve({ lat: parseFloat(lat), lng: parseFloat(lng), address: j.coverages[0].name || address });
            }
          } catch {}
          resolve(null);
        });
      }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
      return;
    }

    // 3. 降级：Open-Meteo（免 key，支持中文）
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(address)}&count=1&language=zh&format=json`;
    https.get(url, { agent: proxyAgent, timeout: 8000, headers: { 'User-Agent': 'checkin-app/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.results && j.results.length > 0) {
            const r = j.results[0];
            const addr = [r.admin1, r.admin2, r.name].filter(Boolean).join(' ') || address;
            return resolve({ lat: r.latitude, lng: r.longitude, address: addr });
          }
        } catch {}
        resolve(null);
      });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

// 管理后台：地址转坐标
app.get('/api/admin/geocode', auth, async (req, res) => {
  try {
    const address = (req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: '请输入地址' });
    const result = await geocode(address);
    if (!result) return res.status(404).json({ error: '未找到该地址的坐标，请尝试更详细的地址' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// 获取当前登录管理员信息
app.get('/api/admin/me', auth, (req, res) => {
  res.json({ username: req.admin.username, is_super: req.admin.is_super });
});

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
// 创建群组：仅管理员可创建（需 admin token）
app.post('/api/groups', auth, async (req, res) => {
  try {
    const { name, center_lat, center_lng, radius } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: '请输入群组名称' });
    let code, existing;
    do {
      code = genCode();
      const r = await pool.query('SELECT id FROM groups WHERE code = $1', [code]);
      existing = r.rows[0];
    } while (existing);
    // 创建者记录为管理员用户名
    const creator = req.admin.username;
    const info = await pool.query(
      'INSERT INTO groups (code, name, creator, center_lat, center_lng, radius, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [code, name.trim(), creator, center_lat ?? null, center_lng ?? null, radius ?? 0, now()]
    );
    res.json({ id: info.rows[0].id, code, name: name.trim(), creator, center_lat: center_lat ?? null, center_lng: center_lng ?? null, radius: radius ?? 0 });
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

    // 休息期间禁止打卡
    if (g.rest_until && Number(g.rest_until) > Date.now()) {
      const restEnd = new Date(Number(g.rest_until));
      const restInfo = `休息中，截止 ${restEnd.getFullYear()}/${restEnd.getMonth()+1}/${restEnd.getDate()} ${String(restEnd.getHours()).padStart(2,'0')}:${String(restEnd.getMinutes()).padStart(2,'0')}`;
      if (g.rest_reason) return res.status(403).json({ error: `${restInfo}\n原因：${g.rest_reason}`, rest_until: g.rest_until, rest_reason: g.rest_reason });
      return res.status(403).json({ error: restInfo, rest_until: g.rest_until, rest_reason: g.rest_reason });
    }

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
    const gid = group.rows[0].id;
    const userName = (req.query.user_name || '').trim();
    let rows;
    if (userName) {
      // 仅返回该用户自己的打卡记录
      rows = await pool.query(
        'SELECT * FROM checkins WHERE group_id = $1 AND user_name = $2 ORDER BY created_at DESC',
        [gid, userName]
      );
    } else {
      rows = await pool.query('SELECT * FROM checkins WHERE group_id = $1 ORDER BY created_at DESC', [gid]);
    }
    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 请假 API ----------
// 提交请假
app.post('/api/leaves', async (req, res) => {
  try {
    const { groupCode, userName, start_ts, end_ts, reason } = req.body || {};
    if (!groupCode || !userName || !start_ts || !end_ts) {
      return res.status(400).json({ error: '缺少参数' });
    }
    const start = Number(start_ts), end = Number(end_ts);
    if (end <= start) return res.status(400).json({ error: '结束时间必须晚于开始时间' });
    const group = await pool.query('SELECT id FROM groups WHERE code = $1', [groupCode]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const info = await pool.query(
      `INSERT INTO leaves (group_id, user_name, start_ts, end_ts, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [group.rows[0].id, userName.trim(), start, end, (reason || '').trim() || null, now()]
    );
    res.json(info.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 查询自己的请假记录
app.get('/api/leaves', async (req, res) => {
  try {
    const { groupCode, userName } = req.query;
    if (!groupCode || !userName) return res.status(400).json({ error: '缺少参数' });
    const group = await pool.query('SELECT id FROM groups WHERE code = $1', [groupCode]);
    if (group.rows.length === 0) return res.status(404).json({ error: '群组不存在' });
    const rows = await pool.query(
      'SELECT * FROM leaves WHERE group_id = $1 AND user_name = $2 ORDER BY start_ts DESC',
      [group.rows[0].id, userName.trim()]
    );
    res.json(rows.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除自己的请假（取消请假）
app.delete('/api/leaves/:id', async (req, res) => {
  try {
    const { userName } = req.query;
    const id = parseInt(req.params.id);
    if (!userName) return res.status(400).json({ error: '缺少参数' });
    await pool.query('DELETE FROM leaves WHERE id = $1 AND user_name = $2', [id, userName.trim()]);
    res.json({ ok: true });
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

// 成员打卡统计（按群组、按天；请假日期不计缺卡）
app.get('/api/admin/stats/members', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT c.user_name, g.name AS group_name, g.code AS group_code, g.id AS group_id, c.created_at
       FROM checkins c JOIN groups g ON c.group_id = g.id
       ORDER BY c.created_at DESC`
    );
    // 所有请假记录
    const leaveRows = await pool.query(
      `SELECT l.user_name, l.start_ts, l.end_ts, g.code AS group_code
       FROM leaves l JOIN groups g ON l.group_id = g.id`
    );
    const leaveMap = new Map(); // key -> Set<dayKey>
    leaveRows.rows.forEach(l => {
      const key = l.group_code + '|' + l.user_name;
      if (!leaveMap.has(key)) leaveMap.set(key, new Set());
      buildLeaveDateSet([l]).forEach(d => leaveMap.get(key).add(d));
    });

    const dk = (ts) => dayKey(ts);
    const map = new Map();
    rows.rows.forEach(r => {
      const key = r.group_code + '|' + r.user_name;
      if (!map.has(key)) {
        map.set(key, { user_name: r.user_name, group_name: r.group_name, group_code: r.group_code, days: new Map(), totalCheckins: 0, first: r.created_at, last: r.created_at });
      }
      const p = map.get(key);
      const d = dk(r.created_at);
      p.days.set(d, (p.days.get(d) || 0) + 1);
      p.totalCheckins++;
      if (r.created_at < p.first) p.first = r.created_at;
      if (r.created_at > p.last) p.last = r.created_at;
    });
    const result = Array.from(map.values()).map(p => {
      const fullDays = Array.from(p.days.values()).filter(c => c >= 4).length;
      const checkinDays = p.days.size;
      const key = p.group_code + '|' + p.user_name;
      const leaveDates = leaveMap.get(key) || new Set();
      // 计算缺卡天数：首次到末次打卡之间，未打卡且未请假的天数
      const first = new Date(Number(p.first)); first.setHours(0, 0, 0, 0);
      const last = new Date(Number(p.last)); last.setHours(0, 0, 0, 0);
      let absentDays = 0, leaveDaysInRange = 0;
      for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
        const k = dk(t);
        if (p.days.has(k)) continue;           // 已打卡
        if (leaveDates.has(k)) { leaveDaysInRange++; continue; } // 请假，不计缺卡
        absentDays++;
      }
      // 请假总天数（含统计区间外）
      const totalLeaveDays = leaveDates.size;
      return {
        user_name: p.user_name,
        group_name: p.group_name,
        group_code: p.group_code,
        total_checkins: p.totalCheckins,
        checkin_days: checkinDays,
        full_days: fullDays,
        absent_days: absentDays,
        leave_days: totalLeaveDays,
        first_checkin: p.first,
        last_checkin: p.last,
      };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 管理员查看所有请假记录（含当前请假中的标记）
app.get('/api/admin/leaves', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT l.*, g.name AS group_name, g.code AS group_code
       FROM leaves l JOIN groups g ON l.group_id = g.id
       ORDER BY l.created_at DESC`
    );
    const nowTs = now();
    res.json(rows.rows.map(r => ({
      ...r,
      active: Number(r.end_ts) > nowTs,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 管理员删除请假记录
app.delete('/api/admin/leaves/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM leaves WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ ok: true });
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

// 删除群组（同时删除该群组所有打卡记录）
app.delete('/api/admin/groups/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query('DELETE FROM groups WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置群休息（rest_until 为休息截止时间戳，null/0 表示取消休息）
app.post('/api/admin/groups/:id/rest', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { rest_until, rest_reason } = req.body || {};
    const until = rest_until ? Number(rest_until) : null;
    await pool.query(
      'UPDATE groups SET rest_until = $1, rest_reason = $2 WHERE id = $3',
      [until, rest_reason || null, id]
    );
    res.json({ ok: true, rest_until: until, rest_reason: rest_reason || null });
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

// 导出 CSV（按人员汇总：人员、群组、打卡天数、缺卡天数、请假天数、打卡总数、缺卡总数）
app.get('/api/admin/export', auth, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT c.created_at, c.user_name, g.name AS group_name, g.code AS group_code
       FROM checkins c JOIN groups g ON c.group_id = g.id
       ORDER BY c.created_at DESC`
    );
    const leaveRows = await pool.query(
      `SELECT l.user_name, l.start_ts, l.end_ts, g.code AS group_code
       FROM leaves l JOIN groups g ON l.group_id = g.id`
    );
    const leaveMap = new Map();
    leaveRows.rows.forEach(l => {
      const key = l.group_code + '|' + l.user_name;
      if (!leaveMap.has(key)) leaveMap.set(key, new Set());
      buildLeaveDateSet([l]).forEach(d => leaveMap.get(key).add(d));
    });

    const dk = (ts) => dayKey(ts);
    const map = new Map();
    rows.rows.forEach(r => {
      const key = r.group_code + '|' + r.user_name;
      if (!map.has(key)) {
        map.set(key, { user_name: r.user_name, group_name: r.group_name, group_code: r.group_code, days: new Set(), total: 0, first: r.created_at, last: r.created_at });
      }
      const p = map.get(key);
      p.days.add(dk(r.created_at));
      p.total++;
      if (r.created_at < p.first) p.first = r.created_at;
      if (r.created_at > p.last) p.last = r.created_at;
    });

    const stats = Array.from(map.values()).map(p => {
      const leaveDates = leaveMap.get(p.group_code + '|' + p.user_name) || new Set();
      const first = new Date(Number(p.first)); first.setHours(0, 0, 0, 0);
      const last = new Date(Number(p.last)); last.setHours(0, 0, 0, 0);
      let absentDays = 0;
      for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
        const k = dk(t);
        if (p.days.has(k) || leaveDates.has(k)) continue;
        absentDays++;
      }
      return {
        user_name: p.user_name, group_name: p.group_name,
        checkin_days: p.days.size, absent_days: absentDays,
        leave_days: leaveDates.size, total_checkins: p.total,
      };
    });

    const escapeCsv = v => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['人员', '所属群组', '打卡天数', '缺卡天数', '请假天数', '打卡总数', '缺卡总数'];
    const lines = [headers.join(',')];
    for (const p of stats) {
      lines.push([
        p.user_name, p.group_name,
        p.checkin_days, p.absent_days, p.leave_days,
        p.total_checkins, p.absent_days
      ].map(escapeCsv).join(','));
    }
    const sumCheckinDays = stats.reduce((s, p) => s + p.checkin_days, 0);
    const sumAbsent = stats.reduce((s, p) => s + p.absent_days, 0);
    const sumLeave = stats.reduce((s, p) => s + p.leave_days, 0);
    const sumTotal = stats.reduce((s, p) => s + p.total_checkins, 0);
    lines.push(['合计', '', sumCheckinDays, sumAbsent, sumLeave, sumTotal, sumAbsent].map(escapeCsv).join(','));

    const csv = '\uFEFF' + lines.join('\n');
    const filename = `打卡统计_${new Date().toISOString().slice(0, 10)}.csv`;
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
