# Tara-Finance-Research-Agent

## Frontend UI

A minimal frontend lives in `frontend/` and is served by the new `src/server.ts` API server.

### Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set the environment variables.
   - Example PowerShell commands:
     ```powershell
     $env:DATABASE_URL = 'postgres://postgres:yourPassword@localhost:5432/TARA'
     $env:GROQ_API_KEY = 'YOUR_GROQ_API_KEY'
     ```
   - Or copy `.env.example` to `.env` and update the values.
   - Replace `postgres`, `yourPassword`, `localhost`, `5432`, `TARA_db`, and the Groq key with your own values.
   - Optional: set `GROQ_MODEL=groq/allam-2-7b`, `GROQ_MODEL=groq/compound`, or `GROQ_MODEL=groq/compound-mini` if you want a specific Groq model. If you provide a shorthand like `allam-2-7b` or `compound`, it will normalize to `groq/<model>`.
   - If you see quota or billing errors, check your Groq plan and either top up your balance, use a different API key, or switch to a different model.
3. If port 3000 is already in use, set `PORT` to a different value:
   ```powershell
   $env:PORT = '3001'
   ```
4. Start the server:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in your browser.

### What it does

- `frontend/index.html` contains the UI.
- `frontend/app.js` posts prompts to `/api/chat`.
- `src/server.ts` forwards requests to `taraAgent` and returns grounded responses.
