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

const writeFile = promisify(fs.writeFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../data');
const mediaDir = path.join(dataDir, 'uploads');
const port = Number(process.env.PORT || 8080);
const jwtSecret = process.env.JWT_SECRET || '';
const jamendoClientId = process.env.JAMENDO_CLIENT_ID || '';
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
const postColumns = new Set(db.prepare('PRAGMA table_info(posts)').all().map((column) => column.name));
if (!postColumns.has('music_track_id')) db.exec('ALTER TABLE posts ADD COLUMN music_track_id INTEGER');
if (!postColumns.has('music_artist')) db.exec('ALTER TABLE posts ADD COLUMN music_artist TEXT');
if (!postColumns.has('music_source')) db.exec("ALTER TABLE posts ADD COLUMN music_source TEXT");
if (!postColumns.has('music_preview_url')) db.exec('ALTER TABLE posts ADD COLUMN music_preview_url TEXT');
if (!postColumns.has('music_page_url')) db.exec('ALTER TABLE posts ADD COLUMN music_page_url TEXT');
if (!postColumns.has('visibility')) db.exec("ALTER TABLE posts ADD COLUMN visibility TEXT DEFAULT 'friends'");
if (!postColumns.has('category')) db.exec("ALTER TABLE posts ADD COLUMN category TEXT DEFAULT '日常'");
db.exec(`
  CREATE TABLE IF NOT EXISTS post_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    media_name TEXT NOT NULL,
    media_type TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS post_media_post_idx ON post_media(post_id, sort_order);
`);
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('avatar_name')) db.exec('ALTER TABLE users ADD COLUMN avatar_name TEXT');
const commentColumns = new Set(db.prepare('PRAGMA table_info(comments)').all().map((column) => column.name));
if (!commentColumns.has('parent_id')) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE');

async function getJamendoTracks({ search = '', offset = 0, trackId = null } = {}) {
  if (!jamendoClientId) throw Object.assign(new Error('在线曲库还没有启用：服务器需要配置 Jamendo 客户端编号。'), { status: 503 });
  const url = new URL('https://api.jamendo.com/v3.0/tracks/');
  url.searchParams.set('client_id', jamendoClientId);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', trackId ? '1' : '20');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('audioformat', 'mp32');
  url.searchParams.set('include', 'licenses');
  url.searchParams.set('type', 'single albumtrack');
  if (trackId) url.searchParams.set('id', String(trackId));
  else {
    if (search) {
      // Search titles and artist names directly; requiring Chinese lyrics here
      // hides many relevant tracks whose lyrics language is not tagged.
      url.searchParams.set('search', search);
    } else {
      // Keep recommendations focused on Chinese-language tracks.
      url.searchParams.set('lang', 'zh');
      url.searchParams.set('fuzzytags', 'pop');
      url.searchParams.set('boost', 'popularity_month');
    }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Object.assign(new Error('在线曲库暂时无法连接，请稍后再试。'), { status: 502 });
  const result = await response.json();
  if (result.headers?.status !== 'success' || !Array.isArray(result.results)) {
    throw Object.assign(new Error('在线曲库暂时无法提供歌曲，请稍后再试。'), { status: 502 });
  }
  return result.results;
}

function normalizeJamendoTrack(track) {
  const id = Number(track.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  let pageUrl = 'https://www.jamendo.com/track/' + id;
  try {
    const candidate = new URL(track.shareurl);
    if (candidate.protocol === 'https:' && /(^|\.)jamendo\.com$/i.test(candidate.hostname)) pageUrl = candidate.toString();
  } catch {}
  return {
    id,
    title: String(track.name || '未命名歌曲').slice(0, 150),
    artist: String(track.artist_name || '未知创作者').slice(0, 160),
    pageUrl,
    licenseUrl: typeof track.license_ccurl === 'string' && track.license_ccurl.startsWith('https://') ? track.license_ccurl : '',
  };
}

// iTunes Search API：中文歌 30 秒试听。
// 注意：iTunes API 的 CN 店面在当前网络下经常返回空结果，
// 所以默认用 TW 店面（中文歌目录最全），0 结果时回退 HK。
// 返回的 previewUrl 就是 30 秒试听音频，可直接播放。
async function getItunesTracks({ search = '', offset = 0 } = {}) {
  const term = (search || '中文流行').slice(0, 80);
  const fetchFrom = async (country) => {
    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', term);
    url.searchParams.set('country', country);
    url.searchParams.set('media', 'music');
    url.searchParams.set('entity', 'song');
    url.searchParams.set('limit', '20');
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Liubai/1.0' },
    });
    if (!response.ok) throw Object.assign(new Error('在线曲库暂时无法连接，请稍后再试。'), { status: 502 });
    const result = await response.json();
    if (!Array.isArray(result.results)) {
      throw Object.assign(new Error('在线曲库暂时无法提供歌曲，请稍后再试。'), { status: 502 });
    }
    return result.results;
  };
  let results = await fetchFrom('TW');
  if (!results.length) {
    try { results = await fetchFrom('HK'); } catch {}
  }
  return results;
}

function normalizeItunesTrack(track) {
  const id = Number(track.trackId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const previewUrl = typeof track.previewUrl === 'string' && track.previewUrl.startsWith('https://') ? track.previewUrl : '';
  if (!previewUrl) return null;
  let pageUrl = '';
  try {
    const candidate = new URL(track.trackViewUrl);
    if (candidate.protocol === 'https:' && /(^|\.)apple\.com$/i.test(candidate.hostname)) pageUrl = candidate.toString();
  } catch {}
  if (!pageUrl) pageUrl = 'https://music.apple.com/search?term=' + encodeURIComponent(track.trackName || '');
  const artworkUrl = typeof track.artworkUrl100 === 'string' && track.artworkUrl100.startsWith('https://') ? track.artworkUrl100 : '';
  return {
    id,
    title: String(track.trackName || '未命名歌曲').slice(0, 150),
    artist: String(track.artistName || '未知创作者').slice(0, 160),
    previewUrl,
    artworkUrl,
    pageUrl,
    collectionName: typeof track.collectionName === 'string' ? track.collectionName.slice(0, 160) : '',
    source: 'itunes',
  };
}

async function getItunesPreviewUrl(trackId) {
  for (const country of ['TW', 'HK']) {
    const url = new URL('https://itunes.apple.com/lookup');
    url.searchParams.set('id', String(trackId));
    url.searchParams.set('country', country);
    url.searchParams.set('entity', 'song');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Liubai/1.0' } });
    if (!response.ok) continue;
    const result = await response.json();
    const first = Array.isArray(result.results) ? result.results[0] : null;
    if (first && typeof first.previewUrl === 'string' && first.previewUrl.startsWith('https://')) return first.previewUrl;
  }
  return null;
}

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
const publicUser = (row, viewerId) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  createdAt: row.created_at,
  avatarUrl: row.avatar_name ? makeMediaUrl(row.avatar_name, viewerId || row.id) : null,
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
  const user = db.prepare('SELECT id, username, display_name, avatar_name, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: '账号不存在，请重新登录。' });
  req.user = user;
  next();
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'liubai-api' }));

app.get('/api/music/search', requireAuth, async (req, res) => {
  const search = String(req.query.q || '').trim().slice(0, 80);
  const requestedOffset = Number(req.query.offset || 0);
  const source = String(req.query.source || 'itunes').trim().toLowerCase();
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 2000) return fail(res, 400, '歌曲页码无效。');
  try {
    if (source === 'jamendo') {
      const tracks = await getJamendoTracks({ search, offset: requestedOffset });
      const normalized = tracks.map(normalizeJamendoTrack).filter(Boolean).map((t) => ({ ...t, source: 'jamendo' }));
      return res.json({ tracks: normalized, hasMore: normalized.length === 20, offset: requestedOffset, source: 'jamendo' });
    }
    const tracks = await getItunesTracks({ search, offset: requestedOffset });
    const normalized = tracks.map(normalizeItunesTrack).filter(Boolean);
    res.json({ tracks: normalized, hasMore: normalized.length === 20, offset: requestedOffset, source: 'itunes' });
  } catch (error) {
    fail(res, error.status || 502, error.message || '在线曲库暂时无法连接，请稍后再试。');
  }
});

app.get('/api/music/tracks/:id/audio', async (req, res) => {
  const trackId = Number(req.params.id);
  const source = String(req.query.source || '').trim().toLowerCase();
  if (!Number.isSafeInteger(trackId) || trackId <= 0) return fail(res, 400, '歌曲编号无效。');
  try {
    if (source === 'itunes') {
      const previewUrl = await getItunesPreviewUrl(trackId);
      if (!previewUrl) return fail(res, 404, '这首歌曲暂时不能播放。');
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, previewUrl);
    }
    const tracks = await getJamendoTracks({ trackId });
    const track = tracks[0];
    if (!track || typeof track.audio !== 'string') return fail(res, 404, '这首歌曲暂时不能播放。');
    const audioUrl = new URL(track.audio);
    if (audioUrl.protocol !== 'https:') return fail(res, 502, '歌曲播放地址无效。');
    res.set('Cache-Control', 'no-store');
    res.redirect(302, audioUrl.toString());
  } catch (error) {
    fail(res, error.status || 502, error.message || '歌曲播放失败，请稍后再试。');
  }
});

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
    const user = db.prepare('SELECT id, username, display_name, avatar_name, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json({ token: signToken(user), user: publicUser(user, user.id) });
  } catch (error) { next(error); }
});

app.post('/api/login', limitAuthAttempts, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await checkPassword(password, user.password_hash))) return fail(res, 401, '账号或密码不正确。');
    return res.json({ token: signToken(user), user: publicUser(user, user.id) });
  } catch (error) { next(error); }
});

app.get('/api/me', requireAuth, (req, res) => {
  const friends = db.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE status = 'accepted' AND (from_user = ? OR to_user = ?)").get(req.user.id, req.user.id).n;
  const posts = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?').get(req.user.id).n;
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?').get(req.user.id).n;
  res.json({ ...publicUser(req.user, req.user.id), friendCount: friends, postCount: posts, likeCount: likes });
});

app.get('/api/users', requireAuth, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  if (query.length < 2 || query.length > 40) return res.json({ users: [] });
  const users = db.prepare(`
    SELECT id, username, display_name, avatar_name, created_at FROM users
    WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')
    ORDER BY username LIMIT 30
  `).all(req.user.id, query.replace(/[\\%_]/g, '\\$&') + '%', '%' + query.replace(/[\\%_]/g, '\\$&') + '%');
  res.json({ users: users.map((u) => publicUser(u, req.user.id)) });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const id = req.user.id;
  const friends = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = CASE WHEN f.from_user = ? THEN f.to_user ELSE f.from_user END
    WHERE f.status = 'accepted' AND (f.from_user = ? OR f.to_user = ?) ORDER BY u.display_name
  `).all(id, id, id).map((u) => publicUser(u, id));
  const incoming = db.prepare(`
    SELECT f.id AS request_id, u.id, u.username, u.display_name, u.avatar_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = f.from_user WHERE f.to_user = ? AND f.status = 'pending' ORDER BY f.created_at DESC
  `).all(id).map((row) => ({ requestId: row.request_id, user: publicUser(row, id) }));
  const outgoing = db.prepare(`
    SELECT f.id AS request_id, u.id, u.username, u.display_name, u.avatar_name, u.created_at FROM friend_requests f
    JOIN users u ON u.id = f.to_user WHERE f.from_user = ? AND f.status = 'pending' ORDER BY f.created_at DESC
  `).all(id).map((row) => ({ requestId: row.request_id, user: publicUser(row, id) }));
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
  ['image/heic', '.heic'], ['image/heif', '.heif'], ['image/avif', '.avif'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
  ['video/3gpp', '.3gp'], ['video/x-matroska', '.mkv'], ['video/x-msvideo', '.avi'],
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'], ['audio/aac', '.aac'],
  ['audio/wav', '.wav'], ['audio/x-wav', '.wav'], ['audio/ogg', '.ogg'], ['audio/webm', '.webm'],
]);
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { files: 10, fileSize: maxMediaBytes },
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
const saveUpload = async (file) => {
  if (!file) return null;
  if (file.fieldname === 'audio' && file.size > maxAudioBytes) throw new Error('配乐文件不能超过 20 MB。');
  const filename = crypto.randomUUID() + extensions.get(file.mimetype.toLowerCase());
  await writeFile(path.join(mediaDir, filename), file.buffer, { mode: 0o640, flag: 'wx' });
  return filename;
};

const maxAvatarBytes = 5 * 1024 * 1024;
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: maxAvatarBytes },
  fileFilter: (_req, file, callback) => {
    const ok = file.fieldname === 'avatar' && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype.toLowerCase());
    if (!ok) return callback(new Error('文件格式不支持，请选择 JPG、PNG、WebP 或 GIF 头像。'));
    callback(null, true);
  },
});
app.post('/api/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) return fail(res, 400, '请选择一张头像图片。');
    if (file.size > maxAvatarBytes) return fail(res, 400, '头像不能超过 5 MB。');
    const filename = await saveUpload(file);
    const old = db.prepare('SELECT avatar_name FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET avatar_name = ? WHERE id = ?').run(filename, req.user.id);
    if (old?.avatar_name) fs.rmSync(path.join(mediaDir, old.avatar_name), { force: true });
    res.json({ avatarUrl: makeMediaUrl(filename, req.user.id) });
  } catch (error) { next(error); }
});

const VISIBILITIES = ['public', 'friends', 'private'];
const CATEGORIES = ['日常', '美食', '旅行', '心情', '学习', '运动', '其他'];
function normalizeVisibility(value) {
  const v = String(value || '').trim().toLowerCase();
  return VISIBILITIES.includes(v) ? v : 'friends';
}
function normalizeCategory(value) {
  const c = String(value || '').trim().slice(0, 12);
  return CATEGORIES.includes(c) ? c : '日常';
}

app.post('/api/posts', requireAuth, upload.fields([{ name: 'media', maxCount: 9 }, { name: 'audio', maxCount: 1 }]), async (req, res, next) => {
  const text = String(req.body?.text || '').trim();
  const music = String(req.body?.music || '').trim();
  const musicArtist = String(req.body?.musicArtist || '').trim();
  const musicTrackIdText = String(req.body?.musicTrackId || '').trim();
  const musicTrackId = musicTrackIdText ? Number(musicTrackIdText) : null;
  const musicSourceRaw = String(req.body?.musicSource || '').trim().toLowerCase();
  const musicSource = musicSourceRaw === 'jamendo' ? 'jamendo' : (musicTrackId ? 'itunes' : null);
  let musicPreviewUrl = String(req.body?.musicPreviewUrl || '').trim().slice(0, 1000);
  let musicPageUrl = String(req.body?.musicPageUrl || '').trim().slice(0, 1000);
  // 只接受 https 的预览 / 来源链接，避免存入非法 URL。
  if (musicPreviewUrl && !musicPreviewUrl.startsWith('https://')) musicPreviewUrl = '';
  if (musicPageUrl && !musicPageUrl.startsWith('https://')) musicPageUrl = '';
  // iTunes 试听链接必须是 Apple 官方域名；Jamendo 旧逻辑不走这里。
  if (musicSource === 'itunes' && musicPreviewUrl) {
    try {
      const u = new URL(musicPreviewUrl);
      if (!/(^|\.)apple\.com$/i.test(u.hostname) && u.hostname !== 'audio-ssl.itunes.apple.com') musicPreviewUrl = '';
    } catch { musicPreviewUrl = ''; }
  }
  const visibility = normalizeVisibility(req.body?.visibility);
  const category = normalizeCategory(req.body?.category);
  const mediaFiles = Array.isArray(req.files?.media) ? req.files.media.slice(0, 9) : [];
  const audio = req.files?.audio?.[0] || null;
  if (text.length > 2000) return fail(res, 400, '文字最多 2000 个字符。');
  if (music.length > 160) return fail(res, 400, '配乐名称太长。');
  if (musicArtist.length > 160) return fail(res, 400, '创作者名称太长。');
  if (musicTrackId !== null && (!Number.isSafeInteger(musicTrackId) || musicTrackId <= 0)) return fail(res, 400, '所选歌曲无效，请重新选择。');
  if (audio && musicTrackId) return fail(res, 400, '请只选择一种配乐来源。');
  if (!text && !mediaFiles.length && !audio && !musicTrackId) return fail(res, 400, '请添加文字、照片、视频或配乐。');
  let mediaName = null;
  let mediaType = null;
  let audioName = null;
  const savedMedia = [];
  try {
    for (const file of mediaFiles) {
      const saved = await saveUpload(file);
      savedMedia.push({ name: saved, type: file.mimetype || null });
    }
    audioName = await saveUpload(audio);
    if (savedMedia.length) { mediaName = savedMedia[0].name; mediaType = savedMedia[0].type; }
    const result = db.prepare('INSERT INTO posts (user_id, text, music, media_name, media_type, audio_name, music_track_id, music_artist, music_source, music_preview_url, music_page_url, visibility, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, text, music, mediaName, mediaType, audioName, musicTrackId, musicArtist || null, musicSource, musicPreviewUrl || null, musicPageUrl || null, visibility, category, now());
    const postId = result.lastInsertRowid;
    savedMedia.forEach(function (item, index) {
      db.prepare('INSERT INTO post_media (post_id, media_name, media_type, sort_order) VALUES (?, ?, ?, ?)').run(postId, item.name, item.type, index);
    });
    res.status(201).json({ id: postId });
  } catch (error) {
    for (const item of savedMedia) if (item.name) fs.rmSync(path.join(mediaDir, item.name), { force: true });
    for (const filename of [audioName]) if (filename) fs.rmSync(path.join(mediaDir, filename), { force: true });
    next(error);
  }
});

function isFriendOf(viewerId, ownerId) {
  if (viewerId === ownerId) return true;
  return !!db.prepare(`
    SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND (
      (f.from_user = ? AND f.to_user = ?) OR (f.from_user = ? AND f.to_user = ?)
    )
  `).get(ownerId, viewerId, viewerId, ownerId);
}
function mayViewPost(postId, userId) {
  const row = db.prepare('SELECT user_id, visibility FROM posts WHERE id = ?').get(postId);
  if (!row) return null;
  const visibility = row.visibility || 'friends';
  if (row.user_id === userId) return row;
  if (visibility === 'public') return row;
  if (visibility === 'private') return null;
  return isFriendOf(userId, row.user_id) ? row : null;
}
function postMediaFor(postIds, userId) {
  if (!postIds.length) return new Map();
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT post_id, media_name, media_type FROM post_media WHERE post_id IN (${placeholders}) ORDER BY post_id, sort_order`).all(...postIds);
  const map = new Map(postIds.map((id) => [id, []]));
  rows.forEach(function (row) {
    const url = makeMediaUrl(row.media_name, userId);
    if (url) map.get(row.post_id).push({ type: row.media_type || '', url });
  });
  return map;
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
  const feed = String(req.query.feed || 'friends').trim().toLowerCase() === 'square' ? 'square' : 'friends';
  const categoryParam = String(req.query.category || '').trim().slice(0, 12);
  const categoryFilter = CATEGORIES.includes(categoryParam) ? categoryParam : null;
  let where;
  let params;
  if (feed === 'square') {
    where = "COALESCE(p.visibility, 'friends') = 'public'";
    params = [userId];
    if (categoryFilter) { where += ' AND COALESCE(p.category, \'日常\') = ?'; params.push(categoryFilter); }
  } else {
    where = `(p.user_id = ? OR (COALESCE(p.visibility, 'friends') IN ('public', 'friends') AND EXISTS (
      SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND (
        (f.from_user = p.user_id AND f.to_user = ?) OR (f.to_user = p.user_id AND f.from_user = ?)
      )
    )))`;
    params = [userId, userId, userId, userId];
    if (categoryFilter) { where += ' AND COALESCE(p.category, \'日常\') = ?'; params.push(categoryFilter); }
  }
  const rows = db.prepare(`
    SELECT p.id, p.user_id, p.text, p.music, p.music_track_id, p.music_artist, p.music_source, p.music_preview_url, p.music_page_url, p.media_name, p.media_type, p.audio_name, p.visibility, p.category, p.created_at,
      u.username, u.display_name, u.avatar_name,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE ${where}
    ORDER BY p.created_at DESC LIMIT 50
  `).all(...params);
  const mediaMap = postMediaFor(rows.map((r) => r.id), userId);
  const posts = rows.map((post) => ({
    id: post.id,
    userId: post.user_id,
    username: post.username,
    displayName: post.display_name,
    avatarUrl: post.avatar_name ? makeMediaUrl(post.avatar_name, userId) : null,
    text: post.text,
    music: post.music,
    musicTrackId: post.music_track_id,
    musicArtist: post.music_artist,
    musicSource: post.music_source || (post.music_track_id ? 'jamendo' : null),
    musicPreviewUrl: post.music_preview_url || null,
    musicPageUrl: post.music_page_url || (post.music_track_id ? 'https://www.jamendo.com/track/' + post.music_track_id : null),
    mediaType: post.media_type,
    mediaUrl: makeMediaUrl(post.media_name, userId),
    media: mediaMap.get(post.id) || [],
    audioUrl: makeMediaUrl(post.audio_name, userId),
    visibility: post.visibility || 'friends',
    category: post.category || '日常',
    createdAt: post.created_at,
    likeCount: post.like_count,
    liked: Boolean(post.liked),
    owned: post.user_id === userId,
  }));
  res.json({ posts, feed });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare('SELECT media_name, audio_name FROM posts WHERE id = ? AND user_id = ?').get(postId, req.user.id);
  if (!post) return fail(res, 404, '日常不存在或你没有删除权限。');
  const extra = db.prepare('SELECT media_name FROM post_media WHERE post_id = ?').all(postId);
  db.prepare('DELETE FROM post_media WHERE post_id = ?').run(postId);
  db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(postId, req.user.id);
  const files = [post.media_name, post.audio_name, ...extra.map((r) => r.media_name)];
  for (const filename of files) if (filename) fs.rmSync(path.join(mediaDir, filename), { force: true });
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
    SELECT c.id, c.text, c.created_at, c.parent_id, u.username, u.display_name, u.avatar_name,
      pu.display_name AS parent_display_name, pu.username AS parent_username FROM comments c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN comments pc ON pc.id = c.parent_id
    LEFT JOIN users pu ON pu.id = pc.user_id
    WHERE c.post_id = ? ORDER BY c.created_at LIMIT 100
  `).all(postId).map((comment) => ({
    id: comment.id, text: comment.text, createdAt: comment.created_at,
    username: comment.username, displayName: comment.display_name,
    avatarUrl: comment.avatar_name ? makeMediaUrl(comment.avatar_name, req.user.id) : null,
    parentId: comment.parent_id || null,
    parentUsername: comment.parent_username || null,
    parentDisplayName: comment.parent_display_name || null,
  }));
  res.json({ comments });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 500) return fail(res, 400, '评论需要 1 到 500 个字符。');
  if (!mayViewPost(postId, req.user.id)) return fail(res, 404, '日常不存在或暂不可见。');
  let parentId = null;
  const parentRaw = req.body?.parentId;
  if (parentRaw !== undefined && parentRaw !== null && parentRaw !== '') {
    parentId = Number(parentRaw);
    if (!Number.isSafeInteger(parentId) || parentId <= 0) return fail(res, 400, '回复的评论不存在。');
    const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?').get(parentId, postId);
    if (!parent) return fail(res, 400, '回复的评论不存在。');
  }
  const result = db.prepare('INSERT INTO comments (user_id, post_id, text, parent_id, created_at) VALUES (?, ?, ?, ?, ?)').run(req.user.id, postId, text, parentId, now());
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
  if (!db.prepare(`
    SELECT 1 WHERE EXISTS (
      SELECT 1 FROM posts p WHERE (p.media_name = ? OR p.audio_name = ? OR EXISTS (SELECT 1 FROM post_media pm WHERE pm.post_id = p.id AND pm.media_name = ?))
      AND (p.user_id = ? OR COALESCE(p.visibility, 'friends') = 'public' OR (COALESCE(p.visibility, 'friends') = 'friends' AND EXISTS (SELECT 1 FROM friend_requests f WHERE f.status = 'accepted' AND ((f.from_user = p.user_id AND f.to_user = ?) OR (f.to_user = p.user_id AND f.from_user = ?))))))
    ) OR EXISTS (SELECT 1 FROM users WHERE avatar_name = ?)
  `).get(filename, filename, filename, userId, userId, userId, filename)) return fail(res, 404, '媒体不存在或暂不可见。');
  const absolutePath = path.join(mediaDir, filename);
  if (!fs.existsSync(absolutePath)) return fail(res, 404, '媒体文件不存在。');
  res.set('Cache-Control', 'private, max-age=300');
  res.sendFile(absolutePath);
});

app.use((_req, res) => fail(res, 404, '找不到这个接口。'));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? (String(_req.originalUrl || '').includes('/api/me/avatar') ? '头像不能超过 5 MB。' : '单个媒体文件不能超过 50 MB。') : '上传文件数量超出限制。';
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

