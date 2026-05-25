const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

// Configuration
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

const chatbot = require('./chatbot.js');
const dbClient = require('./dbClient');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// File upload config
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Using dbClient (SQLite or JSON fallback) for persistent storage

// User ID middleware - extracts or generates userId for privacy
function getUserId(req, res, next) {
  // Prefer Authorization bearer token
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
      req.userId = payload.sub;
      return next();
    } catch (e) {
      // invalid token, fall through to anon id
    }
  }

  const userId = req.headers['x-user-id'] || req.query['x-user-id'];
  if (!userId) {
    // Generate anonymized user ID if not provided
    req.userId = 'anon_' + crypto.randomBytes(8).toString('hex');
  } else {
    // Sanitize and validate userId
    req.userId = 'user_' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  }
  next();
}

// Apply userId middleware to all routes
app.use(getUserId);

// Initialize chatbot with DB client
chatbot.init(dbClient);

// Compression middleware
app.use(compression());

// CORS middleware
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true
}));

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Serve static files
app.use(express.static('public'));
app.use(express.json({ limit: '100kb' }));
app.use('/favicon.ico', express.static(path.join('public', 'favicon.svg')));

// Security middleware - stricter CSP and allow CDN for DOMPurify and Google Fonts
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));

// Rate limiting (keyed by userId for fair per-user limits)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.userId || rateLimit.ipKeyGenerator(req),
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// REST API endpoints - user private
app.get('/api/sessions', async (req, res) => {
  await dbClient.ensureUser(req.userId);
  const sessions = await dbClient.getSessions(req.userId);
  const active = await dbClient.getActiveSession(req.userId);
  res.json({ sessions, active, userId: req.userId });
});

// Create new session - private to user
app.post('/api/sessions/new', async (req, res) => {
  await dbClient.ensureUser(req.userId);
  const sessionId = await dbClient.createSession(req.userId);
  res.json({ sessionId, active: sessionId });
});

// Activate session - private to user
app.post('/api/sessions/:sessionId/activate', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId || sessionId === 'new') return res.status(400).json({ error: 'Invalid session ID' });
  const sessions = await dbClient.getSessions(req.userId);
  if (!sessions.includes(sessionId)) return res.status(404).json({ error: 'Session not found' });
  await dbClient.setActiveSession(req.userId, sessionId);
  res.json({ success: true, active: sessionId });
});

// Get chats - private to user
app.get('/api/chats', async (req, res) => {
  const sessionId = req.query.session || undefined;
  const chats = await dbClient.getChats(req.userId, sessionId);
  const summary = await dbClient.getSummary(req.userId);
  res.json({ chats, summary });
});

// Clear chats - private to user
app.post('/api/chats/clear', async (req, res) => {
  const sessionId = req.query.session || undefined;
  await dbClient.clearChats(req.userId, sessionId);
  res.json({ success: true });
});

// Chat endpoint for REST clients
app.post('/api/chat', async (req, res) => {
  const { msg, sessionId } = req.body || {};
  if (!msg || typeof msg !== 'string') {
    return res.status(400).json({ error: 'msg is required' });
  }

  await dbClient.ensureUser(req.userId);
  const targetSession = sessionId || await dbClient.getActiveSession(req.userId);
  const response = await chatbot.generate(msg, null, req.userId, targetSession);
  res.json({ message: response, sessionId: targetSession });
});

app.get('/api/me', async (req, res) => {
  await dbClient.ensureUser(req.userId);
  const active = await dbClient.getActiveSession(req.userId);
  res.json({ userId: req.userId, active });
});

// Export chats - private to user (only their own data)
app.get('/api/chats/export', async (req, res) => {
  const data = await dbClient.exportChats(req.userId);
  res.json({ ...data, userId: req.userId });
});

// File upload endpoint
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    if (!req.file && !req.body.text) {
      return res.status(400).json({ error: 'No file or text provided' });
    }
    
    let content = '';
    
    if (req.file) {
      if (req.file.mimetype === 'text/plain' || req.file.mimetype === 'text/markdown') {
        content = req.file.buffer.toString('utf8');
      } else if (req.file.mimetype.includes('image')) {
        content = `[Image uploaded: ${req.file.originalname}]`;
      } else {
        return res.status(400).json({ error: 'Unsupported file type' });
      }
    } else {
      content = req.body.text;
    }
    
    const analysis = await chatbot.analyzeContent(content);
    res.json({ analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Web search endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'No query provided' });
  
  try {
    const response = await axios.get('https://api.duckduckgo.com/', {
      params: {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1
      },
      timeout: 5000
    });
    
    const data = response.data;
    let result = data.AbstractText || '';
    
    if (!result && data.RelatedTopics?.length) {
      result = data.RelatedTopics[0].Text || 'No result found';
    }
    
    res.json({ query, result, source: data.AbstractSource });
  } catch (e) {
    res.status(500).json({ error: 'Search failed: ' + e.message });
  }
});

// Auth endpoints: register & login (simple username/password)
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const userId = 'user_' + crypto.createHash('sha256').update(username).digest('hex').slice(0, 16);
  const existing = await dbClient.getUser(userId);
  if (existing && existing.password_hash) {
    return res.status(409).json({ error: 'User already exists' });
  }
  const hash = bcrypt.hashSync(password, 10);
  if (dbClient.useSqlite) {
    dbClient.stmts.insertUser.run(userId, hash, Date.now());
  } else {
    await dbClient.ensureUser(userId);
    dbClient.data.users[userId].password_hash = hash;
    dbClient._writeJson();
  }
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '30d' });
  res.json({ token, userId });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const userId = 'user_' + crypto.createHash('sha256').update(username).digest('hex').slice(0, 16);
  const row = await dbClient.getUser(userId);
  const hash = row ? row.password_hash : null;
  if (!hash || !bcrypt.compareSync(password, hash)) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '30d' });
  res.json({ token, userId });
});

// WebSocket handling with user-isolated session support
wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = urlObj.searchParams.get('token');
  const userIdParam = urlObj.searchParams.get('x-user-id');
  let userIdHash = 'anon_' + crypto.randomBytes(8).toString('hex');

  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
      userIdHash = payload.sub;
    } catch (e) {
      // continue with anonymous fallback
    }
  } else if (userIdParam) {
    userIdHash = 'user_' + crypto.createHash('sha256').update(userIdParam).digest('hex').slice(0, 16);
  }
  // ensure user exists in DB
  dbClient.ensureUser(userIdHash).catch(() => {});
  
  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data);
      const { msg, sessionId } = payload;
      
      if (!msg) throw new Error('No message provided');
      
      // Ensure session exists
      const targetSession = sessionId || 'default';
      await dbClient.ensureUser(userIdHash);
      // create session record if not exists
      const sessions = await dbClient.getSessions(userIdHash);
      if (!sessions.includes(targetSession)) {
        await dbClient.createSession(userIdHash, targetSession);
      }
      
      // Stream response to client
      let fullResponse = '';
      
      await chatbot.generate(msg, (chunk) => {
        fullResponse += chunk;
        ws.send(JSON.stringify({ type: 'chunk', content: chunk }));
      }, userIdHash, targetSession);
      
      ws.send(JSON.stringify({ type: 'done', content: fullResponse }));
      
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', content: e.message }));
    }
  });
});

// Global error handler middleware
app.use((err, req, res, _next) => {
  console.error('Server error:', err && err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Uncaught exception handler
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  process.exit(1);
});

// Start server
const startServer = async () => {
  try {
    await dbClient.init();
  } catch (e) {
    console.error('Failed to initialize DB client:', e.message);
  }
  
  server.listen(PORT, () => {
    console.log('🔒 Private Chatbot running at http://localhost:' + PORT);
  });
};

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer };
