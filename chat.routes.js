'use strict';

const express = require('express');
const crypto = require('crypto');
const orchestrator = require('../orchestrator');
const memory = require('../supabase/memory');
const logger = require('../logger');
const { extractZip } = require('../uploads/zip.util');

// ── chat.routes.js ──────────────────────────────────────────
// Endpoints HTTP del chat. Conecta: request -> memoria (historial)
// -> orchestrator (decide agente) -> memoria (guarda respuesta).
// No tiene lógica de negocio propia — solo cablea las piezas.

const router = express.Router();

// Límite de tamaño de código que se manda al LLM. Un zip grande
// puede tener megas de código — sin este límite, el mensaje se
// vuelve gigante y caro (o directo supera el límite del modelo).
const MAX_CODE_CHARS = 60000;

function newSessionId() {
  return `sid_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// Convierte los archivos que mandó el frontend (texto plano o zip
// en base64) en un solo string de código para los agentes.
function buildCodeFromFiles(files = []) {
  let code = '';

  for (const f of files) {
    if (f.isZip && f.base64) {
      try {
        const extracted = extractZip(f.base64);
        for (const ef of extracted) {
          code += `\n\n--- ${f.name}/${ef.path} ---\n${ef.content}`;
        }
      } catch (err) {
        logger.warn('routes/chat', 'no se pudo procesar el zip', { name: f.name, reason: err.message });
        code += `\n\n[⚠️ no se pudo leer ${f.name}: ${err.message}]`;
      }
    } else if (f.content) {
      code += `\n\n--- ${f.name} ---\n${f.content}`;
    }
    // archivos sin content y sin isZip (binarios no soportados) se ignoran a propósito
  }

  if (code.length > MAX_CODE_CHARS) {
    logger.warn('routes/chat', 'código truncado por tamaño', { originalLength: code.length });
    code = code.slice(0, MAX_CODE_CHARS) + '\n\n[⚠️ contenido truncado, era demasiado grande]';
  }

  return code;
}

// POST /api/chat — manda un mensaje, recibe la respuesta del agente
router.post('/chat', async (req, res) => {
  const { message, sessionId, autoExecute = false, code = '', files = [], images = [] } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'falta "message"' });
  }

  const sid = sessionId || newSessionId();
  const filesCode = buildCodeFromFiles(files);
  const fullCode = [code, filesCode].filter(Boolean).join('\n\n');

  try {
    await memory.getOrCreateSession({ id: sid, title: message.slice(0, 40) });

    const previousMessages = await memory.getHistory({ sessionId: sid });
    const history = previousMessages.map(m => ({ role: m.role, content: m.content }));

    await memory.saveMessage({ sessionId: sid, role: 'user', content: message });

    const result = await orchestrator.route({ message, history, code: fullCode, autoExecute, images });

    await memory.saveMessage({
      sessionId: sid,
      role: 'assistant',
      content: result.content,
      agent: result.agent,
    });

    res.json({
      success: true,
      sessionId: sid,
      agent: result.agent,
      content: result.content,
      plan: result.plan || null,
      executed: result.executed || false,
    });

  } catch (err) {
    logger.error('routes/chat', 'fallo en POST /chat', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/sessions — historial de conversaciones (para el drawer del frontend)
router.get('/chat/sessions', async (req, res) => {
  try {
    const sessions = await memory.listSessions();
    res.json({ success: true, sessions });
  } catch (err) {
    logger.error('routes/chat', 'fallo en GET /chat/sessions', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chat/history/:id — mensajes de una sesión específica
router.get('/chat/history/:id', async (req, res) => {
  try {
    const history = await memory.getHistory({ sessionId: req.params.id });
    res.json({ success: true, history });
  } catch (err) {
    logger.error('routes/chat', 'fallo en GET /chat/history', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
