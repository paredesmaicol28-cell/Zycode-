'use strict';

const logger = require('./logger');
const analyzer   = require('./agents/analyzer.agent');
const architect   = require('./agents/architect.agent');
const builder       = require('./agents/builder.agent');
const deploy           = require('./agents/deploy.agent');
const nextStep           = require('./agents/next-step.agent');

// ── orchestrator.js ─────────────────────────────────────────
// SOLO decide qué agente responde. No genera contenido, no habla
// con el LLM directo, no ejecuta nada él mismo. Es un router.

const AGENTS = {
  analyzer,
  architect,
  builder,
  deploy,
  'next-step': nextStep,
};

// ── Reglas de ruteo (heurística simple, sin gastar una llamada
// al LLM solo para decidir quién responde) ──────────────────
const RULES = [
  { agent: 'deploy',     test: (m) => /desplie|deploy|publica|sube.*(github|railway|vercel)|producci[oó]n/i.test(m) },
  { agent: 'builder',    test: (m) => /crea (un|una|el|la)? ?(archivo|carpeta|componente|endpoint|frontend|backend|app|p[aá]gina|pantalla|sitio|proyecto)/i.test(m) },
  { agent: 'architect',  test: (m) => /arquitectura|estructura|c[oó]mo organizo|dise[nñ]a/i.test(m) },
  { agent: 'analyzer',   test: (m, ctx) => Boolean(ctx.code) || /revisa|analiza|hay (un )?error|no funciona|bug/i.test(m) },
  { agent: 'next-step',  test: (m) => /qu[eé] sigue|siguiente paso|c[oó]mo contin[uú]o|qu[eé] hago (ahora|despu[eé]s)/i.test(m) },
];

const DEFAULT_AGENT = 'next-step';

function decideAgent(message, ctx = {}) {
  for (const rule of RULES) {
    if (rule.test(message, ctx)) return rule.agent;
  }
  return DEFAULT_AGENT;
}

// Detecta si el mensaje también matchea reglas de OTROS agentes
// además del elegido — pura comparación de texto, cero costo de IA.
function detectOtherIntents(message, ctx, chosenAgent) {
  const matches = RULES
    .filter(rule => rule.agent !== chosenAgent && rule.test(message, ctx))
    .map(rule => rule.agent);
  return [...new Set(matches)];
}

// ── API pública ──────────────────────────────────────────────
// route({ message, history, code, errorLog, projectState, autoExecute })
async function route(input) {
  const { message } = input;

  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new Error('orchestrator: el mensaje está vacío');
  }

  const agentName = decideAgent(message, input);
  const agent = AGENTS[agentName];

  if (!agent) {
    // Nunca debería pasar (decideAgent solo devuelve keys de AGENTS),
    // pero si pasa, fallamos explícito en vez de silencioso.
    logger.error('orchestrator', 'agente decidido no existe', { agentName });
    throw new Error(`orchestrator: agente desconocido "${agentName}"`);
  }

  logger.info('orchestrator', 'ruteando', { agent: agentName, messagePreview: message.slice(0, 60) });

  try {
    const result = await agent.run(input);
    logger.info('orchestrator', 'completado', { agent: agentName });

    const otherIntents = detectOtherIntents(message, input, agentName);
    if (otherIntents.length > 0) {
      logger.info('orchestrator', 'otras intenciones detectadas, sin atender', { otherIntents });
      result.content += `\n\n⚠️ También parece que pediste algo relacionado con: ${otherIntents.join(', ')} — pero en este mensaje solo respondí como "${agentName}". Pídelo en otro mensaje si también lo necesitas.`;
      result.otherIntents = otherIntents;
    }

    return result;
  } catch (err) {
    logger.error('orchestrator', 'agente falló', { agent: agentName, reason: err.message });
    throw err;
  }
}

module.exports = { route, decideAgent };
