'use strict';

const { query } = require('./client');
const logger = require('../logger');

// ── context.js ───────────────────────────────────────────────
// Contexto PERSISTENTE por proyecto (distinto al historial de chat
// de memory.js). Tabla "memory": project, key, value.
//
// A diferencia de la versión anterior de este archivo, los errores
// NUNCA se tragan en silencio — si Supabase falla, quien llama a
// esto se entera (con un error real), en vez de que ZyCode "olvide"
// contexto sin que nadie note por qué.

async function saveContext({ project, key, value }) {
  logger.info('supabase/context', 'saveContext', { project, key });

  await query({
    table: 'memory',
    method: 'POST',
    body: { project, key, value },
    query: 'on_conflict=project,key',
    extraHeaders: { Prefer: 'resolution=merge-duplicates' },
  });
}

async function getContext({ project }) {
  logger.info('supabase/context', 'getContext', { project });

  const rows = await query({
    table: 'memory',
    query: `project=eq.${project}&select=key,value`,
  });

  const context = {};
  (rows || []).forEach(row => { context[row.key] = row.value; });
  return context;
}

function formatContextForLLM(context) {
  if (!context || Object.keys(context).length === 0) return '';
  const lines = Object.entries(context).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `CONTEXTO DEL PROYECTO:\n${lines}`;
}

module.exports = { saveContext, getContext, formatContextForLLM };
