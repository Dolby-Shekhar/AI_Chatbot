const chatDiv = document.getElementById('chat');
const input = document.getElementById('input');
const typingDiv = document.getElementById('typing');
const sessionsDiv = document.getElementById('sessions');
const statusDiv = document.getElementById('connection-status');

let ws = null;
let currentSession = localStorage.getItem('chatbot_session') || 'default';
let isSearchMode = false;
let chatHistory = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let autoScroll = true;
let pendingMessages = []; // For retry on reconnection

// Search results cache (5 min TTL)
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

// Clear expired cache entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of searchCache) {
    if (now - value.timestamp > SEARCH_CACHE_TTL) {
      searchCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Keyboard navigation for messages
let currentMessageIndex = -1;
const messageElements = [];

// Format timestamp
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Initialize WebSocket
function initWebSocket() {
  ws = new WebSocket('ws://' + location.host);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'chunk') {
      appendToLastMessage(data.content);
    } else if (data.type === 'done') {
      typingDiv.style.display = 'none';
      playSound();
      // Clear from pending after success
      if (pendingMessages.length > 0) {
        pendingMessages.shift();
      }
    } else if (data.type === 'error') {
      typingDiv.style.display = 'none';
      addMessage('Error: ' + data.content, 'error');
    }
  };
  
  ws.onopen = () => {
    setConnectionStatus('connected');
    reconnectAttempts = 0;
    loadSessions();
    // Retry pending messages
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

// Retry pending messages after reconnection
function retryPendingMessages() {
  while (pendingMessages.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    const msg = pendingMessages[0];
    ws.send(JSON.stringify({ msg, sessionId: currentSession }));
    break; // Send one at a time
  }
}

// Connection status
function setConnectionStatus(status) {
  statusDiv.className = 'status ' + status;
  statusDiv.textContent = status === 'connected' ? '●' : (status === 'connecting' ? '◐' : '○');
}

// Reconnection
function attemptReconnect() {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    setConnectionStatus('connecting');
    setTimeout(initWebSocket, Math.min(1000 * Math.pow(2, reconnectAttempts), 30000));
  }
}

// Start connection
initWebSocket();

// Save session to localStorage
function saveSession() {
  localStorage.setItem('chatbot_session', currentSession);
}

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Debounced send (300ms)
const debouncedSend = debounce(() => {
  const msg = input.value.trim();
  if (!msg) return;
  
  input.value = '';
  addMessage(msg, 'user');
  typingDiv.style.display = 'flex';
  
  // Add to pending for retry on disconnect
  pendingMessages.push(msg);
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ msg, sessionId: currentSession }));
  } else {
    // Will retry on reconnection
    addMessage('Message saved. Will send when reconnected...', 'ai');
  }
}, 300);

// Send message with retry support
async function send() {
  debouncedSend();
}

// Toggle web search
function toggleSearch() {
  isSearchMode = !isSearchMode;
  const btn = document.getElementById('searchBtn');
  btn.style.background = isSearchMode ? '#ff6b00' : '';
  input.placeholder = isSearchMode ? 'Search the web...' : 'Type your message...';
}

// Search web with caching
async function searchWeb(query) {
  // Check cache first
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
    addMessage('🔍 ' + cached.result, 'ai');
    return;
  }
  
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(query));
    const data = await res.json();
    const result = data.result || 'No results found';
    
    // Cache result
    searchCache.set(query, { result, timestamp: Date.now() });
    
    addMessage('🔍 ' + result, 'ai');
  } catch (e) {
    addMessage('Search error: ' + e.message, 'error');
  }
}

// Load sessions
async function loadSessions() {
  setLoading(true);
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    
    sessionsDiv.innerHTML = '';
    for (const sid of data.sessions) {
      const tag = document.createElement('div');
      tag.className = 'session-tag' + (sid === data.active ? ' active' : '');
      tag.textContent = sid.slice(0, 12);
      tag.onclick = () => switchSession(sid);
      sessionsDiv.appendChild(tag);
    }
    
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

// New session with confirmation if has messages
async function newSession() {
  if (chatDiv.children.length > 0) {
    if (!confirm('Start a new chat? Current messages will be hidden.')) {
      return;
    }
  }
  
  setLoading(true);
  try {
    const res = await fetch('/api/sessions/new', { method: 'POST' });
    const data = await res.json();
    currentSession = data.sessionId;
    saveSession();
    chatDiv.innerHTML = '';
    loadSessions();
  } catch (e) {
    console.error('New session error:', e);
  } finally {
    setLoading(false);
  }
}

// Switch session
async function switchSession(sid) {
  currentSession = sid;
  saveSession();
  chatDiv.innerHTML = '';
  loadSessions();
}

// Load chats for session with timestamps
async function loadChats(sid) {
  try {
    const res = await fetch('/api/chats?session=' + sid);
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

// Show history modal
async function showHistory() {
  setLoading(true);
  try {
    const res = await fetch('/api/chats');
    const data = await res.json();
    const count = data.chats?.length || 0;
    const summary = data.summary || 'None';
    alert('Conversations: ' + count + '\nSummary: ' + summary);
  } catch (e) {
    alert('Error loading history');
  } finally {
    setLoading(false);
  }
}

// Export chats
async function exportChats() {
  setLoading(true);
  try {
    const res = await fetch('/api/chats/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat-export-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export error: ' + e.message);
  } finally {
    setLoading(false);
  }
}

// Upload file
async function uploadFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append('file', file);
  
  typingDiv.style.display = 'flex';
  typingDiv.textContent = 'Analyzing file...';
  
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
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

// Clear chat with confirmation
async function clearChat() {
  if (!confirm('Clear all messages in this session? This cannot be undone.')) {
    return;
  }
  
  try {
    await fetch('/api/chats/clear?session=' + currentSession, { method: 'POST' });
    chatDiv.innerHTML = '';
    addMessage('Chat cleared.', 'ai');
  } catch (e) {
    addMessage('Error clearing chat: ' + e.message, 'error');
  }
}

// Copy message to clipboard
function copyMessage(text) {
  navigator.clipboard.writeText(text).then(() => {
    addMessage('Copied to clipboard!', 'ai');
  }).catch(() => {
    addMessage('Failed to copy', 'error');
  });
}

// Loading indicator
function setLoading(loading) {
  if (loading) {
    typingDiv.style.display = 'flex';
    typingDiv.textContent = 'Loading...';
  } else {
    typingDiv.style.display = 'none';
  }
}

// Add message to chat with timestamp
function addMessage(msg, cls = 'ai', timestamp = null) {
  const div = document.createElement('div');
  div.className = 'message ' + cls;
  
  // Add timestamp for AI messages
  let timeStr = timestamp ? formatTime(timestamp) : '';
  if (cls === 'ai' && timeStr) {
    timeStr = '<span class="timestamp">' + timeStr + '</span>';
  }
  
  div.innerHTML = (timeStr || '') + formatMarkdown(msg);
  
  // Add copy button for AI messages
  if (cls === 'ai') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy';
    copyBtn.onclick = () => copyMessage(msg);
    div.appendChild(copyBtn);
  }
  
  chatDiv.appendChild(div);
  chatDiv.scrollTop = chatDiv.scrollHeight;
}

// Append to last AI message
function appendToLastMessage(text) {
  let last = chatDiv.lastElementChild;
  if (!last || !last.classList.contains('ai')) {
    last = document.createElement('div');
    last.className = 'message ai';
    chatDiv.appendChild(last);
  }
  last.innerHTML = formatMarkdown(last.textContent + text);
  chatDiv.scrollTop = chatDiv.scrollHeight;
}

// Unified markdown formatting with proper HTML escaping
function formatMarkdown(text) {
  if (!text) return '';
  
  // Escape HTML special characters first (XSS prevention)
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '<')
    .replace(/>/g, '>');
  
  // Then apply markdown formatting
  html = html
    // Headers
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    // Bold and Italic
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`(.*?)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Lists
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    // Line breaks (do last)
    .replace(/\n/g, '<br>');
  
  return html;
}

// Theme customization
const themeColors = {
  dark: '#1a1a2e',
  blue: '#16213e', 
  purple: '#1a1a3e',
  green: '#0d1f0d',
  red: '#1f0d0d'
};
let currentTheme = localStorage.getItem('chatbot_theme') || 'dark';

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('chatbot_theme', theme);
  document.body.style.background = themeColors[theme] || themeColors.dark;
}

// Toggle dark mode (cycles through themes)
function toggleDark() {
  const themes = Object.keys(themeColors);
  const idx = themes.indexOf(currentTheme);
  const nextTheme = themes[(idx + 1) % themes.length];
  setTheme(nextTheme);
}

// Apply saved theme on load
document.body.style.background = themeColors[currentTheme] || themeColors.dark;

// Sound notification - simplified
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
  } catch (e) {}
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl+N: New session
  if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    newSession();
  }
  // Ctrl+K: Toggle search
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    toggleSearch();
  }
  // Escape: Close search mode
  if (e.key === 'Escape' && isSearchMode) {
    toggleSearch();
  }
  // Ctrl+Shift+C: Clear chat
  if (e.ctrlKey && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    clearChat();
  }
});

// Auto-scroll functionality
chatDiv.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = chatDiv;
  autoScroll = scrollTop + clientHeight >= scrollHeight - 50;
});

// Online/Offline detection
window.addEventListener('online', () => {
  setConnectionStatus('connected');
  initWebSocket();
});

window.addEventListener('offline', () => {
  setConnectionStatus('disconnected');
  addMessage('You are offline. Messages will be sent when reconnected.', 'ai');
});

// ========== VOICE INPUT (Web Speech API) ==========
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
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    if (transcript) {
      input.value = transcript;
    }
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

// ========== EMOJI PICKER ==========
const emojis = ['😀', '😂', '😊', '😍', '🤔', '😎', '😭', '😡', '👍', '👎', '❤️', '🎉', '🔥', '💯', '✨', '👏', '🙌', '💪', '🤝', '🙏', '👋', '🚗', '🐕', '🍕', '🍔', '🍟', '🌮', '🍺', '☕', '⚽', '🏀', '🎮', '🎵', '📱', '💻', '🔧', '🚀', '⭐', '🌙', '☀️', '🌈', '💧', '❄️', '🔥', '💰', '🏆', '🎯', '📚', '💡', '🔒', '🌐'];

function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  const isVisible = picker.style.display !== 'none';
  
  if (isVisible) {
    picker.style.display = 'none';
  } else {
    picker.innerHTML = emojis.map(e => `<span onclick="insertEmoji('${e}')">${e}</span>`).join('');
    picker.style.display = 'grid';
  }
}

function insertEmoji(emoji) {
  input.value += emoji;
  input.focus();
  document.getElementById('emoji-picker').style.display = 'none';
}

// ========== KEYBOARD SHORTCUTS ==========
document.addEventListener('keydown', (e) => {
  // Ctrl+M: Voice
  if (e.ctrlKey && e.key === 'm') {
    e.preventDefault();
    toggleVoice();
  }
});
