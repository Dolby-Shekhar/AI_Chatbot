/**
 * AI Chatbot Module - Handles AI response generation with content filtering
 * @module chatbot
 * @requires axios
 * @requires crypto
 */

const axios = require('axios');
const crypto = require('crypto');

// Configuration Constants
const MAX_MESSAGE_LENGTH = 5000;
const MAX_CONTEXT_MESSAGES = 15;
const SUMMARY_THRESHOLD = 50;
const MAX_INPUT_LENGTH = 10000;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 500;
const STREAM_TIMEOUT_MS = 60000;
const AI_RESPONSE_TIMEOUT_MS = 30000;
const FALLBACK_TIMEOUT_MS = 5000;
const SUMMARY_TEXT_LIMIT = 2000;
const CONTENT_ANALYSIS_LIMIT = 3000;

// Enhanced content filtering - block harmful requests
const forbidden = /harm|kill|bomb|hack|hate|suicide|attack|terror|weapon|explosive|poison|drug.*(make|create|buy)|malware|virus|ransomware|phishing|gamble|lotter/i;

/**
 * Check for suspicious patterns in user messages
 * @param {string} msg - User message to check
 * @returns {boolean} True if message contains forbidden patterns
 */
function containsForbiddenPatterns(msg) {
  const lower = msg.toLowerCase();
  // Block requests to write code for harmful purposes
  if (/hack|exploit|bypass|steal|crack|keygen/i.test(lower) && /(password|wifi|account|license|encryption)/i.test(lower)) {
    return true;
  }
  // Block instructions for harmful activities
  if (/(how to|steps?|指南|教程| instructions for)/i.test(lower) && forbidden.test(lower)) {
    return true;
  }
  return forbidden.test(lower);
}

// Input sanitization
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.slice(0, 10000).replace(/[\x00-\x1F\x7F]/g, '');
}

// Validate message
function isValidMessage(msg) {
  return msg && msg.trim().length > 0 && msg.trim().length <= 5000;
}

let db = null;

function init(database) {
  db = database;
}

async function generate(msg, onChunk, userId = null, sessionId = 'default') {
  // Sanitize and validate input
  const sanitized = sanitizeInput(msg);
  if (!isValidMessage(sanitized)) {
    const msg = "Please provide a valid message (1-5000 characters).";
    if (onChunk) onChunk(msg);
    return msg;
  }
  
  if (!isSafe(sanitized)) {
    const msg = "Can't help with unsafe requests.";
    if (onChunk) onChunk(msg);
    return msg;
  }

  const chatId = crypto.randomBytes(8).toString('hex').slice(0, 8);
  const context = buildContext(userId, sessionId);
  
  if (onChunk) {
    return await streamResponse(context, msg, onChunk, chatId, userId, sessionId);
  }
  
  const response = await getAIResponse(context, msg);
  await saveChat(msg, response, chatId, userId, sessionId);
  return response;
}

function isSafe(msg) {
  return !containsForbiddenPatterns(msg);
}

function buildContext(userId, sessionId) {
  if (!userId || !db?.data?.users?.[userId]?.sessions?.[sessionId]) return '';
  
  const chats = db.data.users[userId].sessions[sessionId] || [];
  const recent = chats.slice(-15);
  if (recent.length === 0) return '';
  
  return recent.map(c => `User: ${c.user}\nAI: ${c.ai}`).join('\n');
}

async function streamResponse(context, currentMsg, onChunk, chatId, userId, sessionId) {
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    const fallback = await getFallbackResponse();
    onChunk(fallback);
    await saveChat(currentMsg, fallback, chatId, userId, sessionId);
    return fallback;
  }
  
  try {
    const messages = [];
    
    if (context) {
      messages.push({ role: 'system', content: 'You are having a conversation. Remember the context from earlier.' });
      messages.push({ role: 'assistant', content: context });
    } else {
      messages.push({ role: 'system', content: 'You are a friendly, helpful AI assistant. Have natural, engaging conversations.' });
    }
    
    messages.push({ role: 'user', content: currentMsg });
    
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: messages,
      temperature: 0.8,
      max_tokens: 500,
      stream: true
    }, {
      headers: { 
        Authorization: `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      responseType: 'stream',
      timeout: 60000
    });
    
    let fullResponse = '';
    
    res.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullResponse += content;
              onChunk(content);
            }
          } catch (e) {}
        }
      }
    });
    
    await new Promise(resolve => res.data.on('end', resolve));
    
    fullResponse = fullResponse.trim();
    if (!fullResponse) fullResponse = await getFallbackResponse();
    
    await saveChat(currentMsg, fullResponse, chatId, userId, sessionId);
    return fullResponse;
    
  } catch (e) {
    console.log('Stream error:', e.message);
    const fallback = await getFallbackResponse();
    onChunk(fallback);
    await saveChat(currentMsg, fallback, chatId, userId, sessionId);
    return fallback;
  }
}

async function getAIResponse(context, currentMsg) {
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) return getFallbackResponse();
  
  try {
    const messages = [];
    
    if (context) {
      messages.push({ role: 'system', content: 'You are having a conversation. Remember the context from earlier.' });
      messages.push({ role: 'assistant', content: context });
    } else {
      messages.push({ role: 'system', content: 'You are a friendly, helpful AI assistant.' });
    }
    
    messages.push({ role: 'user', content: currentMsg });
    
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: messages,
      temperature: 0.8,
      max_tokens: 500
    }, {
      headers: { 
        Authorization: `Bearer ${apiKey}`, 
        'Content-Type': 'application/json' 
      },
      timeout: 30000
    });
    
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    console.log('AI error:', e.message);
    return getFallbackResponse();
  }
}

async function getFallbackResponse() {
  try {
    const res = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 5000 });
    return `${res.data.setup} ${res.data.punchline}`;
  } catch {
    return 'Interesting! Tell me more.';
  }
}

async function saveChat(userMsg, aiMsg, chatId, userId, sessionId = 'default') {
  if (!db || !userId) return;
  
  // Initialize user data structure if needed
  db.data.users[userId] = db.data.users[userId] || { sessions: {}, activeSession: 'default' };
  db.data.users[userId].sessions[sessionId] = db.data.users[userId].sessions[sessionId] || [];
  
  db.data.users[userId].sessions[sessionId].push({ 
    user: userMsg, 
    ai: aiMsg, 
    chatId: chatId || 'default',
    timestamp: Date.now() 
  });
  
  // Only create summary for this user's chats
  const userChats = Object.values(db.data.users[userId].sessions).flat();
  if (userChats.length > 50 && !db.data.users[userId].summary) {
    db.data.users[userId].summary = await createSummary(userId);
  }
  
  await db.write();
}

async function createSummary(userId) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !userId) return null;
  
  const userData = db.data.users[userId];
  if (!userData) return null;
  
  const allChats = Object.values(userData.sessions || {}).flat();
  const recent = allChats.slice(-20);
  const text = recent.map(c => `U: ${c.user}\nA: ${c.ai}`).join('\n');
  
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: `Summarize this conversation in 2-3 sentences: ${text.slice(0, 2000)}` }],
      max_tokens: 100
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    
    return res.data.choices[0].message.content.trim();
  } catch {
    return null;
  }
}

async function analyzeContent(content) {
  const apiKey = process.env.GROQ_API_KEY;
  
  if (!apiKey) {
    return 'File analysis requires GROQ_API_KEY. Set it in your environment.';
  }
  
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.1-8b-instant',
      messages: [{ 
        role: 'user', 
        content: `Analyze this content and provide a summary: ${content.slice(0, 3000)}` 
      }],
      max_tokens: 300
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    
    return res.data.choices[0].message.content.trim();
  } catch (e) {
    return 'Analysis failed: ' + e.message;
  }
}

function getChats(userId = null, sessionId = null) {
  if (!db || !userId) return [];
  const userData = db.data.users[userId];
  if (!userData) return [];
  if (sessionId) {
    return userData.sessions[sessionId] || [];
  }
  return Object.values(userData.sessions || {}).flat();
}

function getSummary(userId = null) {
  if (!db || !userId) return null;
  const userData = db.data.users[userId];
  return userData?.summary || null;
}

async function clearChats(userId = null, sessionId = null) {
  if (!db || !userId) return;
  const userData = db.data.users[userId];
  if (!userData) return;
  
  if (sessionId) {
    userData.sessions[sessionId] = [];
  } else {
    userData.sessions = {};
  }
  userData.summary = null;
  await db.write();
}

async function exportChats(userId = null) {
  if (!db || !userId) return JSON.stringify({ sessions: {}, summary: null });
  const userData = db.data.users[userId] || { sessions: {}, activeSession: 'default' };
  return JSON.stringify({ 
    sessions: userData.sessions, 
    summary: userData.summary 
  }, null, 2);
}

module.exports = { 
  generate, 
  init, 
  analyzeContent,
  getChats, 
  getSummary, 
  clearChats, 
  exportChats 
};
