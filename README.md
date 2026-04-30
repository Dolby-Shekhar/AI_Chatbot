# AI Chatbot Pro 🧠

Fully interactive self-learning AI chatbot with internet access, multiple sessions, file upload, and web search.

## Features

- **Session Support** - Multiple chat threads (click + to create new)
- **File Upload** - Analyze text files (.txt, .md, .json)
- **Web Search** - Real-time info via DuckDuckGo API (click 🔍)
- **Streaming** - Real-time AI responses
- **Typing Indicators** - Animated while AI thinks
- **Markdown** - Bold, code blocks
- **Export** - Download conversations
- **Dark Mode** - Toggle with 🌙
- **Voice Input** - Click 🎤 or press Ctrl+M
- **Emoji Picker** - Click 😀 to open

## Quick Start

```bash
cd ai-chatbot-node
npm install
npm start
```

Then open http://localhost:3000

## API Key (Optional)

For full AI responses, get a free Groq key:

1. Visit https://console.groq.com/keys
2. Create account (free)
3. Copy API key
4. Set: `set GROQ_API_KEY=your_key_here` (Windows)
   Or: `export GROQ_API_KEY=your_key_here` (Mac/Linux)

Without key: Uses fallback joke API.

## Keyboard Shortcuts

- **Ctrl+N** - New session
- **Ctrl+K** - Toggle search
- **Ctrl+M** - Voice input
- **Ctrl+Shift+C** - Clear chat

## Project Structure

```
ai-chatbot-node/
├── server.js          # Express server with WebSocket
├── chatbot.js       # AI logic with Groq API
├── public/
│   ├── index.html  # UI frontend
│   └── chat.js   # Frontend JavaScript
└── package.json
```

## Improvements Applied ✅

- Global error handling
- Message debouncing (300ms)
- Search cache cleanup
- Configuration constants
- Connection retry logic
- Offline detection
