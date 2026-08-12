const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4, createHash } = require('crypto');

function hashPass(password) {
  return createHash('sha256').update(String(password) + 'lebato-salt').digest('hex');
}
function checkPass(password, hash) {
  return hashPass(password) === hash;
}

const DB_PATH = path.join(__dirname, 'data.json');

const defaultData = {
  users: [],
  posts: [],
  stories: [],
  messages: [],
  conversations: []
};

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
  return structuredClone(defaultData);
}

function save(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('DB save error:', e.message);
  }
}

let data = load();

// Seed demo user if empty
if (data.users.length === 0) {
  const hash = hashPass('bro123');
  data.users.push({
    id: uuidv4(),
    username: 'bro',
    displayName: 'Бро',
    passwordHash: hash,
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Lebato',
    bio: 'Основатель Lebato Broza 🔥',
    createdAt: Date.now()
  });
  save(data);
}

module.exports = {
  getData: () => data,
  saveData: () => save(data),
  reload: () => { data = load(); return data; },

  // Users
  findUserByUsername(username) {
    return data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  },
  findUserById(id) {
    return data.users.find(u => u.id === id);
  },
  createUser({ username, displayName, password, avatar }) {
    if (this.findUserByUsername(username)) return null;
    const user = {
      id: uuidv4(),
      username: username.toLowerCase().trim(),
      displayName: displayName || username,
      passwordHash: hashPass(password),
      avatar: avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
      bio: '',
      createdAt: Date.now()
    };
    data.users.push(user);
    save(data);
    return { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, bio: user.bio };
  },
  verifyPassword(user, password) {
    return checkPass(password, user.passwordHash);
  },
  updateUser(id, updates) {
    const user = this.findUserById(id);
    if (!user) return null;
    if (updates.displayName) user.displayName = updates.displayName;
    if (updates.bio !== undefined) user.bio = updates.bio;
    if (updates.avatar) user.avatar = updates.avatar;
    save(data);
    return { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, bio: user.bio };
  },
  searchUsers(q) {
    q = q.toLowerCase();
    return data.users
      .filter(u => u.username.includes(q) || u.displayName.toLowerCase().includes(q))
      .map(u => ({ id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, bio: u.bio }))
      .slice(0, 20);
  },

  // Posts
  getPosts({ limit = 50, offset = 0 } = {}) {
    return data.posts
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit)
      .map(p => this.enrichPost(p));
  },
  getPost(id) {
    const p = data.posts.find(x => x.id === id);
    return p ? this.enrichPost(p) : null;
  },
  enrichPost(p) {
    const author = this.findUserById(p.userId);
    return {
      ...p,
      author: author ? {
        id: author.id,
        username: author.username,
        displayName: author.displayName,
        avatar: author.avatar
      } : { id: '?', username: 'deleted', displayName: 'Удалён', avatar: '' },
      likesCount: p.likes.length,
      repostsCount: p.reposts.length,
      commentsCount: p.comments.length
    };
  },
  createPost({ userId, text, images = [], sticker = null, isRepost = false, originalPostId = null, repostedBy = null }) {
    const post = {
      id: uuidv4(),
      userId,
      text: text || '',
      images,
      sticker,
      likes: [],
      reposts: [],
      comments: [],
      createdAt: Date.now(),
      isRepost,
      originalPostId,
      repostedBy
    };
    data.posts.unshift(post);
    save(data);
    return this.enrichPost(post);
  },
  toggleLike(postId, userId) {
    const post = data.posts.find(p => p.id === postId);
    if (!post) return null;
    const idx = post.likes.indexOf(userId);
    if (idx === -1) post.likes.push(userId);
    else post.likes.splice(idx, 1);
    save(data);
    return this.enrichPost(post);
  },
  toggleRepost(postId, userId) {
    const post = data.posts.find(p => p.id === postId);
    if (!post) return null;
    const idx = post.reposts.indexOf(userId);
    if (idx === -1) {
      post.reposts.push(userId);
      // create repost entry
      this.createPost({
        userId,
        text: post.text,
        images: post.images,
        sticker: post.sticker,
        isRepost: true,
        originalPostId: postId,
        repostedBy: userId
      });
    } else {
      post.reposts.splice(idx, 1);
      data.posts = data.posts.filter(p => !(p.isRepost && p.originalPostId === postId && p.userId === userId));
    }
    save(data);
    return this.enrichPost(post);
  },
  addComment(postId, userId, text, sticker = null) {
    const post = data.posts.find(p => p.id === postId);
    if (!post) return null;
    const comment = {
      id: uuidv4(),
      userId,
      text: text || '',
      sticker,
      createdAt: Date.now()
    };
    post.comments.push(comment);
    save(data);
    const author = this.findUserById(userId);
    return {
      ...comment,
      author: author ? {
        id: author.id,
        username: author.username,
        displayName: author.displayName,
        avatar: author.avatar
      } : null
    };
  },
  searchPosts(q) {
    q = q.toLowerCase();
    return data.posts
      .filter(p => (p.text || '').toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map(p => this.enrichPost(p));
  },
  deletePost(postId, userId) {
    const idx = data.posts.findIndex(p => p.id === postId && p.userId === userId);
    if (idx === -1) return false;
    data.posts.splice(idx, 1);
    save(data);
    return true;
  },

  // Stories (24h)
  getStories() {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // cleanup old
    data.stories = data.stories.filter(s => now - s.createdAt < day);
    save(data);
    // group by user
    const byUser = {};
    data.stories.forEach(s => {
      if (!byUser[s.userId]) byUser[s.userId] = [];
      byUser[s.userId].push(s);
    });
    return Object.entries(byUser).map(([userId, stories]) => {
      const user = this.findUserById(userId);
      return {
        user: user ? {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar
        } : null,
        stories: stories.sort((a, b) => a.createdAt - b.createdAt)
      };
    }).filter(x => x.user);
  },
  createStory({ userId, image, text = '', sticker = null }) {
    const story = {
      id: uuidv4(),
      userId,
      image,
      text,
      sticker,
      createdAt: Date.now(),
      views: []
    };
    data.stories.push(story);
    save(data);
    return story;
  },
  viewStory(storyId, userId) {
    const story = data.stories.find(s => s.id === storyId);
    if (!story) return null;
    if (!story.views.includes(userId)) {
      story.views.push(userId);
      save(data);
    }
    return story;
  },

  // Messages
  getOrCreateConversation(userA, userB) {
    let conv = data.conversations.find(c =>
      (c.participants[0] === userA && c.participants[1] === userB) ||
      (c.participants[0] === userB && c.participants[1] === userA)
    );
    if (!conv) {
      conv = {
        id: uuidv4(),
        participants: [userA, userB],
        updatedAt: Date.now()
      };
      data.conversations.push(conv);
      save(data);
    }
    return conv;
  },
  getConversations(userId) {
    return data.conversations
      .filter(c => c.participants.includes(userId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(c => {
        const otherId = c.participants.find(id => id !== userId);
        const other = this.findUserById(otherId);
        const msgs = data.messages.filter(m => m.conversationId === c.id);
        const last = msgs[msgs.length - 1];
        return {
          id: c.id,
          other: other ? {
            id: other.id,
            username: other.username,
            displayName: other.displayName,
            avatar: other.avatar
          } : null,
          lastMessage: last ? { text: last.text, sticker: last.sticker, createdAt: last.createdAt, fromMe: last.fromUserId === userId } : null,
          updatedAt: c.updatedAt
        };
      });
  },
  getMessages(conversationId, userId) {
    const conv = data.conversations.find(c => c.id === conversationId);
    if (!conv || !conv.participants.includes(userId)) return [];
    return data.messages
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(m => ({
        ...m,
        fromMe: m.fromUserId === userId
      }));
  },
  sendMessage({ conversationId, fromUserId, text, sticker = null, image = null }) {
    const conv = data.conversations.find(c => c.id === conversationId);
    if (!conv || !conv.participants.includes(fromUserId)) return null;
    const msg = {
      id: uuidv4(),
      conversationId,
      fromUserId,
      text: text || '',
      sticker,
      image,
      createdAt: Date.now()
    };
    data.messages.push(msg);
    conv.updatedAt = Date.now();
    save(data);
    return { ...msg, fromMe: true };
  },

  // Stats
  getStats() {
    return {
      users: data.users.length,
      posts: data.posts.length,
      stories: data.stories.length,
      messages: data.messages.length
    };
  }
};
