'use strict';

const logger = require('../logger');

// ── vercel.client.js ────────────────────────────────────────
// Único archivo que habla con la API de Vercel. Endpoint de
// creación de proyecto verificado contra docs.vercel.com (v11).

const VERCEL_API = 'https://api.vercel.com';
const TOKEN = process.env.VERCEL_TOKEN;

function assertToken() {
  if (!TOKEN) throw new Error('vercel.client: falta VERCEL_TOKEN en el entorno');
}

function headers() {
  return { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

// Crea (importa) un proyecto nuevo conectado a un repo de GitHub.
// rootDirectory es clave en monorepos (ej: tu repo tiene backend/ y
// frontend/ separados) — sin esto, Vercel intenta buildear el repo
// completo y falla en vez de buildear solo la carpeta del frontend.
async function createProjectFromRepo({ name, repo, framework = null, rootDirectory = null, envVars = [] }) {
  assertToken();
  logger.info('vercel.client', 'createProjectFromRepo', { name, repo, rootDirectory });

  const res = await fetch(`${VERCEL_API}/v11/projects`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name,
      gitRepository: { type: 'github', repo },
      framework,
      rootDirectory,
      environmentVariables: envVars.map(v => ({
        key: v.key,
        value: v.value,
        target: v.target || ['production'],
        type: 'encrypted',
      })),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('vercel.client', 'createProjectFromRepo falló', { status: res.status });
    throw new Error(`vercel.client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  logger.info('vercel.client', 'proyecto creado', { id: data.id });
  return { projectId: data.id, name: data.name };
}

// Agrega/actualiza variables de entorno en un proyecto ya existente
async function setEnvVars({ projectId, envVars }) {
  assertToken();
  logger.info('vercel.client', 'setEnvVars', { projectId, count: envVars.length });

  const res = await fetch(`${VERCEL_API}/v10/projects/${projectId}/env`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(envVars.map(v => ({
      key: v.key,
      value: v.value,
      target: v.target || ['production'],
      type: 'encrypted',
    }))),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`vercel.client: ${res.status} — ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// Dispara un deploy nuevo a producción para un proyecto ya conectado a GitHub
async function triggerDeploy({ projectName, gitBranch = 'main' }) {
  assertToken();
  logger.info('vercel.client', 'triggerDeploy', { projectName, gitBranch });

  const res = await fetch(`${VERCEL_API}/v13/deployments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: projectName,
      gitSource: { type: 'github', ref: gitBranch },
      target: 'production',
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('vercel.client', 'triggerDeploy falló', { status: res.status });
    throw new Error(`vercel.client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  logger.info('vercel.client', 'deploy disparado', { id: data.id });
  return { deploymentId: data.id, url: data.url };
}

// Consulta el estado de un deploy (READY, ERROR, BUILDING...) y su URL final
async function getDeploymentStatus({ deploymentId }) {
  assertToken();
  const res = await fetch(`${VERCEL_API}/v13/deployments/${deploymentId}`, { headers: headers() });
  if (!res.ok) throw new Error(`vercel.client: no se pudo leer status (${res.status})`);
  const data = await res.json();
  return { status: data.readyState, url: data.url };
}

module.exports = { createProjectFromRepo, setEnvVars, triggerDeploy, getDeploymentStatus };
