'use strict';

const fs = require('fs');
const path = require('path');
const llmClient = require('../llm-client');
const logger = require('../logger');
const { verifyFileSyntax, extractCodeSections } = require('../syntax-checker');

const RULES = fs.readFileSync(path.join(__dirname, '../prompts/rules.prompt.txt'), 'utf-8');
const IDENTITY = fs.readFileSync(path.join(__dirname, '../prompts/identity.prompt.txt'), 'utf-8');
const ANALYZER_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/analyzer.prompt.txt'), 'utf-8');
const SYSTEM_PROMPT = `${RULES}\n\n${IDENTITY}\n\n${ANALYZER_PROMPT}`;

const name = 'analyzer';

// Corre el motor real de JS sobre cada archivo detectable dentro del
// código adjunto, y arma una nota de hechos confirmados (no opinión)
// para que el modelo la use como base, en vez de tener que adivinar
// si hay un error de sintaxis.
function buildSyntaxNote(code) {
  const sections = extractCodeSections(code);
  if (sections.length === 0) return '';

  const checks = sections.map(s => ({ ruta: s.ruta, ...verifyFileSyntax(s.ruta, s.contenido) }));
  const errores = checks.filter(c => c.ok === false);
  const noVerificables = checks.filter(c => c.ok === null && c.error);
  const validos = checks.filter(c => c.ok === true);

  const lineas = ['VERIFICACIÓN DE SINTAXIS (motor real de JS, no opinión del modelo):'];
  if (errores.length > 0) {
    lineas.push(...errores.map(e => `🔴 ${e.ruta}: error de sintaxis real — ${e.error}`));
  }
  if (validos.length > 0) {
    lineas.push(`✅ ${validos.length} archivo(s) sin errores de sintaxis: ${validos.map(v=>v.ruta).join(', ')}`);
  }
  if (noVerificables.length > 0) {
    lineas.push(...noVerificables.map(n => `⚪ ${n.ruta}: ${n.error}`));
  }
  return '\n\n' + lineas.join('\n');
}

async function run({ message, history = [], code = '', images = [] }) {
  logger.info(name, 'ejecutando', { historyLength: history.length, hasCode: Boolean(code), images: images.length });

  const syntaxNote = code ? buildSyntaxNote(code) : '';
  const fullMessage = code ? `${message}\n\n\`\`\`\n${code}\n\`\`\`${syntaxNote}` : message;
  const messages = [...history, { role: 'user', content: fullMessage }];

  try {
    const { text, model } = await llmClient.send({
      systemPrompt: SYSTEM_PROMPT,
      messages,
      agent: name,
      hasCode: Boolean(code),
      codeSize: code.length,
      images,
    });
    logger.info(name, 'completado', { model });
    return { agent: name, content: text };
  } catch (err) {
    logger.error(name, 'falló', { reason: err.message });
    throw err;
  }
}

module.exports = { name, run };
