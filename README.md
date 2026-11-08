# Pulse OS

Expo / React Native productivity app (Android) with an optional cloud backend that runs in GitHub Codespaces.

```
App.tsx                         the app (CHAT / WIDGETS / WORKSPACE)
server/server.js                Express backend: /health, /api/chat, /api/task, /api/tasks
.devcontainer/devcontainer.json Codespaces config: installs deps, starts the server on port 3000
.devcontainer/start-backend.sh  starts the server, makes port 3000 public, prints the URL
.github/workflows/build-apk.yml builds the debug APK on every push
```

## Backend API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness, model, whether a Gemini key and token are configured. No auth. |
| GET | `/api/info` | Available task types. |
| POST | `/api/chat` | `{ messages: [{ role: "user"\|"assistant", text }] }` -> `{ reply: { direct_response, proactive_checklist, one_line_summary }, model }` |
| POST | `/api/task` | `{ type, payload }` -> `{ run }`. Types: `echo`, `budget`, `plan`, `summarize`. |
| GET | `/api/tasks` | Last 20 runs (in memory; cleared on restart). |

If the `PULSE_TOKEN` secret is set, every `/api/*` call needs `Authorization: Bearer <token>`.
Tasks are a fixed allow-list; the server never runs shell commands or code sent by the app.

## Run it in Codespaces

1. Repo page -> Settings -> Secrets and variables -> Codespaces -> New repository secret:
   - `GEMINI_API_KEY` = your key from aistudio.google.com/apikey
   - `PULSE_TOKEN` = any long random string
2. Repo page -> green **Code** button -> **Codespaces** tab -> **Create codespace on main**.
3. Wait for the terminal to print `Pulse OS backend is running` and the URL
   (`https://<codespace-name>-3000.app.github.dev`).
4. **Ports** tab -> port 3000 should say **Public**. If it says Private: right-click -> Port Visibility -> Public.
5. Open `<URL>/health` in your phone's browser: you should see `"ok": true`.
6. In the app: CHAT -> **Settings** -> Cloud backend -> paste the URL, enter the same `PULSE_TOKEN`,
   turn on **Chat via cloud** -> **Test connection** -> **Save**.

Codespaces stop after about 30 minutes idle (and the URL stays the same when you restart the same codespace).
The app falls back to on-device Gemini when the cloud is unreachable and a key is saved on the phone.

## Run it anywhere else

```
cd server && npm install && GEMINI_API_KEY=... PULSE_TOKEN=... npm start
```
