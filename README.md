# Interview Me Web App

A small local web app with Google sign-in and a single post-login `Interview Me` icon.

## Configure

1. Paste your Google OAuth client ID into `.env`.
2. Paste your Tavus Persona ID into `config.js`.
3. Copy `.env.example` to `.env`.
4. Paste your Tavus API key into `.env`.

The Google client ID is served from the local backend. The Tavus API key stays server-only. Do not put secrets in `config.js`.

## Run locally

```bash
cd interview-me-app
/Users/yuribogdanov/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

Open `http://localhost:5173`.

Until the Google client ID is configured, the app shows a preview button so you can verify the signed-in screen locally. Once the Google and Tavus values are configured, sign in with Google; users are persisted to `data/interview-me.sqlite`.
