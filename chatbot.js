/**
 * AI Chatbot Module - Handles AI response generation with content filtering
 * @module chatbot
 */

const axios = require('axios');
const crypto = require('crypto');
const dbClient = require('./dbClient');

const MAX_MESSAGE_LENGTH = 5000;
const MAX_CONTEXT_MESSAGES = 15;
const SUMMARY_THRESHOLD = 50;
const MAX_INPUT_LENGTH = 10000;
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_MAX_TOKENS = 500;
const AI_RESPONSE_TIMEOUT_MS = 30000;
const FALLBACK_TIMEOUT_MS = 5000;
const SUMMARY_TEXT_LIMIT = 2000;
const CONTENT_ANALYSIS_LIMIT = 3000;

const forbidden = /harm|kill|bomb|hack|hate|suicide|attack|terror|weapon|explosive|poison|drug.*(make|create|buy)|malware|virus|ransomware|phishing|gamble|lotter/i;

function containsForbiddenPatterns(msg) {
  const lower = msg.toLowerCase();

  if (/hack|exploit|bypass|steal|crack|keygen/i.test(lower) && /(password|wifi|account|license|encryption)/i.test(lower)) {
    return true;
  }

  if (/(how to|steps?|guide|tutorial|instructions for)/i.test(lower) && forbidden.test(lower)) {
    return true;
  }

  return forbidden.test(lower);
}

function sanitizeInput(str) {
  if (typeof str !== 'string') {
    return '';
  }

  return str.slice(0, MAX_INPUT_LENGTH).replace(/[-]/g, '');
}

function isValidMessage(msg) {
  const trimmed = msg.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MESSAGE_LENGTH;
}

function isSafe(msg) {
  return !containsForbiddenPatterns(msg);
}

function getAiProvider() {
  const configuredProvider = (process.env.AI_PROVIDER || '').toLowerCase();

  if (configuredProvider === 'openai' && process.env.OPENAI_API_KEY) {
    return 'openai';
  }

  if (configuredProvider === 'groq' && process.env.GROQ_API_KEY) {
    return 'groq';
  }

  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }

  if (process.env.GROQ_API_KEY) {
    return 'groq';
  }

  return 'fallback';
}

function getAuthHeaders(provider) {
  if (provider === 'openai') {
    return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  }

  if (provider === 'groq') {
    return { Authorization: `Bearer ${process.env.GROQ_API_KEY}` };
  }

  return {};
}

function buildMessages(context, currentMsg) {
  const messages = [];

  if (context) {
    messages.push({ role: 'system', content: 'You are a helpful assistant. Use the prior conversation as context.' });
    messages.push({ role: 'assistant', content: context });
  } else {
    messages.push({ role: 'system', content: 'You are a friendly AI assistant. Have a helpful conversation.' });
  }

  messages.push({ role: 'user', content: currentMsg });
  return messages;
}

async function requestAiCompletion(provider, payload, headers) {
  if (provider === 'openai') {
    const url = 'https://api.openai.com/v1/chat/completions';
    const response = await axios.post(url, payload, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: AI_RESPONSE_TIMEOUT_MS,
    });

    return response.data.choices?.[0]?.message?.content?.trim() || '';
  }

  if (provider === 'groq') {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const response = await axios.post(url, payload, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: AI_RESPONSE_TIMEOUT_MS,
    });

    return response.data.choices?.[0]?.message?.content?.trim() || '';
  }

  return null;
}

async function getFallbackResponse() {
  try {
    const response = await axios.get('https://official-joke-api.appspot.com/random_joke', {
      timeout: FALLBACK_TIMEOUT_MS,
    });

    return `${response.data.setup} ${response.data.punchline}`;
  } catch (error) {
    return 'Interesting! Tell me more.';
  }
}

async function buildContext(userId, sessionId) {
  if (!userId) {
    return '';
  }

  try {
    const chats = await dbClient.getChats(userId, sessionId);
    const recent = Array.isArray(chats) ? chats.slice(-MAX_CONTEXT_MESSAGES) : [];
    return recent.map((chat) => `User: ${chat.user}\nAI: ${chat.ai}`).join('\n');
  } catch (error) {
    return '';
  }
}

async function streamResponse(context, currentMsg, onChunk, chatId, userId, sessionId) {
  const provider = getAiProvider();

  if (provider === 'fallback') {
    const fallback = await getFallbackResponse();
    onChunk(fallback);
    await saveChat(currentMsg, fallback, chatId, userId, sessionId);
    return fallback;
  }

  try {
    const headers = getAuthHeaders(provider);
    const payload = {
      model: provider === 'openai' ? 'gpt-3.5-turbo' : 'llama-3.1-8b-instant',
      messages: buildMessages(context, currentMsg),
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
    };

    const result = await requestAiCompletion(provider, payload, headers);
    const response = result || (await getFallbackResponse());
    onChunk(response);
    await saveChat(currentMsg, response, chatId, userId, sessionId);
    return response;
  } catch (error) {
    const fallback = await getFallbackResponse();
    onChunk(fallback);
    await saveChat(currentMsg, fallback, chatId, userId, sessionId);
    return fallback;
  }
}

async function saveChat(userMsg, aiMsg, chatId, userId, sessionId = 'default') {
  if (!userId) {
    return;
  }

  try {
    await dbClient.ensureUser(userId);
    await dbClient.saveMessage(userId, sessionId, userMsg, aiMsg, chatId || crypto.randomBytes(8).toString('hex').slice(0, 8));

    const allChats = await dbClient.getChats(userId, sessionId);
    const count = Array.isArray(allChats) ? allChats.length : 0;
    const existingSummary = await dbClient.getSummary(userId);

    if (count > SUMMARY_THRESHOLD && !existingSummary) {
      const summary = await createSummary(userId);
      if (summary) {
        await dbClient.setSummary(userId, summary);
      }
    }
  } catch (error) {
    console.debug('saveChat error', error.message);
  }
}

async function createSummary(userId) {
  const provider = getAiProvider();

  if (provider === 'fallback') {
    return 'Summary unavailable without AI provider key.';
  }

  try {
    const sessions = await dbClient.getSessions(userId);
    let allMessages = [];

    for (const sessionId of sessions) {
      const messages = await dbClient.getChats(userId, sessionId);
      allMessages = allMessages.concat(messages || []);
    }

    const recent = allMessages.slice(-20);
    const text = recent.map((message) => `U: ${message.user}\nA: ${message.ai}`).join('\n');
    const prompt = `Summarize this conversation in 2-3 sentences: ${text.slice(0, SUMMARY_TEXT_LIMIT)}`;
    const headers = getAuthHeaders(provider);
    const payload = {
      model: provider === 'openai' ? 'gpt-3.5-turbo' : 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
    };

    return await requestAiCompletion(provider, payload, headers);
  } catch (error) {
    return null;
  }
}

async function analyzeContent(content) {
  const provider = getAiProvider();
  const trimmed = String(content || '').slice(0, CONTENT_ANALYSIS_LIMIT);

  if (provider === 'fallback') {
    return `No AI key configured. Content preview:\n${trimmed}${String(content || '').length > CONTENT_ANALYSIS_LIMIT ? '...' : ''}`;
  }

  try {
    const headers = getAuthHeaders(provider);
    const payload = {
      model: provider === 'openai' ? 'gpt-3.5-turbo' : 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: `Analyze this content and provide a summary: ${trimmed}` }],
      max_tokens: 300,
    };

    return await requestAiCompletion(provider, payload, headers);
  } catch (error) {
    return `Analysis failed: ${error.message}`;
  }
}

async function getAIResponse(context, currentMsg) {
  const provider = getAiProvider();

  if (provider === 'fallback') {
    return getFallbackResponse();
  }

  try {
    const headers = getAuthHeaders(provider);
    const payload = {
      model: provider === 'openai' ? 'gpt-3.5-turbo' : 'llama-3.1-8b-instant',
      messages: buildMessages(context, currentMsg),
      temperature: DEFAULT_TEMPERATURE,
      max_tokens: DEFAULT_MAX_TOKENS,
    };

    const response = await requestAiCompletion(provider, payload, headers);
    return response || (await getFallbackResponse());
  } catch (error) {
    return getFallbackResponse();
  }
}

async function init() {
  return true;
}

async function generate(msg, onChunk = null, userId = null, sessionId = 'default') {
  const sanitized = sanitizeInput(msg);

  if (!isValidMessage(sanitized)) {
    const reply = 'Please provide a valid message (1-5000 characters).';
    if (onChunk) {
      onChunk(reply);
    }
    return reply;
  }

  if (!isSafe(sanitized)) {
    const reply = 'I cannot assist with that request.';
    if (onChunk) {
      onChunk(reply);
    }
    return reply;
  }

  const chatId = crypto.randomBytes(8).toString('hex').slice(0, 8);
  const context = await buildContext(userId, sessionId);

  if (onChunk) {
    return streamResponse(context, sanitized, onChunk, chatId, userId, sessionId);
  }

  const response = await getAIResponse(context, sanitized);
  await saveChat(sanitized, response, chatId, userId, sessionId);
  return response;
}

async function getChats(userId = null, sessionId = null) {
  if (!userId) {
    return [];
  }

  return dbClient.getChats(userId, sessionId);
}

async function getSummary(userId = null) {
  if (!userId) {
    return null;
  }

  return dbClient.getSummary(userId);
}

async function clearChats(userId = null, sessionId = null) {
  if (!userId) {
    return;
  }

  await dbClient.clearChats(userId, sessionId);
}

async function exportChats(userId = null) {
  if (!userId) {
    return JSON.stringify({ sessions: {}, summary: null });
  }

  const data = await dbClient.exportChats(userId);
  return JSON.stringify(data, null, 2);
}

module.exports = {
  generate,
  init,
  analyzeContent,
  getChats,
  getSummary,
  clearChats,
  exportChats,
};
