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
    console.error('[CONFIG] config.json 읽기 실패, 기본값 사용:', e.message);
    return { allowedIPs: ['127.0.0.1', '::1', '::ffff:127.0.0.1'], port: 3000, fileSizeLimitMB: 100 };
  }
}

let config = loadConfig();

// config.json 변경 감지 → 재시작 없이 즉시 반영
let serverReady = false;
fs.watch(CONFIG_PATH, () => {
  setTimeout(() => {                          // 파일 쓰기 완료 대기
    try {
      config = loadConfig();
      console.log('[CONFIG] 재로드 완료. 허용 IP:', config.allowedIPs);
      // 이름 맵 변경도 클라이언트에 즉시 반영 (서버 준비 후에만)
      if (serverReady) {
        broadcast({ type: 'profilesUpdate', profiles: resolveProfiles() });
        broadcast({ type: 'channelsUpdate', channels: config.channels || defaultChannels() });
      }
    } catch (e) {
      console.error('[CONFIG] 재로드 실패:', e.message);
    }
  }, 100);
});

const PORT = process.env.PORT || config.port || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(__dirname, 'void.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── IP 헬퍼 ─────────────────────────────────────────────────────
// IPv4-mapped IPv6(::ffff:1.2.3.4)를 1.2.3.4로 정규화
function normalizeIP(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^::ffff:/i, '');
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return normalizeIP(forwarded.split(',')[0]);
  return normalizeIP(req.socket.remoteAddress || '');
}

// IP 패턴 매칭 — 단일 IP, 와일드카드(*), 범위(start-end), 콤마 목록 지원
function matchesPattern(ip, pattern) {
  // 콤마로 분리된 목록이면 재귀 처리
  if (pattern.includes(',')) {
    return pattern.split(',').map(s => s.trim()).some(p => matchesPattern(ip, p));
  }

  const normIP  = normalizeIP(ip);
  const normPat = normalizeIP(pattern.trim());

  // 완전 일치
  if (normPat === normIP) return true;

  const ipParts  = normIP.split('.');
  const patParts = normPat.split('.');

  // IPv4 형식인 경우만 옥텟 패턴 처리
  if (ipParts.length !== 4) return false;
  if (patParts.length !== 4) return false;

  return patParts.every((pat, i) => {
    if (pat === '*') return true;               // 와일드카드
    if (pat.includes('-')) {                    // 범위: 100-200
      const [lo, hi] = pat.split('-').map(Number);
      const val = Number(ipParts[i]);
      return !isNaN(lo) && !isNaN(hi) && val >= lo && val <= hi;
    }
    return pat === ipParts[i];                  // 완전 일치 옥텟
  });
}

function isAllowed(ip) {
  return (config.allowedIPs || []).some(pattern => matchesPattern(ip, pattern));
}

// ── IP 차단 미들웨어 ─────────────────────────────────────────────
function ipGuard(req, res, next) {
  const ip = getClientIP(req);
  if (isAllowed(ip)) return next();
  console.warn(`[BLOCK] 차단: ${ip}`);
  res.status(403).send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>접근 거부</title>
<style>
  body{background:#0a0a0f;color:#e8e8f0;font-family:'IBM Plex Mono',monospace;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center}
  .code{font-size:72px;color:#f87171;font-weight:700;line-height:1}
  .msg{font-size:13px;color:#50506a;margin-top:14px;letter-spacing:.15em;text-transform:uppercase}
  .ip{font-size:12px;color:#3a3a50;margin-top:10px;font-size:11px}
</style></head>
<body><div class="box">
  <div class="code">403</div>
  <div class="msg">Access Denied</div>
  <div class="ip">${ip}</div>
</div></body></html>`);
}

// ── DATABASE ─────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL DEFAULT 'general',
    author     TEXT NOT NULL DEFAULT '127.0.0.1',
    text       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    filename    TEXT NOT NULL,
    original    TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel, created_at);
  CREATE INDEX IF NOT EXISTS idx_att_msg     ON attachments(message_id);
`);

const stmts = {
  insertMsg:    db.prepare(`INSERT INTO messages (id, channel, author, text, created_at) VALUES (?, ?, ?, ?, ?)`),
  insertAtt:    db.prepare(`INSERT INTO attachments (id, message_id, filename, original, size, mime) VALUES (?, ?, ?, ?, ?, ?)`),
  getMsgs:      db.prepare(`
    SELECT m.*, GROUP_CONCAT(
      a.id || '|' || a.filename || '|' || a.original || '|' || a.size || '|' || a.mime, ';;'
    ) AS attachments
    FROM messages m
    LEFT JOIN attachments a ON a.message_id = m.id
    WHERE m.channel = ?
    GROUP BY m.id
    ORDER BY m.created_at ASC
    LIMIT 300
  `),
  getAttsByMsg: db.prepare(`SELECT filename FROM attachments WHERE message_id = ?`),
  getAtt:       db.prepare(`SELECT * FROM attachments WHERE id = ?`),
  deleteMsg:    db.prepare(`DELETE FROM messages WHERE id = ?`),
  deleteAtts:   db.prepare(`DELETE FROM attachments WHERE message_id = ?`),
  deleteAtt:    db.prepare(`DELETE FROM attachments WHERE id = ?`),
};

// ── FILE UPLOAD ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  },
});

function makeUpload(req) {
  const limitBytes = (config.fileSizeLimitMB || 100) * 1024 * 1024;
  return multer({ storage, limits: { fileSize: limitBytes } });
}

// ── EXPRESS ───────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(ipGuard);                                              // ← 모든 경로 차단
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// GET /api/whoami — 클라이언트 IP + 프로파일 + 채널 목록 반환
app.get('/api/whoami', (req, res) => {
  res.json({
    ip:       getClientIP(req),
    profiles: resolveProfiles(),
    channels: config.channels || defaultChannels(),
  });
});

// config의 profiles(신규) 또는 nameMap(구형) → 통합 profiles 맵 반환
// profiles 형식: { "192.168.1.10": { name, avatar } }
function resolveProfiles() {
  const result = {};

  // 구형 nameMap 호환: { "ip": "name" }
  if (config.nameMap) {
    Object.entries(config.nameMap).forEach(([ip, name]) => {
      result[ip] = { name, avatar: null };
    });
  }

  // 신형 profiles 우선 적용: { "ip": { name, avatar } }
  if (config.profiles) {
    Object.entries(config.profiles).forEach(([ip, prof]) => {
      if (typeof prof === 'string') {
        result[ip] = { name: prof, avatar: null };
      } else {
        result[ip] = {
          name:   prof.name   || null,
          avatar: prof.avatar || null,   // URL 또는 /uploads/... 경로
        };
      }
    });
  }

  return result;
}

function defaultChannels() {
  return [
    { id: 'general', type: 'channel', label: 'general',    desc: '일반 채팅' },
    { id: 'files',   type: 'channel', label: 'files',      desc: '파일 전용 채널' },
    { id: 'memo',    type: 'channel', label: 'memo',        desc: '메모 채널' },
    { id: 'me',      type: 'dm',      label: '나에게 메모', desc: '나에게 보내는 메시지' },
  ];
}

// GET /api/messages/:channel
app.get('/api/messages/:channel', (req, res) => {
  const rows = stmts.getMsgs.all(req.params.channel);
  res.json(rows.map(parseRow));
});

// POST /api/messages  (author = 요청자 IP)
app.post('/api/messages', (req, res, next) => {
  makeUpload().array('files', 20)(req, res, next);
}, (req, res) => {
  const ip     = getClientIP(req);
  const { channel = 'general', text = '' } = req.body;
  const files  = req.files || [];

  if (!text.trim() && files.length === 0)
    return res.status(400).json({ error: 'Empty message' });

  const id  = uuidv4();
  const now = Date.now();

  db.transaction(() => {
    stmts.insertMsg.run(id, channel, ip, text, now);
    files.forEach(f =>
      stmts.insertAtt.run(uuidv4(), id, f.filename, f.originalname, f.size,
                          f.mimetype || 'application/octet-stream')
    );
  })();

  const attachments = files.map(f => ({
    filename: f.filename, original: f.originalname,
    size: f.size, mime: f.mimetype,
    url: `/uploads/${f.filename}`,
  }));

  const msg = { id, channel, author: ip, text, created_at: now, attachments };
  broadcast({ type: 'message', data: msg });
  res.json(msg);
});

// DELETE /api/messages/:id  — 메시지 + 모든 첨부파일
app.delete('/api/messages/:id', (req, res) => {
  const msgId = req.params.id;
  const atts  = stmts.getAttsByMsg.all(msgId);

  atts.forEach(a => {
    const fp = path.join(UPLOAD_DIR, a.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });

  db.transaction(() => {
    stmts.deleteAtts.run(msgId);
    stmts.deleteMsg.run(msgId);
  })();

  broadcast({ type: 'delete', id: msgId });
  console.log(`[DELETE] msg ${msgId}  (${atts.length} file(s) removed)`);
  res.json({ ok: true });
});

// DELETE /api/attachments/:id  — 개별 파일만 삭제
app.delete('/api/attachments/:id', (req, res) => {
  const att = stmts.getAtt.get(req.params.id);
  if (!att) return res.status(404).json({ error: 'not found' });

  const fp = path.join(UPLOAD_DIR, att.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  stmts.deleteAtt.run(att.id);

  broadcast({ type: 'deleteAttachment', id: att.id, messageId: att.message_id });
  console.log(`[DELETE] attachment ${att.original}`);
  res.json({ ok: true });
});

// ── WS SERVER ─────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

function broadcast(payload) {
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

wss.on('connection', (ws, req) => {
  const ip = normalizeIP(
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0]
  );
  if (!isAllowed(ip)) {
    console.warn(`[WS BLOCK] ${ip}`);
    ws.close(1008, 'Forbidden');
    return;
  }
  console.log(`[WS] ${ip} connected  (clients: ${wss.clients.size})`);
  ws.on('close', () => console.log(`[WS] ${ip} disconnected`));
});

server.listen(PORT, () => {
  serverReady = true;
  const ips = (config.allowedIPs || []).join(', ');
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  VOID Chat → http://localhost:${PORT}     ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  허용 IP : ${ips}`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});

// ── PARSE ROW ─────────────────────────────────────────────────────
function parseRow(row) {
  const attachments = row.attachments
    ? row.attachments.split(';;').filter(Boolean).map(s => {
        const [id, filename, original, size, mime] = s.split('|');
        return { id, filename, original, size: Number(size), mime, url: `/uploads/${filename}` };
      })
    : [];
  return { id: row.id, channel: row.channel, author: row.author,
           text: row.text, created_at: row.created_at, attachments };
}
