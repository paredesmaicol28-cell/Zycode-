'use strict';

const { query } = require('./client');
const logger = require('../logger');

// ── memory.js ────────────────────────────────────────────────
// Lee y escribe datos en tablas que YA existen (sessions, messages).
// Nunca crea ni modifica estructura de tablas — eso vive en
// supabase/migrations/*.sql, corrido manual, no desde acá.

async function createSession({ id, title }) {
  logger.info('supabase/memory', 'createSession', { id });
  const rows = await query({
    table: 'sessions',
    method: 'POST',
    body: { id, title },
    extraHeaders: { Prefer: 'return=representation' },
  });
  return rows[0];
}

// Crea la sesión si no existe; si ya existe (clave duplicada), la
// reutiliza en vez de tronar. Esto es lo que usa routes/chat.routes.js
// en cada mensaje, porque el frontend manda el mismo sessionId varias
// veces seguidas dentro de la misma conversación.
async function getOrCreateSession({ id, title }) {
  try {
    return await createSession({ id, title });
  } catch (err) {
    if (err.message.includes('409') || err.message.includes('23505') || err.message.includes('duplicate')) {
      logger.info('supabase/memory', 'sesión ya existía, se reutiliza', { id });
      const rows = await query({ table: 'sessions', query: `id=eq.${id}` });
      return rows[0];
    }
    throw err;
  }
}

async function listSessions({ limit = 50 } = {}) {
  return query({
    table: 'sessions',
    query: `order=updated_at.desc&limit=${limit}`,
  });
}

async function getHistory({ sessionId }) {
  return query({
    table: 'messages',
    query: `session_id=eq.${sessionId}&order=created_at.asc`,
  });
}

async function saveMessage({ sessionId, role, content, agent = null }) {
  logger.info('supabase/memory', 'saveMessage', { sessionId, role, agent });

  const rows = await query({
    table: 'messages',
    method: 'POST',
    body: { session_id: sessionId, role, content, agent },
    extraHeaders: { Prefer: 'return=representation' },
  });

  // Actualiza el timestamp de la sesión para que "Recientes" en el
  // frontend ordene bien. Si esto falla, no tumba el guardado del
  // mensaje (que ya se guardó) — se loguea y sigue.
  try {
    await query({
      table: 'sessions',
      method: 'PATCH',
      query: `id=eq.${sessionId}`,
      body: { updated_at: new Date().toISOString() },
    });
  } catch (err) {
    logger.warn('supabase/memory', 'no se pudo actualizar updated_at de la sesión', { sessionId, reason: err.message });
  }

  return rows[0];
}

module.exports = { createSession, getOrCreateSession, listSessions, getHistory, saveMessage };
