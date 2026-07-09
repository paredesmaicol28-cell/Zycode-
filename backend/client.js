'use strict';

const logger = require('../logger');

// ── client.js ────────────────────────────────────────────────
// Única conexión a Supabase. Usa la REST API directo (PostgREST)
// con fetch nativo — sin instalar el SDK de @supabase/supabase-js,
// para no agregar una dependencia externa por una sola conexión.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function assertConfig() {
  if (!SUPABASE_URL || !SECRET_KEY) {
    throw new Error('supabase/client: falta SUPABASE_URL o SUPABASE_SECRET_KEY en el entorno');
  }
}

function headers() {
  return {
    'apikey': SECRET_KEY,
    'Authorization': `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Query genérica contra una tabla vía PostgREST.
// method: GET | POST | PATCH | DELETE
// query: string tipo "session_id=eq.abc&order=created_at.asc"
async function query({ table, method = 'GET', body = null, query: qs = '', extraHeaders = {} }) {
  assertConfig();
  const url = `${SUPABASE_URL}/rest/v1/${table}${qs ? `?${qs}` : ''}`;

  const res = await fetch(url, {
    method,
    headers: { ...headers(), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('supabase/client', 'query falló', { table, method, status: res.status });
    throw new Error(`supabase/client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  if (res.status === 204) return null; // no content (típico en DELETE)
  return res.json();
}

module.exports = { query };
