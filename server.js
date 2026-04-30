const express = require('express');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

// Configuration
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

const chatbot = require('./chatbot.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// File upload config
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Database structure - user-isolated: { users: { userId: { sessions: {}, activeSession: 'default', summary: null } } }
const adapter = new JSONFile('db.json');
const db = new Low(adapter, { users: {}, summary: null });

// User ID middleware - extracts or generates userId for privacy
function getUserId(req, res, next) {
  const userId = req.headers['x-user-id'] || req.query['x-user-id'];
  if (!userId) {
    // Generate anonymized user ID if not provided
    req.userId = 'user_' + crypto.randomBytes(8).toString('hex');
  } else {
    // Sanitize and validate userId
    req.userId = 'user_' + crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  }
  next();
}

// Apply userId middleware to all routes
app.use(getUserId);

// Initialize chatbot with DB
chatbot.init(db);

// Compression middleware
app.use(compression());

// CORS middleware
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true
}));

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Serve static files
app.use(express.static('public'));
app.use(express.json({ limit: '100kb' }));
app.use('/favicon.ico', express.static(path.join('public', 'favicon.svg')));

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\'', '\'unsafe-inline\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
      imgSrc: ['\'self\'', 'data:', 'blob:'],
    },
  },
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
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
app.get('/api/sessions', (req, res) => {
  const userData = db.data.users[req.userId] || { sessions: {}, activeSession: 'default' };
  const sessions = Object.keys(userData.sessions || {}).sort().reverse();
  res.json({ sessions, active: userData.activeSession, userId: req.userId });
});

// Create new session - private to user
app.post('/api/sessions/new', async (req, res) => {
  // Initialize user data if not exists
  db.data.users[req.userId] = db.data.users[req.userId] || { sessions: {}, activeSession: 'default' };
  
  const sessionId = 'chat_' + Date.now();
  db.data.users[req.userId].sessions[sessionId] = [];
  db.data.users[req.userId].activeSession = sessionId;
  await db.write();
  res.json({ sessionId });
});

// Activate session - private to user
app.post('/api/sessions/:sessionId/activate', async (req, res) => {
  const { sessionId } = req.params;
  if (sessionId === 'new') {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  
  const userData = db.data.users[req.userId];
  if (userData?.sessions?.[sessionId]) {
    userData.activeSession = sessionId;
    await db.write();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Get chats - private to user
app.get('/api/chats', (req, res) => {
  const userData = db.data.users[req.userId] || { sessions: {}, activeSession: 'default' };
  const sessionId = req.query.session || userData.activeSession;
  const chats = userData.sessions[sessionId] || [];
  res.json({ chats, summary: userData.summary });
});

// Clear chats - private to user
app.post('/api/chats/clear', async (req, res) => {
  const userData = db.data.users[req.userId];
  if (userData) {
    const sessionId = req.query.session || userData.activeSession;
    if (userData.sessions[sessionId]) {
      userData.sessions[sessionId] = [];
    }
    await db.write();
  }
  res.json({ success: true });
});

// Export chats - private to user (only their own data)
app.get('/api/chats/export', async (req, res) => {
  const userData = db.data.users[req.userId] || { sessions: {}, activeSession: 'default' };
  const data = {
    sessions: userData.sessions,
    activeSession: userData.activeSession,
    summary: userData.summary,
    userId: req.userId
  };
  res.json(data);
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

// WebSocket handling with user-isolated session support
wss.on('connection', (ws, req) => {
  // Get userId from WebSocket connection request (from URL query param)
  const userId = req.url ? new URL(req.url, 'http://localhost').searchParams.get('x-user-id') : null;
  let userIdHash = 'user_' + (userId ? crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16) : crypto.randomBytes(8).toString('hex'));
  
  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data);
      const { msg, sessionId } = payload;
      
      if (!msg) throw new Error('No message provided');
      
      // Initialize user data if not exists
      db.data.users[userIdHash] = db.data.users[userIdHash] || { sessions: { default: [] }, activeSession: 'default' };
      
      // Switch to requested session or use active
      const targetSession = sessionId || db.data.users[userIdHash].activeSession;
      if (!db.data.users[userIdHash].sessions[targetSession]) {
        db.data.users[userIdHash].sessions[targetSession] = [];
      }
      db.data.users[userIdHash].activeSession = targetSession;
      
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
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
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
    await db.read();
  } catch (e) {
    console.error('Failed to read database:', e.message);
  }
  
  // Initialize user-isolated data structure
  db.data.users = db.data.users || {};
  
  try {
    await db.write();
  } catch (e) {
    console.error('Failed to write database:', e.message);
  }
  
  server.listen(PORT, () => {
    console.log('🔒 Private Chatbot running at http://localhost:' + PORT);
  });
};

startServer();
