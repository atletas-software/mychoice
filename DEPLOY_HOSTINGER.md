# Hostinger Deployment Checklist

## Hostinger requirements

- Node.js app hosting enabled.
- Node.js version 22 or newer.
- Public HTTPS domain or Hostinger temporary domain.
- SSH access enabled for the hosting account.

## Hostinger app settings

- App name: `my-choice`
- Startup file: `server.js`
- Start command: `npm start`
- Environment variables:
  - `TAVUS_API_KEY`
  - `GOOGLE_CLIENT_ID`
  - `PUBLIC_CALLBACK_BASE_URL=https://YOUR-HOSTINGER-DOMAIN`
  - `HOST=0.0.0.0`
  - `PORT` only if Hostinger asks you to set it manually

## GitHub Actions secrets

Add these in GitHub repo settings under `Settings -> Secrets and variables -> Actions`.

- `HOSTINGER_SSH_HOST`
- `HOSTINGER_SSH_PORT` (`22` if Hostinger does not show a different port)
- `HOSTINGER_SSH_USER`
- `HOSTINGER_SSH_KEY`
- `HOSTINGER_DEPLOY_PATH`
- `HOSTINGER_RESTART_COMMAND` optional

## Google OAuth

Add this authorized JavaScript origin:

```text
https://YOUR-HOSTINGER-DOMAIN
```

## Tavus callbacks

The app sends these URLs to Tavus when creating a conversation:

```text
https://YOUR-HOSTINGER-DOMAIN/api/tavus/callback
https://YOUR-HOSTINGER-DOMAIN/api/tavus/utterance
```

Those callbacks write raw transcript turns and structured interview outputs to SQLite.
