'use strict';

const logger = require('./logger');

// ── llm-client.js ───────────────────────────────────────────
// Único archivo que habla con la API del proveedor de IA.
// Depende solo de logger.js. La dirección de dependencia va
// siempre hacia acá, nunca al revés.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;

const MODELS = {
  rapido:  'claude-haiku-4-5-20251001',
  medio:   'claude-sonnet-5',
  potente: 'claude-opus-4-8',
};

// ── Selección de modelo según complejidad real ──────────────
// simple   -> haiku   (pregunta corta, directa, sin código)
// media    -> sonnet  (pregunta con algo de profundidad, o con código chico)
// profunda -> opus    (arreglar proyecto grande, arquitectura completa,
//                      codebase grande, o el propio caller ya sabe que
//                      es tarea pesada y lo marca explícito)
function classifyComplexity({ agent, messageLength = 0, hasCode = false, codeSize = 0, forceDeep = false, hasImages = false }) {
  if (forceDeep) return 'profunda';

  // Proyecto grande: mucho código adjunto -> siempre profunda,
  // sin importar qué tan corto sea el mensaje.
  if (codeSize > 4000) return 'profunda';

  // architect con código de por medio ya implica ver el sistema completo.
  if (agent === 'architect' && hasCode) return 'profunda';

  // Razonar sobre una imagen (screenshot de error, diagrama) necesita
  // más que el modelo rápido — nunca baja a "simple" si hay imágenes.
  const isSimple = !hasCode && !hasImages && messageLength < 80;
  if (isSimple) return 'simple';

  return 'media';
}

function pickModel(ctx = {}) {
  const complexity = classifyComplexity(ctx);
  if (complexity === 'simple')   return MODELS.rapido;
  if (complexity === 'profunda') return MODELS.potente;
  return MODELS.medio;
}

// ── Llamada al modelo con reintentos ────────────────────────
const MAX_RETRIES = 2;
const TIMEOUT_MS = 20000;

async function callWithRetry(body, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`API respondió ${res.status}: ${errText.slice(0, 200)}`);
    }

    return await res.json();

  } catch (err) {
    clearTimeout(timeout);
    const isLastAttempt = attempt >= MAX_RETRIES;

    logger.warn('llm-client', `intento ${attempt} falló`, {
      reason: err.name === 'AbortError' ? 'timeout' : err.message,
    });

    if (isLastAttempt) {
      logger.error('llm-client', 'se agotaron los reintentos', { attempts: attempt });
      throw new Error(`llm-client: falló tras ${attempt} intentos — ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500 * attempt));
    return callWithRetry(body, attempt + 1);
  }
}

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB por imagen, límite de la API

// Convierte el último mensaje de texto plano a un bloque multimodal
// (imagen + texto) en el formato que espera la API de Anthropic.
// Si no hay imágenes, no toca nada — mismo comportamiento de siempre.
function buildMessagesWithImages(messages, images) {
  if (!images || images.length === 0) return messages;

  const validImages = images
    .filter(img => {
      const sizeBytes = (img.base64?.length || 0) * 0.75; // aproximado, base64 -> bytes
      if (sizeBytes > MAX_IMAGE_BYTES) {
        logger.warn('llm-client', 'imagen ignorada por tamaño', { name: img.name, sizeBytes });
        return false;
      }
      return true;
    })
    .slice(0, MAX_IMAGES);

  if (validImages.length === 0) return messages;

  const lastMessage = messages[messages.length - 1];
  const imageBlocks = validImages.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
  }));

  // Orden recomendado por Anthropic: imágenes primero, texto después.
  const content = [...imageBlocks, { type: 'text', text: lastMessage.content }];

  return [...messages.slice(0, -1), { role: lastMessage.role, content }];
}

// ── API pública ──────────────────────────────────────────────
// send({ systemPrompt, messages, agent, hasCode, codeSize, forceDeep, images })
async function send({ systemPrompt, messages, agent, hasCode = false, codeSize = 0, forceDeep = false, images = [] }) {
  if (!API_KEY) {
    logger.error('llm-client', 'falta ANTHROPIC_API_KEY en el entorno');
    throw new Error('llm-client: falta configurar ANTHROPIC_API_KEY');
  }

  const lastMessage = messages[messages.length - 1]?.content || '';
  const model = pickModel({
    agent,
    messageLength: lastMessage.length,
    hasCode,
    codeSize,
    forceDeep,
    hasImages: images.length > 0,
  });

  logger.info('llm-client', 'enviando request', { agent, model, images: images.length });

  const finalMessages = buildMessagesWithImages(messages, images);

  const data = await callWithRetry({
    model,
    max_tokens: 2000,
    system: systemPrompt,
    messages: finalMessages,
  });

  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) {
    logger.error('llm-client', 'respuesta sin bloque de texto', { agent });
    throw new Error('llm-client: respuesta inesperada del modelo');
  }

  return { text: textBlock.text, model };
}

module.exports = { send, pickModel, classifyComplexity };
