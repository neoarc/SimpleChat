const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ── CONFIG ──────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[CONFIG] 읽기 실패, 기본값 사용:', e.message);
    return { allowedIPs: ['127.0.0.1', '::1'], port: 3000, fileSizeLimitMB: 100 };
  }
}

let config = loadConfig();
let serverReady = false;

fs.watch(CONFIG_PATH, () => {
  setTimeout(() => {
    try {
      config = loadConfig();
      console.log('[CONFIG] 재로드 완료');
      if (serverReady) {
        broadcast({ type: 'profilesUpdate', profiles: resolveProfiles() });
        broadcastChannelUpdates();   // 클라이언트별 채널 목록 개인화 재전송
      }
    } catch (e) {
      console.error('[CONFIG] 재로드 실패:', e.message);
    }
  }, 100);
});

const PORT = process.env.PORT || config.port || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH    = path.join(__dirname, 'void.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── IP 헬퍼 ─────────────────────────────────────────────────────
function normalizeIP(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^::ffff:/i, '');
}
function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return normalizeIP(fwd.split(',')[0]);
  return normalizeIP(req.socket.remoteAddress || '');
}
function matchesPattern(ip, pattern) {
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (pattern.includes(','))
    return pattern.split(',').map(s => s.trim()).some(p => matchesPattern(ip, p));

  const normIP  = normalizeIP(ip);
  const normPat = normalizeIP(pattern.trim());
  if (normPat === normIP) return true;

  const ia = normIP.split('.');
  const pa = normPat.split('.');
  if (ia.length !== 4 || pa.length !== 4) return false;

  return pa.every((p, i) => {
    if (p === '*') return true;
    if (p.includes('-')) {
      const [lo, hi] = p.split('-').map(Number);
      return !isNaN(lo) && !isNaN(hi) && Number(ia[i]) >= lo && Number(ia[i]) <= hi;
    }
    return p === ia[i];
  });
}
function isAllowed(ip) {
  return (config.allowedIPs || []).some(p => matchesPattern(ip, p));
}

// ── 그룹 / 채널 접근 제어 ────────────────────────────────────────

/** IP가 속한 그룹 ID 목록 */
function getGroupsForIP(ip) {
  const groups = config.groups || {};
  return Object.entries(groups)
    .filter(([, g]) => (g.ips || []).some(p => matchesPattern(ip, p)))
    .map(([id]) => id);
}

/** admin 그룹 여부 */
function isAdmin(ip) {
  return getGroupsForIP(ip).includes('admin');
}

/**
 * IP가 채널에 접근 가능한지
 *
 * channel.access 규칙:
 *   없음 / "guest"  → allowedIPs 내 모든 사람
 *   "private"       → 모두 접근 허용, 본인 메시지만 조회
 *   "admin"         → admin 그룹만
 *   "grp-id"        → 해당 그룹만
 *   ["grp-a","grp-b"] → 나열된 그룹 중 하나 이상 소속
 */
function canAccess(ip, channel) {
  if (isAdmin(ip)) return true;

  const access = channel.access;
  if (!access || access === 'guest' || access === 'private') return true;
  if (access === 'admin') return false;

  const required = Array.isArray(access) ? access : [access];
  const myGroups = getGroupsForIP(ip);
  return required.some(g => myGroups.includes(g));
}

/**
 * 접근 가능한 채널 목록 (클라이언트 전송용)
 * private 채널 ID = "baseId__safeIP"
 * admin은 추가로 연결된 모든 사용자의 private 채널도 볼 수 있음
 */
function getAccessibleChannels(ip) {
  const all = config.channels || defaultChannels();
  const result = all
    .filter(ch => canAccess(ip, ch))
    .map(ch => {
      if (ch.access === 'private') {
        const safeIP = ip.replace(/[.:]/g, '_');
        return { ...ch, id: `${ch.id}__${safeIP}`, _private: true };
      }
      return ch;
    });

  // admin: 현재 접속 중인 다른 사용자들의 private 채널도 노출
  if (isAdmin(ip)) {
    const privateChannels = all.filter(ch => ch.access === 'private');
    const connectedIPs = new Set(wsClients.values());
    connectedIPs.forEach(otherIp => {
      if (otherIp === ip) return;  // 본인 제외
      privateChannels.forEach(ch => {
        const safeIP = otherIp.replace(/[.:]/g, '_');
        const adminChId = `${ch.id}__${safeIP}`;
        if (!result.find(c => c.id === adminChId)) {
          // 표시 이름: profiles에서 이름 가져오기
          const prof = resolveProfiles()[otherIp];
          const displayName = (prof && prof.name) ? prof.name : otherIp;
          result.push({
            ...ch,
            id: adminChId,
            label: `${ch.label} (${displayName})`,
            desc: `${displayName}의 개인 채널`,
            _private: true,
            _adminView: true,
            _ownerIp: otherIp,
          });
        }
      });
    });
  }

  return result;
}

/**
 * 채널 ID 해석 → { realId, filterAuthor }
 * private 채널(__패턴)이면 owner IP로 필터
 * admin이 다른 사람 채널 보는 경우도 처리
 */
function resolveChannelQuery(channelId, ip) {
  const m = channelId.match(/^(.+)__(.+)$/);
  if (!m) return { realId: channelId, filterAuthor: null };

  const baseId  = m[1];
  const safeOwnerIp = m[2];

  // safe IP → 실제 IP 복원: wsClients에서 매칭
  let ownerIp = ip; // 기본: 본인
  for (const [, clientIp] of wsClients) {
    if (clientIp.replace(/[.:]/g, '_') === safeOwnerIp) {
      ownerIp = clientIp;
      break;
    }
  }
  // 접속 중이 아닌 경우 safe IP를 점으로 복원 (근사치)
  if (ownerIp === ip && safeOwnerIp !== ip.replace(/[.:]/g, '_')) {
    ownerIp = safeOwnerIp.replace(/_/g, '.');
  }

  return { realId: baseId, filterAuthor: ownerIp };
}

// ── IP 차단 미들웨어 ─────────────────────────────────────────────
function ipGuard(req, res, next) {
  const ip = getClientIP(req);
  if (isAllowed(ip)) return next();
  console.warn(`[BLOCK] ${ip}`);
  res.status(403).send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<title>접근 거부</title><style>
body{background:#0a0a0f;color:#e8e8f0;font-family:'IBM Plex Mono',monospace;
     display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.code{font-size:72px;color:#f87171;font-weight:700;line-height:1}
.msg{font-size:13px;color:#50506a;margin-top:14px;letter-spacing:.15em;text-transform:uppercase}
.ip{font-size:11px;color:#3a3a50;margin-top:10px}
</style></head><body><div class="box">
<div class="code">403</div><div class="msg">Access Denied</div>
<div class="ip">${ip}</div></div></body></html>`);
}

// ── DATABASE ─────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'general',
    author TEXT NOT NULL DEFAULT '127.0.0.1',
    text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
    filename TEXT NOT NULL, original TEXT NOT NULL,
    size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel, created_at);
  CREATE INDEX IF NOT EXISTS idx_att_msg     ON attachments(message_id);
  CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
    emoji TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(message_id, emoji, author),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_react_msg ON reactions(message_id);
`);

const MSG_SELECT = `
  SELECT m.*, GROUP_CONCAT(
    a.id||'|'||a.filename||'|'||a.original||'|'||a.size||'|'||a.mime, ';;'
  ) AS attachments
  FROM messages m LEFT JOIN attachments a ON a.message_id = m.id
  WHERE m.channel = ? GROUP BY m.id ORDER BY m.created_at ASC LIMIT 300`;

const stmts = {
  insertMsg:       db.prepare(`INSERT INTO messages (id,channel,author,text,created_at) VALUES (?,?,?,?,?)`),
  insertAtt:       db.prepare(`INSERT INTO attachments (id,message_id,filename,original,size,mime) VALUES (?,?,?,?,?,?)`),
  getMsgs:         db.prepare(MSG_SELECT),
  getMsgsFiltered: db.prepare(MSG_SELECT.replace('WHERE m.channel = ?', 'WHERE m.channel = ? AND m.author = ?')),
  getAttsByMsg:    db.prepare(`SELECT filename FROM attachments WHERE message_id = ?`),
  getAtt:          db.prepare(`SELECT * FROM attachments WHERE id = ?`),
  deleteMsg:       db.prepare(`DELETE FROM messages WHERE id = ?`),
  deleteAtts:      db.prepare(`DELETE FROM attachments WHERE message_id = ?`),
  deleteAtt:       db.prepare(`DELETE FROM attachments WHERE id = ?`),
  getReactions:    db.prepare(`SELECT emoji, author FROM reactions WHERE message_id = ?`),
  upsertReact:     db.prepare(`INSERT OR IGNORE INTO reactions (id,message_id,emoji,author,created_at) VALUES (?,?,?,?,?)`),
  deleteReact:     db.prepare(`DELETE FROM reactions WHERE message_id=? AND emoji=? AND author=?`),
  existsReact:     db.prepare(`SELECT id FROM reactions WHERE message_id=? AND emoji=? AND author=?`),
};

// ── FILE UPLOAD ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
function makeUpload() {
  return multer({ storage, limits: { fileSize: (config.fileSizeLimitMB || 100) * 1024 * 1024 } });
}

// ── EXPRESS ───────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(ipGuard);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// GET /api/whoami
app.get('/api/whoami', (req, res) => {
  const ip = getClientIP(req);
  res.json({
    ip,
    profiles:         resolveProfiles(),
    channels:         getAccessibleChannels(ip),
    groups:           getGroupsForIP(ip),
    isAdmin:          isAdmin(ip),
    allowedReactions: config.allowedReactions || ['⭕','❌','✅'],
  });
});

// GET /api/messages/:channel
app.get('/api/messages/:channel', (req, res) => {
  const ip  = getClientIP(req);
  const chId = req.params.channel;

  const accessible = getAccessibleChannels(ip);
  if (!accessible.find(ch => ch.id === chId)) {
    console.warn(`[ACCESS] ${ip} → ${chId} 거부`);
    return res.status(403).json({ error: 'Access denied' });
  }

  const { realId, filterAuthor } = resolveChannelQuery(chId, ip);
  const rows = filterAuthor
    ? stmts.getMsgsFiltered.all(realId, filterAuthor)
    : stmts.getMsgs.all(realId);

  res.json(rows.map(r => parseRow(r, chId)));
});

// POST /api/messages
app.post('/api/messages', (req, res, next) => {
  makeUpload().array('files', 20)(req, res, next);
}, (req, res) => {
  const ip    = getClientIP(req);
  const { channel = 'general', text = '' } = req.body;
  const files = req.files || [];

  const accessible = getAccessibleChannels(ip);
  if (!accessible.find(ch => ch.id === channel))
    return res.status(403).json({ error: 'Access denied' });

  if (!text.trim() && files.length === 0)
    return res.status(400).json({ error: 'Empty message' });

  const { realId } = resolveChannelQuery(channel, ip);
  const id  = uuidv4();
  const now = Date.now();

  db.transaction(() => {
    stmts.insertMsg.run(id, realId, ip, text, now);
    files.forEach(f =>
      stmts.insertAtt.run(uuidv4(), id, f.filename, f.originalname, f.size,
                          f.mimetype || 'application/octet-stream')
    );
  })();

  const attachments = files.map(f => ({
    filename: f.filename, original: f.originalname,
    size: f.size, mime: f.mimetype, url: `/uploads/${f.filename}`,
  }));

  const msg = { id, channel, author: ip, text, created_at: now, attachments, reactions: {} };
  broadcastToChannel(channel, ip, { type: 'message', data: msg });
  res.json(msg);
});

// DELETE /api/messages/:id
app.delete('/api/messages/:id', (req, res) => {
  const msgId = req.params.id;
  const atts  = stmts.getAttsByMsg.all(msgId);
  atts.forEach(a => {
    const fp = path.join(UPLOAD_DIR, a.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  db.transaction(() => { stmts.deleteAtts.run(msgId); stmts.deleteMsg.run(msgId); })();
  broadcast({ type: 'delete', id: msgId });
  console.log(`[DELETE] msg ${msgId}`);
  res.json({ ok: true });
});

// DELETE /api/attachments/:id
app.delete('/api/attachments/:id', (req, res) => {
  const att = stmts.getAtt.get(req.params.id);
  if (!att) return res.status(404).json({ error: 'not found' });
  const fp = path.join(UPLOAD_DIR, att.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  stmts.deleteAtt.run(att.id);
  broadcast({ type: 'deleteAttachment', id: att.id, messageId: att.message_id });
  res.json({ ok: true });
});

// POST /api/reactions
app.post('/api/reactions', (req, res) => {
  const ip = getClientIP(req);
  const { messageId, emoji } = req.body;
  if (!messageId || !emoji) return res.status(400).json({ error: 'missing fields' });
  const validEmojis = config.allowedReactions || ['⭕','❌','✅'];
  if (!validEmojis.includes(emoji)) return res.status(400).json({ error: 'invalid emoji' });

  const existing = stmts.existsReact.get(messageId, emoji, ip);
  if (existing) stmts.deleteReact.run(messageId, emoji, ip);
  else stmts.upsertReact.run(uuidv4(), messageId, emoji, ip, Date.now());

  const reactions = {};
  stmts.getReactions.all(messageId).forEach(r => {
    (reactions[r.emoji] = reactions[r.emoji] || []).push(r.author);
  });

  broadcast({ type: 'reaction', messageId, reactions });
  res.json({ ok: true, reactions });
});

// ── WS SERVER ─────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const wsClients = new Map();   // ws → ip

function broadcast(payload) {
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

/** 특정 채널 권한이 있는 클라이언트에게만 브로드캐스트 */
function broadcastToChannel(channelId, senderIp, payload) {
  const str = JSON.stringify(payload);
  const isPrivate = channelId.includes('__');

  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const clientIp = wsClients.get(ws);
    if (!clientIp) return;
    // private 채널: sender 본인에게만
    if (isPrivate && clientIp !== senderIp) return;
    // 일반 채널: 접근 권한 확인
    const accessible = getAccessibleChannels(clientIp);
    if (!accessible.find(ch => ch.id === channelId)) return;
    ws.send(str);
  });
}

/** config 변경 시 각 클라이언트에게 본인 기준 채널 목록 재전송 */
function broadcastChannelUpdates() {
  wss.clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const ip = wsClients.get(ws);
    if (!ip) return;
    ws.send(JSON.stringify({
      type:             'channelsUpdate',
      channels:         getAccessibleChannels(ip),
      groups:           getGroupsForIP(ip),
      isAdmin:          isAdmin(ip),
      allowedReactions: config.allowedReactions || ['⭕','❌','✅'],
    }));
  });
}

wss.on('connection', (ws, req) => {
  const ip = normalizeIP(
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]
  );
  if (!isAllowed(ip)) { ws.close(1008, 'Forbidden'); return; }
  wsClients.set(ws, ip);
  console.log(`[WS] ${ip} connected  (총 ${wss.clients.size}명)`);
  ws.on('close', () => { wsClients.delete(ws); console.log(`[WS] ${ip} disconnected`); });
});

server.listen(PORT, () => {
  serverReady = true;
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  VOID Chat → http://localhost:${PORT}     ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  허용 IP : ${(config.allowedIPs||[]).join(', ')}`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});

// ── HELPERS ──────────────────────────────────────────────────────
function parseRow(row, channelId) {
  const attachments = row.attachments
    ? row.attachments.split(';;').filter(Boolean).map(s => {
        const [id, filename, original, size, mime] = s.split('|');
        return { id, filename, original, size: Number(size), mime, url: `/uploads/${filename}` };
      })
    : [];
  const reactions = {};
  stmts.getReactions.all(row.id).forEach(r => {
    (reactions[r.emoji] = reactions[r.emoji] || []).push(r.author);
  });
  return { id: row.id, channel: channelId || row.channel, author: row.author,
           text: row.text, created_at: row.created_at, attachments, reactions };
}

function resolveProfiles() {
  const result = {};
  if (config.nameMap)
    Object.entries(config.nameMap).forEach(([ip, n]) => { result[ip] = { name: n, avatar: null }; });
  if (config.profiles)
    Object.entries(config.profiles).forEach(([ip, p]) => {
      result[ip] = typeof p === 'string' ? { name: p, avatar: null }
                                         : { name: p.name||null, avatar: p.avatar||null };
    });
  return result;
}

function defaultChannels() {
  return [
    { id:'general', type:'channel', label:'general',    desc:'일반 채팅',      access:'guest'   },
    { id:'files',   type:'channel', label:'files',       desc:'파일 전용 채널', access:'guest'   },
    { id:'memo',    type:'channel', label:'memo',         desc:'메모 채널',      access:'guest'   },
    { id:'me',      type:'dm',      label:'나에게 메모',  desc:'개인 메모',      access:'private' },
  ];
}
