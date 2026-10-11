import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const mediaDir = path.join(dataDir, 'uploads');
const port = Number(process.env.PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || '';
const maxMediaBytes = 50 * 1024 * 1024;
const maxAudioBytes = 20 * 1024 * 1024;

if (Buffer.byteLength(jwtSecret) < 32) {
  throw new Error('JWT_SECRET must contain at least 32 bytes.');
}
fs.mkdirSync(mediaDir, { recursive: true, mode: 0o750 });

const db = new DatabaseSync(path.join(dataDir, 'liubai.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(from_user, to_user),
    CHECK (from_user != to_user)
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    music TEXT NOT NULL DEFAULT '',
    media_name TEXT,
    media_type TEXT,
    audio_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests(to_user, status);
  CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at);
`);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['Accept-Ranges', 'Content-Length', 'Content-Range'],
  maxAge: 600,
}));
app.use(express.json({ limit: '256kb' }));

const b64url = (value) => Buffer.from(value).toString('base64url');
const now = () => new Date().toISOString();
const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  createdAt: row.created_at,
});

function signToken(user) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: String(user.id), exp: Math.floor(Date.now() / 1000) + 30 * 86400 }));
  const input = header + '.' + payload;
  const signature = crypto.createHmac('sha256', jwtSecret).update(input).digest('base64url');
  return input + '.' + signature;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const input = parts[0] + '.' + parts[1];
  const expected = crypto.createHmac('sha256', jwtSecret).update(input).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return Number(payload.sub);
  } catch { return null; }
}

const scrypt = promisify(crypto.scrypt);
async function makePasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return salt.toString('hex') + ':' + key.toString('hex');
}
async function checkPassword(password, stored) {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const authAttempts = new Map();
function limitAuthAttempts(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = Date.now();
  let entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= current) entry = { count: 0, resetAt: current + 15 * 60 * 1000 };
  entry.count += 1;
  authAttempts.set(key, entry);
  if (authAttempts.size > 5000) {
    for (const [ip, item] of authAttempts) if (item.resetAt <= current) authAttempts.delete(ip);
  }
  if (entry.count > 12) return res.status(429).json({ error: '尝试次数太多，请 15 分钟后再试。' });
  next();
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const userId = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!userId) return res.status(401).json({ error: '登录已失效，请重新登录。' });
  const user = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: '账号不存在，请重新登录。' });
  req.user = user;
  next();
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'liubai-api' }));

app.post('/api/register', limitAuthAttempts, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const displayName = String(req.body?.displayName || '').trim();
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return fail(res, 400, '账号请用 3 到 24 位英文字母、数字或下划线。');
    if (displayName.length < 1 || displayName.length > 24) return fail(res, 400, '昵称需要 1 到 24 个字符。');
    if (password.length < 8 || password.length > 128) return fail(res, 400, '密码需要 8 到 128 个字符。');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return fail(res, 409, '这个账号名已经有人使用。');
    const passwordHash = await makePasswordHash(password);
    const createdAt = now();
    const result = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, displayName, passwordHash, createdAt);
    const user = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/login', limitAuthAttempts, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await checkPassword(password, user.password_hash))) return fail(res, 401, '账号或密码不正确。');
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get('/api/me', requireAuth, (req, res) => {
  const friends = db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE status = 'accepted' AND (from_user = ? OR to_user = ?)").get(req.user.id, req.user.id).n;
  const posts = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?').get(req.user.id).n;
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?').get(req.user.id).n;
  res.json({ ...publicUser(req.user), friendCount: friends, postCount: posts, likeCount: likes });
});

app.get('/api/users', requireAuth, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  if (query.length < 2 || query.length > 40) return res.json({ users: [] });
  const users = db.prepare(`
    SELECT id, username, display_name, created_at FROM users
    WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
    ORDER BY username LIMIT 30
  `).all(req.user.id, query.replace(/[\\%_]/g, '\\$&') + '%', '%' + query.replace(/[\\%_]/g, '\\$&') + '%');
  res.json({ users: users.map(publicUser) });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const id = req.user.id;
  const friends = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = CASE WHEN f.from_user = ? THEN f.to_user ELSE f.from_user END
    WHERE f.status = 'accepted' AND (f.from_user = ? OR f.to_user = ?) ORDER BY u.display_name
  `).all(id, id, id).map(publicUser);
  const incoming = db.prepare(`
    SELECT f.id AS request_id, u.id, u.username, u.display_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = f.from_user WHERE f.to_user = ? AND f.status = 'pending' ORDER BY f.created_at DESC
  `).all(id).map((row) => ({ requestId: row.request_id, user: publicUser(row) }));
  const outgoing = db.prepare(`
    SELECT f.id AS request_id, u.id, u.username, u.display_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = f.to_user WHERE f.from_user = ? AND f.status = 'pending' ORDER BY f.created_at DESC
  `).all(id).map((row) => ({ requestId: row.request_id, user: publicUser(row) }));
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friend-requests', requireAuth, (req, res) => {
  const targetId = Number(req.body?.userId);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.user.id) return fail(res, 400, '找不到这个账号。');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(targetId)) return fail(res, 404, '找不到这个账号。');
  const reverse = db.prepare("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ? AND status = 'pending'").get(targetId, req.user.id);
  const stamp = now();
  if (reverse) {
    db.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, reverse.id);
    return res.json({ accepted: true });
  }
  const existing = db.prepare('SELECT id, status FROM friend_requests WHERE from_user = ? AND to_user = ?').get(req.user.id, targetId);
  if (existing?.status === 'accepted') return res.json({ accepted: true });
  if (existing?.status === 'pending') return res.json({ accepted: false, alreadyPending: true });
  if (existing) {
    db.prepare("UPDATE friend_requests SET status = 'pending', created_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, existing.id);
  } else {
    db.prepare("INSERT INTO friend_requests (from_user, to_user, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
      .run(req.user.id, targetId, stamp, stamp);
  }
  res.status(201).json({ accepted: false });
});

app.post('/api/friend-requests/:id/accept', requireAuth, (req, res) => {
  const requestId = Number(req.params.id);
  const result = db.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ? AND to_user = ? AND status = 'pending'")
    .run(now(), requestId, req.user.id);
  if (!result.changes) return fail(res, 404, '申请已处理或不存在。');
  res.json({ accepted: true });
});

app.delete('/api/friend-requests/:id', requireAuth, (req, res) => {
  const requestId = Number(req.params.id);
  const result = db.prepare("DELETE FROM friend_requests WHERE id = ? AND status = 'pending' AND (from_user = ? OR to_user = ?)")
    .run(requestId, req.user.id, req.user.id);
  if (!result.changes) return fail(res, 404, '申请已处理或不存在。');
  res.json({ removed: true });
});

app.delete('/api/friends/:userId', requireAuth, (req, res) => {
  const targetId = Number(req.params.userId);
  const result = db.prepare("DELETE FROM friend_requests WHERE status = 'accepted' AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))")
    .run(req.user.id, targetId, targetId, req.user.id);
  if (!result.changes) return fail(res, 404, '好友关系不存在。');
  res.json({ removed: true });
});

const extensions = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'], ['audio/aac', '.aac'],
  ['audio/wav', '.wav'], ['audio/x-wav', '.wav'], ['audio/ogg', '.ogg'], ['audio/webm', '.webm'],
]);
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { files: 2, fileSize: maxMediaBytes },
  fileFilter: (_req, file, callback) => {
    const extension = extensions.get(file.mimetype.toLowerCase());
    const isAudio = file.fieldname === 'audio';
    const isMedia = file.fieldname === 'media';
    if ((!isAudio && !isMedia) || !extension || (isAudio && !file.mimetype.startsWith('audio/')) || (isMedia && !/^(image|video)\//.test(file.mimetype))) {
      return callback(new Error('文件格式不支持，请选择常见的照片、MP4 视频或音频文件。'));
    }
    callback(null, true);
  },
});
const saveUpload = (file) => {
  if (!file) return null;
  if (file.fieldname === 'audio' && file.size > maxAudioBytes) throw new Error('配乐文件不能超过 20 MB。');
  const filename = crypto.randomUUID() + extensions.get(file.mimetype.toLowerCase());
  fs.writeFileSync(path.join(mediaDir, filename), file.buffer, { mode: 0o640, flag: 'wx' });
  return filename;
};

app.post('/api/posts', requireAuth, upload.fields([{ name: 'media', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res, next) => {
  const text = String(req.body?.text || '').trim();
  const music = String(req.body?.music || '').trim();
  const media = req.files?.media?.[0] || null;
  const audio = req.files?.audio?.[0] || null;
  if (text.length > 2000) return fail(res, 400, '文字最多 2000 个字符。');
  if (music.length > 160) return fail(res, 400, '配乐名称太长。');
  if (!text && !media && !audio) return fail(res, 400, '请添加文字、照片、视频或配乐。');
  let mediaName = null;
  let audioName = null;
  try {
    mediaName = saveUpload(media);
    audioName = saveUpload(audio);
    const result = db.prepare('INSERT INTO posts (user_id, text, music, media_name, media_type, audio_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, text, music, mediaName, media?.mimetype || null, audioName, now());
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    for (const filename of [mediaName, audioName]) if (filename) fs.rmSync(path.join(mediaDir, filename), { force: true });
    next(error);
  }
});

function mayViewPost(postId, userId) {
  return db.prepare(`
    SELECT 1 FROM posts p WHERE p.id = ? AND (
      p.user_id = ? OR EXISTS (
        SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND (
          (f.from_user = p.user_id AND f.to_user = ?) OR (f.to_user = p.user_id AND f.from_user = ?)
        )
      )
    )
  `).get(postId, userId, userId, userId);
}

function makeMediaUrl(filename, userId) {
  if (!filename) return null;
  const expires = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const signed = userId + ':' + filename + ':' + expires;
  const signature = crypto.createHmac('sha256', jwtSecret).update(signed).digest('base64url');
  return '/api/media/' + encodeURIComponent(filename) + '?u=' + userId + '&e=' + expires + '&s=' + signature;
}

app.get('/api/posts', requireAuth, (req, res) => {
  const userId = req.user.id;
  const posts = db.prepare(`
    SELECT p.id, p.user_id, p.text, p.music, p.media_name, p.media_type, p.audio_name, p.created_at,
      u.username, u.display_name,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? OR EXISTS (
      SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND (
        (f.from_user = p.user_id AND f.to_user = ?) OR (f.to_user = p.user_id AND f.from_user = ?)
      )
    )
    ORDER BY p.created_at DESC LIMIT 100
  `).all(userId, userId, userId, userId).map((post) => ({
    id: post.id,
    userId: post.user_id,
    username: post.username,
    displayName: post.display_name,
    text: post.text,
    music: post.music,
    mediaType: post.media_type,
    mediaUrl: makeMediaUrl(post.media_name, userId),
    audioUrl: makeMediaUrl(post.audio_name, userId),
    createdAt: post.created_at,
    likeCount: post.like_count,
    liked: Boolean(post.liked),
    owned: post.user_id === userId,
  }));
  res.json({ posts });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT media_name, audio_name FROM posts WHERE id = ? AND user_id = ?').get(postId, req.user.id);
  if (!post) return fail(res, 404, '日常不存在或你没有删除权限。');
  db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(postId, req.user.id);
  for (const filename of [post.media_name, post.audio_name]) if (filename) fs.rmSync(path.join(mediaDir, filename), { force: true });
  res.json({ deleted: true });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!mayViewPost(postId, req.user.id)) return fail(res, 404, '日常不存在或暂不可见。');
  db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)').run(req.user.id, postId, now());
  res.json({ liked: true });
});

app.delete('/api/posts/:id/like', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, postId);
  res.json({ liked: false });
});

app.get('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  if (!mayViewPost(postId, req.user.id)) return fail(res, 404, '日常不存在或暂不可见。');
  const comments = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username, u.display_name FROM comments c
    JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at LIMIT 100
  `).all(postId).map((comment) => ({
    id: comment.id, text: comment.text, createdAt: comment.created_at,
    username: comment.username, displayName: comment.display_name,
  }));
  res.json({ comments });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 500) return fail(res, 400, '评论需要 1 到 500 个字符。');
  if (!mayViewPost(postId, req.user.id)) return fail(res, 404, '日常不存在或暂不可见。');
  const result = db.prepare('INSERT INTO comments (user_id, post_id, text, created_at) VALUES (?, ?, ?, ?)').run(req.user.id, postId, text, now());
  res.status(201).json({ id: result.lastInsertRowid });
});

app.get('/api/media/:filename', (req, res) => {
  const filename = path.basename(String(req.params.filename || ''));
  const userId = Number(req.query.u);
  const expires = Number(req.query.e);
  const signature = String(req.query.s || '');
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i.test(filename) || !Number.isInteger(userId) || expires < Date.now() / 1000) {
    return fail(res, 403, '媒体链接已失效。');
  }
  const expected = crypto.createHmac('sha256', jwtSecret).update(userId + ':' + filename + ':' + expires).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return fail(res, 403, '媒体链接无效。'); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return fail(res, 403, '媒体链接无效。');
  if (!db.prepare('SELECT 1 FROM posts WHERE (media_name = ? OR audio_name = ?) AND (user_id = ? OR EXISTS (SELECT 1 FROM friend_requests f WHERE f.status = \'accepted\' AND ((f.from_user = posts.user_id AND f.to_user = ?) OR (f.to_user = posts.user_id AND f.from_user = ?))))')
    .get(filename, filename, userId, userId, userId)) return fail(res, 404, '媒体不存在或暂不可见。');
  const absolutePath = path.join(mediaDir, filename);
  if (!fs.existsSync(absolutePath)) return fail(res, 404, '媒体文件不存在。');
  res.set('Cache-Control', 'private, max-age=300');
  res.sendFile(absolutePath);
});

app.use((_req, res) => fail(res, 404, '找不到这个接口。'));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? '单个媒体文件不能超过 50 MB。' : '上传文件数量超出限制。';
    return fail(res, 400, message);
  }
  if (error.message?.startsWith('文件格式') || error.message?.startsWith('配乐文件')) return fail(res, 400, error.message);
  console.error(error);
  return fail(res, 500, '服务器暂时开小差了，请稍后重试。');
});

const server = app.listen(port, '127.0.0.1', () => {
  console.log('留白 API listening on 127.0.0.1:' + port);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
