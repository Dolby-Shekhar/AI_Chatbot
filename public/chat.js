/* global DOMPurify */

const chatDiv = document.getElementById('chat');
const input = document.getElementById('input');
const typingDiv = document.getElementById('typing');
const sessionsDiv = document.getElementById('sessions');
const authStatus = document.getElementById('auth-status');
const authForm = document.getElementById('auth-form');
const authLogoutBtn = document.getElementById('logout-btn');
const connectionStatus = document.getElementById('connection-status');

let ws = null;
let jwtToken = localStorage.getItem('chatbot_jwt') || '';
let authUsername = localStorage.getItem('chatbot_username') || '';
let userId = localStorage.getItem('chatbot_user_id');
if (!userId) {
  userId = 'anon_' + Math.random().toString(36).substring(2, 15) + Date.now();
  localStorage.setItem('chatbot_user_id', userId);
}
let currentSession = localStorage.getItem('chatbot_session') || 'default';
let isSearchMode = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let autoScroll = true;
let pendingMessages = [];
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const themeColors = {
  dark: '#1a1a2e',
  blue: '#16213e',
  purple: '#1a1a3e',
  green: '#0d1f0d',
  red: '#1f0d0d'
};
let currentTheme = localStorage.getItem('chatbot_theme') || 'dark';

setTheme(currentTheme);
initApp();

function getHeaders(useJson = true) {
  const headers = { 'X-User-Id': userId };
  if (jwtToken) {
    headers.Authorization = 'Bearer ' + jwtToken;
  }
  if (useJson) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function initApp() {
  updateAuthUI();
  saveSession();
  initWebSocket();
  loadSessions();
}

function updateAuthUI() {
  if (jwtToken) {
    authStatus.textContent = 'Signed in as ' + (authUsername || 'authenticated user');
    authLogoutBtn.style.display = 'inline-flex';
    authForm.style.display = 'none';
  } else {
    authStatus.textContent = 'Anonymous mode';
    authLogoutBtn.style.display = 'none';
    authForm.style.display = 'flex';
  }
}

function saveSession() {
  localStorage.setItem('chatbot_session', currentSession);
}

function setConnectionStatus(state) {
  if (!connectionStatus) return;
  connectionStatus.className = 'status ' + state;
  const label = connectionStatus.querySelector('.status-text');
  if (!label) return;

  const labels = {
    connected: 'Online',
    disconnected: 'Offline',
    connecting: 'Connecting...'
  };

  label.textContent = labels[state] || 'Connecting...';
}

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setConnectionStatus('disconnected');
    return;
  }

  reconnectAttempts += 1;
  setConnectionStatus('connecting');
  const delay = Math.min(1000 * reconnectAttempts, 10000);
  window.setTimeout(() => initWebSocket(), delay);
}

async function registerUser() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!username || !password) {
    addMessage('Please enter a username and password to register.', 'error');
    return;
  }
  setLoading(true);
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    jwtToken = data.token;
    authUsername = username;
    localStorage.setItem('chatbot_jwt', jwtToken);
    localStorage.setItem('chatbot_username', authUsername);
    updateAuthUI();
    addMessage('Registered successfully. Welcome, ' + username + '!', 'ai');
    reconnectWebSocket();
    loadSessions();
  } catch (e) {
    addMessage('Registration failed: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function loginUser() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!username || !password) {
    addMessage('Please enter a username and password to log in.', 'error');
    return;
  }
  setLoading(true);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    jwtToken = data.token;
    authUsername = username;
    localStorage.setItem('chatbot_jwt', jwtToken);
    localStorage.setItem('chatbot_username', authUsername);
    updateAuthUI();
    addMessage('Logged in successfully. Welcome back, ' + username + '!', 'ai');
    reconnectWebSocket();
    loadSessions();
  } catch (e) {
    addMessage('Login failed: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

function logoutUser() {
  jwtToken = '';
  authUsername = '';
  localStorage.removeItem('chatbot_jwt');
  localStorage.removeItem('chatbot_username');
  updateAuthUI();
  addMessage('You are now signed out. Anonymous mode is active.', 'ai');
  reconnectWebSocket();
  loadSessions();
}

function reconnectWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (e) {
      console.debug('WebSocket close error', e && e.message);
    }
    ws = null;
  }
  initWebSocket();
}

function initWebSocket() {
  setConnectionStatus('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenParam = jwtToken ? '&token=' + encodeURIComponent(jwtToken) : '';
  ws = new WebSocket(protocol + '//' + location.host + '?x-user-id=' + encodeURIComponent(userId) + tokenParam);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'chunk') {
      appendToLastMessage(data.content);
    } else if (data.type === 'done') {
      typingDiv.style.display = 'none';
      playSound();
      if (pendingMessages.length > 0) pendingMessages.shift();
    } else if (data.type === 'error') {
      typingDiv.style.display = 'none';
      addMessage('Error: ' + data.content, 'error');
    }
  };

  ws.onopen = () => {
    setConnectionStatus('connected');
    reconnectAttempts = 0;
    loadSessions();
    retryPendingMessages();
  };

  ws.onclose = () => {
    setConnectionStatus('disconnected');
    attemptReconnect();
  };

  ws.onerror = () => {
    setConnectionStatus('disconnected');
  };
}

function retryPendingMessages() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (pendingMessages.length === 0) return;
  ws.send(JSON.stringify({ msg: pendingMessages[0], sessionId: currentSession }));
}

function doSend() {
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  if (isSearchMode) {
    searchWeb(msg);
    return;
  }

  addMessage(msg, 'user');
  typingDiv.style.display = 'flex';
  pendingMessages.push(msg);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ msg, sessionId: currentSession }));
  } else {
    addMessage('Message queued: will send when connection is restored.', 'ai');
  }
}

const debouncedSend = debounce(doSend, 200);

function send() {
  debouncedSend();
}

function toggleSearch() {
  isSearchMode = !isSearchMode;
  const btn = document.getElementById('searchBtn');
  btn.style.background = isSearchMode ? '#ff6b00' : '';
  input.placeholder = isSearchMode ? 'Search the web...' : 'Type your message...';
}

async function searchWeb(query) {
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
    addMessage('🔍 ' + cached.result, 'ai');
    return;
  }

  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(query), { headers: getHeaders() });
    const data = await res.json();
    const result = data.result || 'No results found.';
    searchCache.set(query, { result, timestamp: Date.now() });
    addMessage('🔍 ' + result, 'ai');
  } catch (e) {
    addMessage('Search error: ' + e.message, 'error');
  }
}

async function loadSessions() {
  setLoading(true);
  try {
    const res = await fetch('/api/sessions', { headers: getHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unable to load sessions');

    renderSessions(data.sessions || [], data.active);
    if (data.active) {
      currentSession = data.active;
      saveSession();
      loadChats(currentSession);
    }
  } catch (e) {
    console.error('Load sessions error:', e);
  } finally {
    setLoading(false);
  }
}

function renderSessions(sessions = [], activeSession) {
  sessionsDiv.innerHTML = '';
  // Keep the session bar hidden to preserve the privacy-first UX.
  sessionsDiv.style.display = 'none';

  if (!sessions || sessions.length === 0) {
    return;
  }

  // Session controls remain intentionally hidden; session state is still
  // maintained in the background for the current user.
  void activeSession;
}

async function newSession() {
  if (chatDiv.children.length > 0 && !confirm('Start a new chat? This will change the session view.')) {
    return;
  }
  setLoading(true);
  try {
    const res = await fetch('/api/sessions/new', { method: 'POST', headers: getHeaders(), body: JSON.stringify({}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create session');
    currentSession = data.sessionId;
    saveSession();
    chatDiv.innerHTML = '';
    loadSessions();
    addMessage('New session created: ' + data.sessionId, 'ai');
  } catch (e) {
    addMessage('New session failed: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function switchSession(sessionId) {
  currentSession = sessionId;
  saveSession();
  await loadChats(sessionId);
  loadSessions();
}

async function loadChats(sid) {
  try {
    const res = await fetch('/api/chats?session=' + encodeURIComponent(sid), { headers: getHeaders() });
    const data = await res.json();
    chatDiv.innerHTML = '';
    for (const chat of data.chats || []) {
      addMessage(chat.user, 'user', chat.timestamp);
      addMessage(chat.ai, 'ai', chat.timestamp);
    }
  } catch (e) {
    console.error('Load chats error:', e);
  }
}

async function showHistory() {
  setLoading(true);
  try {
    const res = await fetch('/api/chats?session=' + encodeURIComponent(currentSession), { headers: getHeaders() });
    const data = await res.json();
    const count = data.chats?.length || 0;
    const summary = data.summary || 'None';
    alert('Session: ' + currentSession + '\nMessages: ' + count + '\nSummary: ' + summary);
  } catch (e) {
    alert('Error loading history');
  } finally {
    setLoading(false);
  }
}

async function exportChats() {
  setLoading(true);
  try {
    const res = await fetch('/api/chats/export', { headers: getHeaders() });
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat-export-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    addMessage('Export error: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function uploadFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  typingDiv.style.display = 'flex';
  typingDiv.textContent = 'Analyzing file...';
  try {
    const res = await fetch('/api/analyze', { method: 'POST', headers: { ...getHeaders(false) }, body: formData });
    const data = await res.json();
    typingDiv.style.display = 'none';
    if (data.analysis) {
      addMessage('📄 ' + file.name, 'user');
      addMessage(data.analysis, 'ai');
    } else {
      addMessage('Error: ' + (data.error || 'Upload failed'), 'error');
    }
  } catch (e) {
    typingDiv.style.display = 'none';
    addMessage('Upload error: ' + e.message, 'error');
  }
  event.target.value = '';
}

async function clearChat() {
  if (!confirm('Clear all messages in this session? This cannot be undone.')) return;
  try {
    await fetch('/api/chats/clear?session=' + encodeURIComponent(currentSession), { method: 'POST', headers: getHeaders() });
    chatDiv.innerHTML = '';
    addMessage('Chat cleared.', 'ai');
  } catch (e) {
    addMessage('Error clearing chat: ' + e.message, 'error');
  }
}

function copyMessage(text) {
  navigator.clipboard.writeText(text).then(() => {
    addMessage('Copied to clipboard!', 'ai');
  }).catch(() => {
    addMessage('Failed to copy', 'error');
  });
}

function setLoading(loading) {
  if (loading) {
    typingDiv.style.display = 'flex';
    typingDiv.textContent = 'Loading...';
  } else {
    typingDiv.style.display = 'none';
  }
}

function addMessage(msg, cls = 'ai', timestamp = null) {
  const div = document.createElement('div');
  div.className = 'message ' + cls;
  let timeStr = timestamp ? formatTime(timestamp) : '';
  if (cls === 'ai' && timeStr) {
    timeStr = '<span class="timestamp">' + timeStr + '</span>';
  }
  const raw = (timeStr || '') + formatMarkdown(msg);
  const safe = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : raw;
  div.innerHTML = safe;
  if (cls === 'ai') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy';
    copyBtn.onclick = () => copyMessage(msg);
    div.appendChild(copyBtn);
  }
  chatDiv.appendChild(div);
  if (autoScroll) chatDiv.scrollTop = chatDiv.scrollHeight;
}

function appendToLastMessage(text) {
  let last = chatDiv.lastElementChild;
  if (!last || !last.classList.contains('ai')) {
    last = document.createElement('div');
    last.className = 'message ai';
    chatDiv.appendChild(last);
  }
  const raw = formatMarkdown((last.textContent || '') + text);
  const safe = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : raw;
  last.innerHTML = safe;
  if (autoScroll) chatDiv.scrollTop = chatDiv.scrollHeight;
}

function formatMarkdown(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  html = html
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
  return html;
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('chatbot_theme', theme);
  document.body.style.background = themeColors[theme] || themeColors.dark;
}

function toggleDark() {
  const themes = Object.keys(themeColors);
  const idx = themes.indexOf(currentTheme);
  const nextTheme = themes[(idx + 1) % themes.length];
  setTheme(nextTheme);
}

function playSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    gainNode.gain.value = 0.1;
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.1);
  } catch (e) {
    console.debug('playSound error', e && e.message);
  }
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

window.send = send;
window.searchWeb = searchWeb;
window.switchSession = switchSession;
window.showHistory = showHistory;
window.exportChats = exportChats;
window.uploadFile = uploadFile;
window.toggleDark = toggleDark;
window.toggleEmojiPicker = toggleEmojiPicker;
window.insertEmoji = insertEmoji;
window.registerUser = registerUser;
window.loginUser = loginUser;
window.logoutUser = logoutUser;
window.newSession = newSession;

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    newSession();
  }
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    toggleSearch();
  }
  if (e.key === 'Escape' && isSearchMode) {
    toggleSearch();
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    clearChat();
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'm') {
    e.preventDefault();
    toggleVoice();
  }
});

document.body.style.background = themeColors[currentTheme] || themeColors.dark;

chatDiv.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = chatDiv;
  autoScroll = scrollTop + clientHeight >= scrollHeight - 50;
});

window.addEventListener('online', () => {
  setConnectionStatus('connected');
  initWebSocket();
});

window.addEventListener('offline', () => {
  setConnectionStatus('disconnected');
  addMessage('You are offline. Messages will be sent when reconnected.', 'ai');
});

let recognition = null;
let isListening = false;
function initVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addMessage('Voice input not supported in this browser.', 'error');
    return null;
  }
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = 'en-US';
  rec.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    if (transcript) input.value = transcript;
  };
  rec.onend = () => {
    isListening = false;
    document.getElementById('voice-status').style.display = 'none';
  };
  rec.onerror = (e) => {
    addMessage('Voice error: ' + e.error, 'error');
    isListening = false;
    document.getElementById('voice-status').style.display = 'none';
  };
  return rec;
}

function toggleVoice() {
  if (!recognition) {
    recognition = initVoice();
    if (!recognition) return;
  }
  if (isListening) {
    recognition.stop();
    isListening = false;
  } else {
    recognition.start();
    isListening = true;
    document.getElementById('voice-status').style.display = 'block';
    document.getElementById('voice-status').classList.add('listening');
  }
}

const emojis = ['😀','😂','😊','😍','🤔','😎','😭','😡','👍','👎','❤️','🎉','🔥','💯','✨','👏','🙌','💪','🤝','🙏','👋','🚗','🐕','🍕','🍔','🍟','🌮','🍺','☕','⚽','🏀','🎮','🎵','📱','💻','🔧','🚀','⭐','🌙','☀️','🌈','💧','❄️','🔥','💰','🏆','🎯','📚','💡','🔒','🌐'];

function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  const visible = picker.style.display !== 'none';
  if (visible) {
    picker.style.display = 'none';
    return;
  }
  picker.innerHTML = emojis.map((e) => `<span onclick="insertEmoji('${e}')">${e}</span>`).join('');
  picker.style.display = 'grid';
}

function insertEmoji(emoji) {
  input.value += emoji;
  input.focus();
  document.getElementById('emoji-picker').style.display = 'none';
}
