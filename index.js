const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { URL } = require('url');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(PUBLIC)) fs.mkdirSync(PUBLIC, { recursive: true });

const sessions = new Map();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(buf.toString() || '{}')); } catch { resolve({}); }
      } else if (ct.includes('multipart/form-data')) {
        resolve(parseMultipart(buf, ct));
      } else {
        try { resolve(JSON.parse(buf.toString() || '{}')); } catch { resolve({}); }
      }
    });
  });
}

function parseMultipart(buf, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return {};
  const boundary = m[1] || m[2];
  const parts = buf.toString('binary').split('--' + boundary);
  const result = { files: [], fields: {} };
  for (const part of parts) {
    if (!part || part === '--' || part === '\r\n') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const fileMatch = headers.match(/filename="([^"]+)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (fileMatch && fileMatch[1]) {
      const ext = path.extname(fileMatch[1]) || '.jpg';
      const saved = randomUUID() + ext;
      fs.writeFileSync(path.join(UPLOADS, saved), Buffer.from(body, 'binary'));
      const p = '/uploads/' + saved;
      result.files.push({ field: name, path: p });
      if (!result[name]) result[name] = [];
      if (Array.isArray(result[name])) result[name].push(p);
    } else {
      result.fields[name] = body;
      result[name] = body;
    }
  }
  return result;
}

function getToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  try { return new URL(req.url, 'http://x').searchParams.get('token'); } catch { return null; }
}

function requireAuth(req, res) {
  const token = getToken(req);
  if (!token || !sessions.has(token)) { send(res, 401, { error: 'Не авторизован' }); return null; }
  const userId = sessions.get(token);
  const user = db.findUserById(userId);
  if (!user) { send(res, 401, { error: 'Пользователь не найден' }); return null; }
  return { userId, user, token };
}

function serveStatic(req, res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const index = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(index)) return send(res, 200, fs.readFileSync(index, 'utf8'), 'text/html; charset=utf-8');
    return send(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, '');

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/uploads/')) return serveStatic(req, res, path.join(ROOT, pathname));
  if (pathname === '/logo.png') return serveStatic(req, res, path.join(ROOT, 'logo.png'));
  if (!pathname.startsWith('/api/')) {
    const fp = pathname === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, pathname);
    return serveStatic(req, res, fp);
  }

  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await parseBody(req) : {};

    if (pathname === '/api/guest' && req.method === 'POST') {
      const guestName = 'Гость_' + Math.random().toString(36).slice(2, 7);
      const user = db.createUser({
        username: 'guest_' + randomUUID().slice(0, 8),
        password: randomUUID(),
        displayName: guestName,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${guestName}`
      });
      const token = randomUUID();
      sessions.set(token, user.id);
      return send(res, 200, { token, user, guest: true });
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      const { username, password, displayName } = body;
      if (!username || !password) return send(res, 400, { error: 'Нужны username и password' });
      const user = db.createUser({ username, password, displayName });
      if (!user) return send(res, 400, { error: 'Username занят' });
      const token = randomUUID();
      sessions.set(token, user.id);
      return send(res, 200, { token, user });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const user = db.findUserByUsername(body.username);
      if (!user || !db.verifyPassword(user, body.password || '')) return send(res, 401, { error: 'Неверный логин или пароль' });
      const token = randomUUID();
      sessions.set(token, user.id);
      return send(res, 200, { token, user: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, bio: user.bio } });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return send(res, 200, { id: auth.user.id, username: auth.user.username, displayName: auth.user.displayName, avatar: auth.user.avatar, bio: auth.user.bio });
    }

    if (pathname === '/api/me' && req.method === 'PATCH') {
      const auth = requireAuth(req, res); if (!auth) return;
      const updates = {};
      if (body.displayName || body.fields?.displayName) updates.displayName = body.displayName || body.fields.displayName;
      if (body.bio !== undefined || body.fields?.bio !== undefined) updates.bio = body.bio ?? body.fields?.bio;
      if (body.files?.length) {
        const av = body.files.find(f => f.field === 'avatar');
        if (av) updates.avatar = av.path;
      }
      return send(res, 200, db.updateUser(auth.userId, updates));
    }

    if (pathname === '/api/posts' && req.method === 'GET') {
      const token = getToken(req);
      const userId = token && sessions.has(token) ? sessions.get(token) : null;
      const posts = db.getPosts({ limit: 100 });
      if (userId) posts.forEach(p => { p.likedByMe = p.likes.includes(userId); p.repostedByMe = p.reposts.includes(userId); });
      return send(res, 200, posts);
    }

    if (pathname === '/api/posts' && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      const text = body.text || body.fields?.text || '';
      const sticker = body.sticker || body.fields?.sticker || null;
      let images = [];
      if (body.files?.length) images = body.files.map(f => f.path);
      const b64raw = body.imagesBase64 || body.fields?.imagesBase64;
      if (b64raw) {
        try {
          const arr = typeof b64raw === 'string' ? JSON.parse(b64raw) : b64raw;
          (arr || []).forEach(b64 => {
            if (typeof b64 === 'string' && b64.startsWith('data:image')) {
              const match = b64.match(/^data:image\/(\w+);base64,(.+)$/);
              if (match) {
                const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                const name = randomUUID() + '.' + ext;
                fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(match[2], 'base64'));
                images.push('/uploads/' + name);
              }
            }
          });
        } catch {}
      }
      const post = db.createPost({ userId: auth.userId, text, images, sticker });
      post.likedByMe = false; post.repostedByMe = false;
      return send(res, 200, post);
    }

    const likeM = pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
    if (likeM && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      const post = db.toggleLike(likeM[1], auth.userId);
      if (!post) return send(res, 404, { error: 'Не найден' });
      post.likedByMe = post.likes.includes(auth.userId);
      post.repostedByMe = post.reposts.includes(auth.userId);
      return send(res, 200, post);
    }

    const repostM = pathname.match(/^\/api\/posts\/([^/]+)\/repost$/);
    if (repostM && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      const post = db.toggleRepost(repostM[1], auth.userId);
      if (!post) return send(res, 404, { error: 'Не найден' });
      post.likedByMe = post.likes.includes(auth.userId);
      post.repostedByMe = post.reposts.includes(auth.userId);
      return send(res, 200, post);
    }

    const cmtM = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
    if (cmtM && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      const comment = db.addComment(cmtM[1], auth.userId, body.text || '', body.sticker || null);
      if (!comment) return send(res, 404, { error: 'Не найден' });
      return send(res, 200, comment);
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 200, { users: [], posts: [] });
      return send(res, 200, { users: db.searchUsers(q), posts: db.searchPosts(q) });
    }

    if (pathname === '/api/stories' && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return send(res, 200, db.getStories());
    }

    if (pathname === '/api/stories' && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      let image = null;
      if (body.files?.length) image = body.files[0].path;
      const story = db.createStory({ userId: auth.userId, image, text: body.text || body.fields?.text || '', sticker: body.sticker || body.fields?.sticker || null });
      return send(res, 200, story);
    }

    if (pathname === '/api/conversations' && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return send(res, 200, db.getConversations(auth.userId));
    }

    if (pathname === '/api/conversations' && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      const otherId = body.userId;
      if (!otherId || otherId === auth.userId) return send(res, 400, { error: 'Некорректный userId' });
      const other = db.findUserById(otherId);
      if (!other) return send(res, 404, { error: 'Не найден' });
      const conv = db.getOrCreateConversation(auth.userId, otherId);
      return send(res, 200, { id: conv.id, other: { id: other.id, username: other.username, displayName: other.displayName, avatar: other.avatar } });
    }

    const msgM = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (msgM && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return send(res, 200, db.getMessages(msgM[1], auth.userId));
    }
    if (msgM && req.method === 'POST') {
      const auth = requireAuth(req, res); if (!auth) return;
      let image = null;
      if (body.files?.length) image = body.files[0].path;
      const msg = db.sendMessage({ conversationId: msgM[1], fromUserId: auth.userId, text: body.text || body.fields?.text || '', sticker: body.sticker || body.fields?.sticker || null, image });
      if (!msg) return send(res, 404, { error: 'Диалог не найден' });
      return send(res, 200, msg);
    }

    if (pathname === '/api/stats') return send(res, 200, db.getStats());

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 Lebato Broza: http://localhost:${PORT}`);
  console.log(`Общая лента — все видят посты друг друга`);
});
