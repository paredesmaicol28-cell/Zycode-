'use strict';

const fs = require('fs');
const path = require('path');
const llmClient = require('../llm-client');
const logger = require('../logger');
const localWriter = require('../file-writer/local.client');
const { verifyFileSyntax } = require('../syntax-checker');

const RULES = fs.readFileSync(path.join(__dirname, '../prompts/rules.prompt.txt'), 'utf-8');
const IDENTITY = fs.readFileSync(path.join(__dirname, '../prompts/identity.prompt.txt'), 'utf-8');
const BUILDER_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/builder.prompt.txt'), 'utf-8');

const name = 'builder';

const OUTPUT_FORMAT = `
Responde SIEMPRE con un bloque \`\`\`json con un array de archivos:
[{ "ruta": "backend/agents/ejemplo.agent.js", "accion": "crear|modificar|eliminar", "contenido": "código completo del archivo", "riesgo": "bajo|requiere_confirmacion" }]
Cada "contenido" debe ser código completo y funcional, no un fragmento. "eliminar" o sobrescribir algo que ya existe SIEMPRE va con "riesgo": "requiere_confirmacion".
`.trim();

const EXECUTORS = {
  crear:     (p) => localWriter.writeFile(p),
  modificar: (p) => localWriter.writeFile(p),
  eliminar:  (p) => localWriter.deleteFile(p),
};

function parsePlan(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  const raw = match ? match[1] : text;
  try {
    const plan = JSON.parse(raw);
    return Array.isArray(plan) ? plan : null;
  } catch (err) {
    logger.warn(name, 'plan no parseable como JSON', { reason: err.message });
    return null;
  }
}

async function executeStep(step) {
  const executor = EXECUTORS[step.accion];
  if (!executor) {
    logger.warn(name, 'acción sin ejecutor conocido', { accion: step.accion });
    return { ...step, estado: 'pendiente_manual' };
  }

  // ⚠️ Candado antes de escribir: si el archivo es .js/.json y tiene
  // un error de sintaxis REAL (no opinión de IA), no se escribe al
  // disco. Mejor fallar acá que subir código roto a producción.
  if (step.contenido && (step.accion === 'crear' || step.accion === 'modificar')) {
    const check = verifyFileSyntax(step.ruta, step.contenido);
    if (check.ok === false) {
      logger.error(name, 'sintaxis inválida, NO se escribe el archivo', { ruta: step.ruta, reason: check.error });
      return { ...step, estado: 'fallido', error: `Sintaxis inválida (motor real de JS): ${check.error}` };
    }
    if (check.ok === null && check.error) {
      logger.warn(name, 'archivo no verificable automático', { ruta: step.ruta, reason: check.error });
    }
  }

  try {
    const resultado = await executor({ ruta: step.ruta, contenido: step.contenido });
    logger.info(name, 'archivo procesado', { accion: step.accion, ruta: step.ruta });
    return { ...step, estado: 'ejecutado', resultado };
  } catch (err) {
    logger.error(name, 'falló al escribir archivo', { ruta: step.ruta, reason: err.message });
    return { ...step, estado: 'fallido', error: err.message };
  }
}

async function run({ message, history = [], context = '', autoExecute = false, images = [] }) {
  logger.info(name, 'ejecutando', { historyLength: history.length, autoExecute, images: images.length });

  const fullMessage = context ? `${message}\n\nContexto del proyecto:\n${context}` : message;
  const messages = [...history, { role: 'user', content: fullMessage }];

  let text, model;
  try {
    ({ text, model } = await llmClient.send({
      systemPrompt: `${RULES}\n\n${IDENTITY}\n\n${BUILDER_PROMPT}\n\n${OUTPUT_FORMAT}`,
      messages,
      agent: name,
      hasCode: Boolean(context),
      codeSize: context.length,
      images,
    }));
    logger.info(name, 'plan generado', { model });
  } catch (err) {
    logger.error(name, 'falló al generar plan', { reason: err.message });
    throw err;
  }

  const plan = parsePlan(text);
  if (!plan || !autoExecute) return { agent: name, content: text, plan, executed: false };

  const results = [];
  for (const step of plan) {
    if (step.riesgo === 'requiere_confirmacion') {
      results.push({ ...step, estado: 'pendiente_confirmacion' });
      continue;
    }
    results.push(await executeStep(step));
  }
  return { agent: name, content: text, plan: results, executed: true };
}

module.exports = { name, run };
