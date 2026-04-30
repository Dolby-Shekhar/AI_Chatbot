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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const adapter = new JSONFile('db.json');
const db = new Low(adapter, { sessions: {}, activeSession: 'default', summary: null });

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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// REST API endpoints
app.get('/api/sessions', (req, res) => {
  const sessions = Object.keys(db.data.sessions || {}).sort().reverse();
  res.json({ sessions, active: db.data.activeSession });
});

// IMPORTANT: Specific routes must come before parameterized routes
app.post('/api/sessions/new', async (req, res) => {
  const sessionId = 'chat_' + Date.now();
  db.data.sessions[sessionId] = [];
  db.data.activeSession = sessionId;
  await db.write();
  res.json({ sessionId });
});

app.post('/api/sessions/:sessionId/activate', async (req, res) => {
  const { sessionId } = req.params;
  // Prevent matching "new" as a sessionId
  if (sessionId === 'new') {
    return res.status(400).json({ error: 'Invalid session ID' });
  }
  if (db.data.sessions[sessionId]) {
    db.data.activeSession = sessionId;
    await db.write();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

app.get('/api/chats', (req, res) => {
  const sessionId = req.query.session || db.data.activeSession;
  const chats = db.data.sessions[sessionId] || [];
  res.json({ chats, summary: db.data.summary });
});

app.post('/api/chats/clear', async (req, res) => {
  const sessionId = req.query.session || db.data.activeSession;
  if (db.data.sessions[sessionId]) {
    db.data.sessions[sessionId] = [];
  }
  await db.write();
  res.json({ success: true });
});

app.get('/api/chats/export', async (req, res) => {
  const data = {
    sessions: db.data.sessions,
    activeSession: db.data.activeSession,
    summary: db.data.summary
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
        // For images, we'd need vision API - use description for now
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
    // Using DuckDuckGo instant API (free, no key)
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

// WebSocket handling with streaming and session support
wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data);
      const { msg, sessionId } = payload;
      
      if (!msg) throw new Error('No message provided');
      
      // Switch to requested session or use active
      const targetSession = sessionId || db.data.activeSession;
      if (!db.data.sessions[targetSession]) {
        db.data.sessions[targetSession] = [];
      }
      db.data.activeSession = targetSession;
      
      // Stream response to client
      let fullResponse = '';
      
      await chatbot.generate(msg, (chunk) => {
        fullResponse += chunk;
        ws.send(JSON.stringify({ type: 'chunk', content: chunk }));
      }, targetSession);
      
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
  
  // Initialize default session
  db.data.sessions = db.data.sessions || { default: [] };
  db.data.activeSession = db.data.activeSession || 'default';
  
  try {
    await db.write();
  } catch (e) {
    console.error('Failed to write database:', e.message);
  }
  
  server.listen(PORT, () => {
    console.log('Chatbot running at http://localhost:' + PORT);
  });
};

startServer();
