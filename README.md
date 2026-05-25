# AI Chatbot Pro 🧠

A self-hosted AI chatbot with session support, optional authentication, file upload, and fallback persistence.

## Features

- Multiple chat sessions
- AI streaming responses with markdown rendering
- Optional Groq API integration for richer replies
- Anonymous or JWT-based user sessions
- File upload and analysis support
- Search mode with cached results
- Offline detection and reconnect logic
- Dark mode, emoji picker, and voice input
- Fallback persistence via `data/db.json` when SQLite is unavailable

## Prerequisites

- Node.js 18+ installed
- Git (optional)

## Local Setup

```bash
cd ai-chatbot-node
npm install
cp .env.example .env
```

On Windows PowerShell:

```powershell
cd ai-chatbot-node
npm install
Copy-Item .env.example .env
```

Then edit `.env` as needed.

## Environment Variables

Use `.env` or your hosting environment to configure runtime values.

- `GROQ_API_KEY` — Optional Groq API key for AI responses.
- `JWT_SECRET` — Secret used to sign authentication tokens.
- `PORT` — Server port (default `3000`).
- `ALLOWED_ORIGINS` — Comma-separated list of allowed CORS origins. Defaults to `*` when unset.
- `DATA_DIR` — Optional storage folder. Defaults to `data`.

Example:

```env
GROQ_API_KEY=your_groq_api_key_here
JWT_SECRET=super_secret_jwt_key
PORT=3000
ALLOWED_ORIGINS=http://localhost:3000
DATA_DIR=data
```

## Run Locally

Start the server:

```bash
npm start
```

For hot reload during development:

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

## Authentication

The app supports optional JWT-based authentication.

- `POST /api/auth/register` — register a username and password.
- `POST /api/auth/login` — login and receive a JWT.

Add the token to requests as:

```http
Authorization: Bearer <token>
```

For anonymous users, the client sends `X-User-Id` automatically.

## Data Storage

The server uses `dbClient.js` to persist chat data in `data/app.db` when `better-sqlite3` is installed.

If SQLite is not available, it falls back to JSON storage in `data/db.json`.

- `data/app.db` — SQLite database (preferred)
- `data/db.json` — JSON fallback file

> `start.sh` resets the JSON database and should only be used when you want a fresh workspace.

## Deployment

### Docker

Build the image:

```bash
docker build -t ai-chatbot .
```

Run the container:

```bash
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e JWT_SECRET=super_secret_jwt_key \
  -e GROQ_API_KEY=your_groq_api_key_here \
  -v "$PWD/data:/app/data" \
  ai-chatbot
```

### Render

This repo includes `render.yaml` for Render deployment. The default service runs on Node 20 and exposes port 3000.

If you deploy manually:

- Build command: `npm install`
- Start command: `node server.js`
- Environment variables: `GROQ_API_KEY`, `JWT_SECRET`, `PORT`

### CI

The GitHub Actions workflow runs on Node 18 and 20, installs dependencies with `npm ci`, and executes `npm run lint`.

## Useful Scripts

- `npm install` — install dependencies
- `npm start` — start server normally
- `npm run dev` — development server with `nodemon`
- `npm run lint` — run ESLint
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — format files with Prettier
- `npm test` — run automated API tests

## Notes

- The `data/` folder is git-ignored, so local persistence does not get committed.
- If `better-sqlite3` fails to install, the app still works with JSON persistence.
- Keep `JWT_SECRET` private in production.
- Use `ALLOWED_ORIGINS` to restrict browser requests in deployed environments.
