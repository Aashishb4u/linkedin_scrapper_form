// Minimal Node HTTP server to integrate with Google Drive/Sheets APIs
// - Reads credentials from .env (fallback to environment)
// - Refreshes access token automatically and caches it
// - Exposes endpoints:
//    GET  /api/spreadsheets                  -> { files: [{id,name}] }
//    GET  /api/spreadsheets/:id/tabs         -> { tabs: [{id,title}] }
//    POST /api/submit                        -> echoes received payload
// No external dependencies required (Node 18+ for global fetch)

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { URL } from 'node:url';

// ------- Simple .env loader (avoid dependency on dotenv) -------
function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    });
  } catch (e) {
    console.warn('Failed to load .env:', e);
  }
}
loadDotEnv();

// ------- Config -------
const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const LOGIN_PASS = process.env.LOGIN_PASS;
const LOGIN_USER = process.env.LOGIN_USER;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.warn('Warning: Missing one or more Google credentials in environment (.env).');
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_ENDPOINT =
  "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet'&fields=files(id,name)";
const SHEETS_META_ENDPOINT = (spreadsheetId) =>
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`;

// ------- Token cache / refresh -------
let tokenCache = { accessToken: null, expiresAt: 0 };
// Example Node.js function to refresh Google access token

async function refreshAccessToken() {
  // Replace these with your actual credentials
 
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google credentials are not configured.');
  }

  // Return cached token if not expired
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'google-oauth-playground', // optional, can include if needed
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${txt}`);
  }

  const json = await res.json();
  const accessToken = json.access_token;
  const expiresIn = Number(json.expires_in || 3600);

  if (!accessToken) throw new Error('No access_token in token response');

  tokenCache = {
    accessToken,
    // Refresh 60 seconds before expiry as buffer
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  };

  console.log('New access token fetched:', accessToken);
  return accessToken;
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return await refreshAccessToken();
}

async function fetchGoogle(url, opts = {}, retry = true) {
  const token = await getAccessToken();
  const headers = new Headers(opts.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && retry) {
    // Token expired unexpectedly; refresh and retry once
    await refreshAccessToken();
    return fetchGoogle(url, opts, false);
  }
  return res;
}

// ------- Utilities -------
function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function sendText(res, status, text) {
  const data = Buffer.from(String(text || ''));
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        if (chunks.length === 0) return resolve({});
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function handleCors(req, res) {
  // Basic CORS support, including preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ------- Server -------
const server = createServer(async (req, res) => {
  try {
    if (handleCors(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

     // ====== LOGIN API ======
     if (req.method === 'POST' && pathname === '/api/login') {
      try {
        const body = await readJsonBody(req);
        const { username, password } = body;

        if (!username || !password) {
          return sendJson(res, 400, { ok: false, error: 'Username and password required' });
        }

        if (username === LOGIN_USER && password === LOGIN_PASS) {
          // Optionally generate a token here
          return sendJson(res, 200, { ok: true, message: 'Login successful' });
        } else {
          return sendJson(res, 401, { ok: false, error: 'Invalid credentials' });
        }
      } catch (err) {
        console.error('Login error:', err);
        return sendJson(res, 500, { ok: false, error: 'Login failed', details: String(err) });
      }
    }

    if (req.method === 'GET' && pathname === '/api/spreadsheets') {
      const gRes = await fetchGoogle(DRIVE_FILES_ENDPOINT);
      if (!gRes.ok) {
        const txt = await gRes.text();
        return sendJson(res, gRes.status, { error: 'Google Drive list failed', details: txt });
      }
      const json = await gRes.json();
      return sendJson(res, 200, { files: json.files || [] });
    }

    const tabsMatch = pathname.match(/^\/api\/spreadsheets\/([^/]+)\/tabs$/);
    if (req.method === 'GET' && tabsMatch) {
      const spreadsheetId = decodeURIComponent(tabsMatch[1]);
      const gRes = await fetchGoogle(SHEETS_META_ENDPOINT(spreadsheetId));
      if (!gRes.ok) {
        const txt = await gRes.text();
        return sendJson(res, gRes.status, { error: 'Google Sheets meta failed', details: txt });
      }
      const json = await gRes.json();
      const tabs = (json.sheets || []).map((s) => ({
        id: String(s.properties?.sheetId ?? ''),
        title: String(s.properties?.title ?? ''),
      }));
      return sendJson(res, 200, { tabs });
    }

    if (req.method === 'POST' && pathname === '/api/submit') {
      try {
        const body = await readJsonBody(req);
    
        // TODO: Here you can handle your submission (save to DB, queue, send email, etc.)
        console.log('Received submission:', body);
    
        // Respond with a success message + any info the client may need
        return sendJson(res, 200, {
          ok: true,
          message: 'Form submitted successfully!',
          received: body, // echo back for debugging
        });
      } catch (err) {
        console.error('Submit error:', err);
        return sendJson(res, 500, {
          ok: false,
          message: 'Failed to process submission.',
          error: String(err),
        });
      }
    }

    if (req.method === 'POST' && pathname === '/api/spreadsheets/create') {
      try {
        // Read optional body for spreadsheet title
        const body = await readJsonBody(req);
        const sheetName = body.sheetName?.trim() || 'New Spreadsheet';
        const tabName = body.tabName?.trim() || 'New Tab';
    
        // Build spreadsheet payload
        const spreadsheetData = {
          properties: { 
            title: sheetName // Name of your spreadsheet
           },
          sheets: [
            { properties: { title: tabName } } // initial sheet
          ]
        };
    
        // Get access token
        const accessToken = await getAccessToken();
    
        // Create spreadsheet
        const gRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify(spreadsheetData)
        });
    
        const data = await gRes.json();
    
        console.log(JSON.stringify(data, null, 2));
        
        if (!gRes.ok) {
          return sendJson(res, gRes.status, { error: 'Failed to create spreadsheet', details: data });
        }
    
        // Return spreadsheet info
        return sendJson(res, 200, {
          ok: true,
          spreadsheetId: data.spreadsheetId,
          spreadsheetUrl: data.spreadsheetUrl,
          title: data.properties?.title,
          tabId: data.sheets[0]?.properties?.sheetId ?? ''
        });
    
      } catch (err) {
        console.error('Create spreadsheet error:', err);
        return sendJson(res, 500, { error: 'Internal error', details: String(err) });
      }
    }
    
    
    if (req.method === 'GET' && pathname === '/') {
      return sendText(res, 200, 'Server is running. Endpoints: /api/spreadsheets, /api/spreadsheets/:id/tabs, POST /api/submit');
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: 'Internal error', details: String(err?.message || err) });
  }
});



server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

