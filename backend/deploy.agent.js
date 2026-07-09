'use strict';

const fs = require('fs');
const path = require('path');
const llmClient = require('../llm-client');
const logger = require('../logger');
const github = require('../deploy-clients/github.client');
const railway = require('../deploy-clients/railway.client');
const vercel = require('../deploy-clients/vercel.client');
const supabaseMgmt = require('../deploy-clients/supabase.client');

const RULES = fs.readFileSync(path.join(__dirname, '../prompts/rules.prompt.txt'), 'utf-8');
const IDENTITY = fs.readFileSync(path.join(__dirname, '../prompts/identity.prompt.txt'), 'utf-8');
const DEPLOY_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/deploy.prompt.txt'), 'utf-8'
);

const name = 'deploy';

const OUTPUT_FORMAT = `
Responde SIEMPRE con un bloque \`\`\`json con un array de pasos, nada de texto libre afuera:
[{ "accion": "...", "detalle": "...", "riesgo": "ninguno|bajo|requiere_confirmacion", "params": {} }]

Acciones válidas: github-create-repo, github-upsert-files, railway-create-project, railway-create-service, railway-set-vars, railway-deploy, railway-create-domain, vercel-create-project, vercel-set-vars, vercel-deploy, supabase-create-project, supabase-run-sql, migracion-pendiente.

Para "supabase-run-sql": el SQL completo va en params.query. Siempre marca esta acción con "riesgo": "requiere_confirmacion".

Si el proyecto tiene backend y frontend en carpetas separadas dentro del mismo repo (monorepo), "vercel-create-project" debe incluir "rootDirectory" en params. No hace falta que adivines "framework" — si no lo sabes, déjalo null, el sistema ya lo detecta solo desde el package.json real.

Reglas de riesgo: crear repo/proyecto/servicio/subir archivos/crear dominio = "bajo". Configurar variables, lanzar cualquier deploy real, o cualquier acción sobre esquema de base de datos = SIEMPRE "requiere_confirmacion". Si falta un dato real para "params", ponlo null y marca "requiere_confirmacion" explicando qué falta en "detalle". Orden: repo -> archivos -> proyecto -> servicio -> variables -> deploy -> dominio -> supabase.
`.trim();

const EXECUTORS = {
  'github-create-repo':      (p) => github.createRepo(p),
  'github-upsert-files':     (p) => github.upsertFiles(p),
  'railway-create-project':  (p) => railway.createProject(p),
  'railway-create-service':  (p) => railway.createServiceFromRepo(p),
  'railway-set-vars':        (p) => railway.setVariables(p),
  'railway-deploy':          (p) => railway.triggerDeploy(p),
  'railway-create-domain':   (p) => railway.createDomain(p),
  'vercel-create-project':   (p) => vercel.createProjectFromRepo(p),
  'vercel-set-vars':         (p) => vercel.setEnvVars(p),
  'vercel-deploy':           (p) => vercel.triggerDeploy(p),
  'supabase-create-project': (p) => supabaseMgmt.createProject(p),
  'supabase-run-sql':        (p) => supabaseMgmt.runSql(p),
};

const FORCE_CONFIRMATION = new Set(['supabase-run-sql', 'supabase-create-project', 'railway-set-vars', 'vercel-set-vars']);

// ── Detección de framework, determinística (no adivinada por el LLM) ──
// Busca un package.json real dentro del "code" que ya armó routes/
// (archivos de texto o extraídos de un zip) y decide el framework
// mirando sus dependencias — no un guess del modelo.
function detectFrameworkFromCode(code) {
  if (!code) return null;
  const match = code.match(/--- [^\n]*package\.json ---\n([\s\S]*?)(?=\n--- |$)/);
  if (!match) return null;

  let pkg;
  try { pkg = JSON.parse(match[1]); } catch { return null; }

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  if (deps.next) return { framework: 'nextjs', kind: 'frontend' };
  if (deps.nuxt || deps.nuxt3) return { framework: 'nuxtjs', kind: 'frontend' };
  if (deps['@angular/core']) return { framework: 'angular', kind: 'frontend' };
  if (deps.svelte || deps['@sveltejs/kit']) return { framework: 'svelte', kind: 'frontend' };
  if (deps.vite && deps.vue) return { framework: 'vue', kind: 'frontend' };
  if (deps.vite) return { framework: 'vite', kind: 'frontend' };
  if (deps.vue) return { framework: 'vue', kind: 'frontend' };
  if (deps.react) return { framework: 'create-react-app', kind: 'frontend' };
  if (deps.express || deps.fastify || deps.koa) return { framework: null, kind: 'backend' };

  return null;
}

function extractContext(accion, resultado) {
  switch (accion) {
    case 'github-create-repo':
      return { owner: resultado.owner, repo: resultado.repo, githubRepoFull: `${resultado.owner}/${resultado.repo}` };
    case 'railway-create-project':
      return { railwayProjectId: resultado.id };
    case 'railway-create-service':
      return { railwayServiceId: resultado.id };
    case 'vercel-create-project':
      return { vercelProjectId: resultado.projectId, vercelProjectName: resultado.name };
    case 'supabase-create-project':
      return { supabaseProjectRef: resultado.projectRef, supabaseCredentials: resultado.credentials };
    default:
      return {};
  }
}

const PARAM_SOURCES = {
  owner: 'owner',
  repo: (ctx, step) => step.accion === 'github-upsert-files' ? ctx.repo : ctx.githubRepoFull,
  projectId: (ctx, step) => step.accion.startsWith('railway') ? ctx.railwayProjectId : ctx.supabaseProjectRef,
  serviceId: (ctx, step) => step.accion.startsWith('railway') ? ctx.railwayServiceId : undefined,
  environmentId: (ctx, step) => step.accion.startsWith('railway') ? ctx.railwayEnvironmentId : undefined,
  framework: (ctx, step) => step.accion === 'vercel-create-project' ? ctx.detectedFramework : undefined,
};

function resolveParams(step, context) {
  const params = { ...(step.params || {}) };
  for (const [key, source] of Object.entries(PARAM_SOURCES)) {
    if (params[key] != null) continue;
    const value = typeof source === 'function' ? source(context, step) : context[source];
    if (value != null) {
      logger.info(name, 'auto-rellenado desde contexto vivo', { accion: step.accion, key, value });
      params[key] = value;
    }
  }
  return params;
}

// ⚠️ Enmascara los VALORES de variables de entorno antes de que
// aparezcan en cualquier texto que se muestre al usuario o se
// guarde en el historial de chat (Supabase). Solo se ven las
// llaves (KEY), nunca el valor — igual que hicimos con la llave
// secreta de Supabase.
function redactStep(step) {
  const clone = { ...step, params: { ...(step.params || {}) } };

  if (step.accion === 'railway-set-vars' && clone.params.variables) {
    clone.params.variables = Object.fromEntries(
      Object.keys(clone.params.variables).map(k => [k, '***oculto***'])
    );
  }

  if (step.accion === 'vercel-set-vars' && Array.isArray(clone.params.envVars)) {
    clone.params.envVars = clone.params.envVars.map(v => ({ ...v, value: '***oculto***' }));
  }

  return clone;
}

// Reemplaza el bloque ```json``` visible del texto crudo por la
// versión con los valores ya enmascarados — así lo que se guarda
// en el historial nunca tiene el secreto en texto plano.
function redactRawText(rawText, plan) {
  if (!plan) return rawText;
  const redactedPlan = plan.map(redactStep);
  return rawText.replace(/```json[\s\S]*?```/, '```json\n' + JSON.stringify(redactedPlan, null, 2) + '\n```');
}

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
  try {
    const resultado = await executor(step.params || {});
    logger.info(name, 'paso ejecutado', { accion: step.accion });
    return { ...step, estado: 'ejecutado', resultado };
  } catch (err) {
    logger.error(name, 'paso falló al ejecutar', { accion: step.accion, reason: err.message });
    return { ...step, estado: 'fallido', error: err.message };
  }
}

// ── Verificación de éxito real ───────────────────────────────
// Sondea el estado del deploy un rato acotado (no infinito, esto
// corre dentro de un solo request HTTP). Si el build tarda más que
// esta ventana, se avisa "sigue en progreso" en vez de mentir que
// terminó.
async function pollStatus(checkFn, { maxAttempts = 6, intervalMs = 5000 } = {}) {
  const DONE_STATES = new Set(['SUCCESS', 'READY', 'FAILED', 'ERROR', 'CRASHED']);
  for (let i = 0; i < maxAttempts; i++) {
    let status;
    try { status = await checkFn(); } catch { status = null; }
    if (status && DONE_STATES.has(String(status).toUpperCase())) return String(status).toUpperCase();
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return 'EN_PROGRESO';
}

async function verifyDeployStep(resolvedStep, executed, context) {
  const p = resolvedStep.params || {};

  if (resolvedStep.accion === 'railway-deploy') {
    const projectId = context.railwayProjectId || p.projectId;
    const environmentId = context.railwayEnvironmentId || p.environmentId;
    const serviceId = context.railwayServiceId || p.serviceId;

    if (!projectId || !environmentId || !serviceId) return; // no hay suficiente info para verificar, no se inventa

    const status = await pollStatus(async () => {
      const dep = await railway.getLatestDeployment({ projectId, environmentId, serviceId });
      return dep?.status;
    });
    executed.deployStatus = status;

    if (status === 'SUCCESS') {
      try {
        const domain = await railway.createDomain({ projectId, environmentId, serviceId });
        if (domain?.domain) {
          context.railwayUrl = `https://${domain.domain}`;
          executed.url = context.railwayUrl;
        }
      } catch (err) {
        logger.warn(name, 'deploy de Railway exitoso, pero no se pudo obtener/crear el dominio', { reason: err.message });
      }
    }
  }

  if (resolvedStep.accion === 'vercel-deploy' && executed.resultado?.deploymentId) {
    const status = await pollStatus(async () => {
      const s = await vercel.getDeploymentStatus({ deploymentId: executed.resultado.deploymentId });
      return s?.status;
    });
    executed.deployStatus = status;
    if (executed.resultado.url) {
      context.vercelUrl = `https://${executed.resultado.url}`;
      executed.url = context.vercelUrl;
    }
  }
}

async function run({ message, history = [], errorLog = '', autoExecute = false, code = '' }) {
  logger.info(name, 'ejecutando', { historyLength: history.length, hasErrorLog: Boolean(errorLog), autoExecute, hasCode: Boolean(code) });

  const fullMessage = errorLog ? `${message}\n\nError del intento anterior:\n${errorLog}` : message;
  const messages = [...history, { role: 'user', content: fullMessage }];

  let text, model;
  try {
    ({ text, model } = await llmClient.send({
      systemPrompt: `${RULES}\n\n${IDENTITY}\n\n${DEPLOY_PROMPT}\n\n${OUTPUT_FORMAT}`,
      messages,
      agent: name,
      hasCode: Boolean(code),
      codeSize: code.length,
      forceDeep: Boolean(errorLog),
    }));
    logger.info(name, 'plan generado', { model });
  } catch (err) {
    logger.error(name, 'falló al generar plan', { reason: err.message });
    throw err;
  }

  const plan = parsePlan(text);
  if (!plan || !autoExecute) {
    const redactedPlan = plan ? plan.map(redactStep) : null;
    return { agent: name, content: redactRawText(text, plan), plan: redactedPlan, executed: false };
  }

  const detected = detectFrameworkFromCode(code);
  let context = detected?.framework ? { detectedFramework: detected.framework } : {};
  if (detected) logger.info(name, 'framework detectado', detected);

  const results = [];

  for (const step of plan) {
    const mustConfirm = step.riesgo === 'requiere_confirmacion' || FORCE_CONFIRMATION.has(step.accion);
    const resolvedParams = resolveParams(step, context);
    const resolvedStep = { ...step, params: resolvedParams };

    if (mustConfirm) {
      results.push({ ...redactStep(resolvedStep), estado: 'pendiente_confirmacion' });
      continue;
    }

    const executed = await executeStep(resolvedStep);
    results.push(executed);

    if (executed.estado === 'ejecutado') {
      context = { ...context, ...extractContext(step.accion, executed.resultado) };

      if (step.accion === 'railway-create-project' && context.railwayProjectId) {
        try {
          const env = await railway.getDefaultEnvironment({ projectId: context.railwayProjectId });
          if (env) context.railwayEnvironmentId = env.id;
        } catch (err) {
          logger.warn(name, 'no se pudo resolver el environment default de Railway', { reason: err.message });
        }
      }

      if (step.accion === 'railway-deploy' || step.accion === 'vercel-deploy') {
        await verifyDeployStep(resolvedStep, executed, context);
      }
    }
  }

  // ── Resumen final, formato checklist ─────────────────────────
  let finalContent = redactRawText(text, plan);

  const railwayDeploy = results.find(r => r.accion === 'railway-deploy');
  const vercelDeploy  = results.find(r => r.accion === 'vercel-deploy');
  const railwayOk = railwayDeploy?.deployStatus === 'SUCCESS';
  const vercelOk  = vercelDeploy?.deployStatus === 'READY';

  function mark(deployResult, ok) {
    if (!deployResult) return null;
    if (ok) return '✔';
    if (deployResult.deployStatus === 'EN_PROGRESO') return '⏳';
    return '✖';
  }
  function label(ok, deployResult) {
    if (ok) return 'OK';
    if (deployResult?.deployStatus === 'EN_PROGRESO') return 'en progreso';
    return 'falló';
  }

  if (railwayOk || vercelOk) {
    const lines = [];

    if (railwayOk && vercelOk) lines.push('✅ Backend y frontend desplegados correctamente.');
    else if (railwayOk) lines.push('✅ Backend desplegado correctamente.');
    else lines.push('✅ Frontend desplegado correctamente.');
    lines.push('');

    if (context.railwayUrl) { lines.push('Railway:'); lines.push(context.railwayUrl); lines.push(''); }
    if (context.vercelUrl)  { lines.push('Frontend:'); lines.push(context.vercelUrl); lines.push(''); }

    lines.push('Estado:');
    if (railwayDeploy) lines.push(`${mark(railwayDeploy, railwayOk)} Railway ${label(railwayOk, railwayDeploy)}`);
    if (vercelDeploy)  lines.push(`${mark(vercelDeploy, vercelOk)} Vercel ${label(vercelOk, vercelDeploy)}`);
    if (context.railwayUrl || context.vercelUrl) lines.push('✔ Dominio activo');

    finalContent += `\n\n${lines.join('\n')}`;
  }

  if (context.supabaseCredentials) {
    const { url, publicKey, secretKey } = context.supabaseCredentials;
    const maskedSecret = secretKey ? `${secretKey.slice(0, 12)}...${secretKey.slice(-4)}` : 'no disponible';
    finalContent += `\n\n🔑 Credenciales de Supabase (proyecto nuevo):\nURL: ${url}\nLlave pública: ${publicKey || 'no disponible'}\nLlave secreta: ${maskedSecret} (la completa no se imprime en el chat por seguridad; está en el resultado interno del paso)`;
  }

// Traduce el error crudo a algo entendible: causa probable + qué
// hacer. No inventa una causa que no se pueda deducir del mensaje —
// si no reconoce el patrón, muestra el error real tal cual.
function explainFailure(errorMsg = '') {
  const msg = errorMsg.toLowerCase();

  if (msg.includes('falta') && msg.includes('token')) {
    return { causa: 'Falta configurar un token en el .env del backend.', siguiente: 'Revisa que esa variable esté en tu .env y que el server la haya cargado al arrancar.' };
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return { causa: 'El token existe, pero fue rechazado — probablemente expiró, se revocó, o no tiene los permisos necesarios.', siguiente: 'Genera un token nuevo con los permisos correctos y actualízalo en tu .env.' };
  }
  if (msg.includes('404') || msg.includes('not found')) {
    return { causa: 'El recurso (proyecto, repo o servicio) no existe con ese nombre/ID, o el paso anterior no lo creó de verdad.', siguiente: 'Revisa que el paso anterior haya quedado "ejecutado" y no "fallido" antes que este.' };
  }
  if (msg.includes('429') || msg.includes('rate limit')) {
    return { causa: 'Se hicieron demasiadas solicitudes seguidas al servicio.', siguiente: 'Espera uno o dos minutos y vuelve a pedir el mismo deploy.' };
  }
  if (msg.includes('tiempo esperado') || msg.includes('timeout') || msg.includes('en_progreso')) {
    return { causa: 'El servicio tardó más de lo que este chat puede esperar en una sola respuesta.', siguiente: 'No significa que falló — revisa el dashboard del proveedor en unos minutos.' };
  }
  return { causa: errorMsg, siguiente: 'Revisa el mensaje de error de arriba; no es un patrón que reconozca automático.' };
}

const failedSteps = results.filter(r => r.estado === 'fallido');
if (failedSteps.length > 0) {
  const detalle = failedSteps.map(s => {
    const { causa, siguiente } = explainFailure(s.error);
    return `🔴 ${s.accion} — ${s.detalle || 'sin detalle'}\n   Por qué falló: ${causa}\n   Siguiente paso: ${siguiente}`;
  }).join('\n\n');

  finalContent += `\n\n${failedSteps.length} paso(s) fallaron:\n\n${detalle}`;
}

  return { agent: name, content: finalContent, plan: results, executed: true };
}

module.exports = { name, run };
