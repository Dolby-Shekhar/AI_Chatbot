const path = require('path');
const fs = require('fs');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.warn('better-sqlite3 not installed; fallback to JSON DB');
  Database = null;
}

const dataDirRaw = process.env.DATA_DIR || 'data';
const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(__dirname, dataDirRaw);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const sqlitePath = path.join(dataDir, 'app.db');

class DBClient {
  constructor() {
    this.useSqlite = !!Database;
    if (this.useSqlite) {
      this.db = new Database(sqlitePath);
      this._initSqlite();
    } else {
      // fallback to JSON file
      this.jsonFile = path.join(dataDir, 'db.json');
      if (!fs.existsSync(this.jsonFile)) fs.writeFileSync(this.jsonFile, JSON.stringify({ users: {}, summary: null }, null, 2));
      this.data = JSON.parse(fs.readFileSync(this.jsonFile, 'utf8'));
    }
  }

  _initSqlite() {
    const createUsers = `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      password_hash TEXT,
      created_at INTEGER
    )`;
    const createSessions = `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_at INTEGER,
      active INTEGER DEFAULT 0
    )`;
    const createMessages = `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      session_id TEXT,
      role TEXT,
      user_msg TEXT,
      ai_msg TEXT,
      chat_id TEXT,
      timestamp INTEGER
    )`;
    const createSummaries = `CREATE TABLE IF NOT EXISTS summaries (
      user_id TEXT PRIMARY KEY,
      summary TEXT
    )`;

    this.db.exec(createUsers);
    this.db.exec(createSessions);
    this.db.exec(createMessages);
    this.db.exec(createSummaries);

    // Prepared statements
    this.stmts = {
      getUser: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      insertUser: this.db.prepare('INSERT OR REPLACE INTO users (id, password_hash, created_at) VALUES (?, ?, ?)'),
      createSession: this.db.prepare('INSERT OR REPLACE INTO sessions (id, user_id, created_at, active) VALUES (?, ?, ?, ?)'),
      getSessions: this.db.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC'),
      insertMessage: this.db.prepare('INSERT INTO messages (user_id, session_id, role, user_msg, ai_msg, chat_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      getMessages: this.db.prepare('SELECT user_msg as user, ai_msg as ai, chat_id, timestamp FROM messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp ASC'),
      clearMessages: this.db.prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?'),
      getSummary: this.db.prepare('SELECT summary FROM summaries WHERE user_id = ?'),
      upsertSummary: this.db.prepare('INSERT OR REPLACE INTO summaries (user_id, summary) VALUES (?, ?)')
    };
  }

  async init() {
    // noop for now
  }

  async ensureUser(userId) {
    if (!this.useSqlite) {
      this.data.users[userId] = this.data.users[userId] || { sessions: { default: [] }, activeSession: 'default', summary: null, password_hash: null };
      this._writeJson();
      return;
    }
    const row = this.stmts.getUser.get(userId);
    if (!row) {
      this.stmts.insertUser.run(userId, null, Date.now());
    }
  }

  async getUser(userId) {
    if (this.useSqlite) {
      return this.stmts.getUser.get(userId);
    }
    return this.data.users[userId] || null;
  }

  async setActiveSession(userId, sessionId) {
    await this.ensureUser(userId);
    if (this.useSqlite) {
      const tx = this.db.transaction(() => {
        this.db.prepare('UPDATE sessions SET active = 0 WHERE user_id = ?').run(userId);
        this.stmts.createSession.run(sessionId, userId, Date.now(), 1);
      });
      tx();
    } else {
      this.data.users[userId].sessions[sessionId] = this.data.users[userId].sessions[sessionId] || [];
      this.data.users[userId].activeSession = sessionId;
      this._writeJson();
    }
    return sessionId;
  }

  async getActiveSession(userId) {
    if (this.useSqlite) {
      const row = this.db.prepare('SELECT id FROM sessions WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1').get(userId);
      return row ? row.id : 'default';
    }
    return this.data.users[userId]?.activeSession || 'default';
  }

  async createSession(userId, sessionId = null) {
    const sid = sessionId || ('chat_' + Date.now());
    await this.setActiveSession(userId, sid);
    return sid;
  }

  async getSessions(userId) {
    if (this.useSqlite) {
      return this.stmts.getSessions.all(userId).map(r => r.id);
    }
    return Object.keys(this.data.users[userId]?.sessions || {}).sort().reverse();
  }

  async saveMessage(userId, sessionId, userMsg, aiMsg, chatId) {
    const sid = sessionId || (await this.getActiveSession(userId)) || 'default';
    if (this.useSqlite) {
      this.stmts.insertMessage.run(userId, sid, 'user', userMsg, aiMsg, chatId, Date.now());
    } else {
      await this.ensureUser(userId);
      this.data.users[userId].sessions[sid] = this.data.users[userId].sessions[sid] || [];
      this.data.users[userId].sessions[sid].push({ user: userMsg, ai: aiMsg, chatId: chatId || 'default', timestamp: Date.now() });
      this._writeJson();
    }
  }

  async getChats(userId, sessionId) {
    const sid = sessionId || (await this.getActiveSession(userId)) || 'default';
    if (this.useSqlite) {
      return this.stmts.getMessages.all(userId, sid);
    }
    await this.ensureUser(userId);
    return this.data.users[userId].sessions[sid] || [];
  }

  async clearChats(userId, sessionId) {
    const sid = sessionId || (await this.getActiveSession(userId)) || 'default';
    if (this.useSqlite) {
      this.stmts.clearMessages.run(userId, sid);
    } else {
      if (this.data.users[userId]) {
        this.data.users[userId].sessions[sid] = [];
        this.data.users[userId].summary = null;
        this._writeJson();
      }
    }
  }

  async getSummary(userId) {
    if (this.useSqlite) {
      const row = this.stmts.getSummary.get(userId);
      return row ? row.summary : null;
    }
    return this.data.users[userId]?.summary || null;
  }

  async setSummary(userId, summary) {
    if (this.useSqlite) {
      this.stmts.upsertSummary.run(userId, summary);
    } else {
      this.data.users[userId] = this.data.users[userId] || { sessions: {}, activeSession: 'default', summary: null };
      this.data.users[userId].summary = summary;
      this._writeJson();
    }
  }

  async exportChats(userId) {
    if (this.useSqlite) {
      const sessions = await this.getSessions(userId);
      const out = {};
      for (const s of sessions) {
        out[s] = await this.getChats(userId, s);
      }
      return { sessions: out, summary: await this.getSummary(userId) };
    }
    return { sessions: this.data.users[userId]?.sessions || {}, summary: this.data.users[userId]?.summary || null };
  }

  _writeJson() {
    fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2));
  }
}

module.exports = new DBClient();
