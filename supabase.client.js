'use strict';

const logger = require('../logger');

// ── supabase.client.js ──────────────────────────────────────
// Habla con la MANAGEMENT API de Supabase (api.supabase.com) —
// distinta a supabase/client.js, que habla con la Data API de UN
// proyecto ya existente. Esta crea proyectos enteros, espera a que
// terminen de aprovisionarse, corre SQL de esquema, y obtiene las
// credenciales del proyecto recién creado.
//
// Necesita SUPABASE_MANAGEMENT_TOKEN (personal access token de
// Supabase). SUPABASE_ORG_ID es opcional — si falta, se detecta
// automático (la primera organización de la cuenta).

const MGMT_API = 'https://api.supabase.com';
const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const ENV_ORG_ID = process.env.SUPABASE_ORG_ID;

function assertToken() {
  if (!TOKEN) throw new Error('supabase.client: falta SUPABASE_MANAGEMENT_TOKEN en el entorno');
}

function headers() {
  return { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

// ── Organización ─────────────────────────────────────────────
// Si no hay SUPABASE_ORG_ID en el entorno, se detecta sola pidiendo
// la lista de organizaciones de la cuenta y usando la primera.
async function getOrganizations() {
  assertToken();
  const res = await fetch(`${MGMT_API}/v1/organizations`, { headers: headers() });
  if (!res.ok) throw new Error(`supabase.client: no se pudo listar organizaciones (${res.status})`);
  return res.json();
}

async function resolveOrgId(explicitOrgId) {
  if (explicitOrgId) return explicitOrgId;
  if (ENV_ORG_ID) return ENV_ORG_ID;

  logger.info('supabase.client', 'SUPABASE_ORG_ID no configurado, se detecta automático');
  const orgs = await getOrganizations();
  if (!orgs || orgs.length === 0) {
    throw new Error('supabase.client: no se encontró ninguna organización en esta cuenta');
  }
  logger.info('supabase.client', 'organización detectada', { orgId: orgs[0].id, name: orgs[0].name });
  return orgs[0].id;
}

// ── Estado del proyecto ──────────────────────────────────────
async function getProject(projectRef) {
  assertToken();
  const res = await fetch(`${MGMT_API}/v1/projects/${projectRef}`, { headers: headers() });
  if (!res.ok) throw new Error(`supabase.client: no se pudo leer el proyecto (${res.status})`);
  return res.json();
}

const ACTIVE_STATES = new Set(['ACTIVE_HEALTHY', 'ACTIVE']);
const FAILED_STATES = new Set(['INIT_FAILED', 'FAILED']);

// Sondea el estado del proyecto hasta que quede activo, falle, o se
// acabe el tiempo de espera. Un proyecto nuevo de Supabase suele
// tardar 1-2 minutos en aprovisionarse — por eso la ventana es más
// larga que la de Railway/Vercel.
async function waitUntilActive(projectRef, { maxAttempts = 12, intervalMs = 5000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const project = await getProject(projectRef);

    if (ACTIVE_STATES.has(project.status)) return project;
    if (FAILED_STATES.has(project.status)) {
      throw new Error(`supabase.client: el proyecto terminó en estado ${project.status}`);
    }

    logger.info('supabase.client', 'proyecto aún no listo, reintentando', {
      status: project.status, intento: i + 1, de: maxAttempts,
    });
    if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('supabase.client: el proyecto no terminó de aprovisionarse en el tiempo esperado (revisa el dashboard)');
}

// ── Credenciales ─────────────────────────────────────────────
// Soporta tanto las llaves nuevas (publishable/secret) como las
// legacy (anon/service_role) — Supabase está migrando de una a
// otra y no todos los proyectos tienen el mismo formato todavía.
async function getApiKeys(projectRef) {
  assertToken();
  const res = await fetch(`${MGMT_API}/v1/projects/${projectRef}/api-keys`, { headers: headers() });
  if (!res.ok) throw new Error(`supabase.client: no se pudieron obtener las api keys (${res.status})`);

  const keys = await res.json();
  const find = (name) => keys.find(k => k.name === name)?.api_key || null;

  return {
    url: `https://${projectRef}.supabase.co`,
    publicKey: find('anon') || find('publishable') || find('default') || null,
    secretKey: find('service_role') || find('secret') || null,
  };
}

// Crea un proyecto de Supabase nuevo desde cero, espera a que quede
// activo, y trae sus credenciales reales para devolverlas al agente.
async function createProject({ name, dbPass, region = 'us-east-1', plan = 'free', orgId }) {
  assertToken();
  const resolvedOrgId = await resolveOrgId(orgId);

  if (!dbPass) throw new Error('supabase.client: falta dbPass — nunca se genera automático, debe venir explícito');

  logger.info('supabase.client', 'createProject', { name, region, orgId: resolvedOrgId });

  const res = await fetch(`${MGMT_API}/v1/projects`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name, organization_id: resolvedOrgId, db_pass: dbPass, region, plan }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('supabase.client', 'createProject falló', { status: res.status });
    throw new Error(`supabase.client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  logger.info('supabase.client', 'proyecto creado, esperando a que quede activo', { ref: data.id });

  const activeProject = await waitUntilActive(data.id);

  let credentials = null;
  try {
    credentials = await getApiKeys(data.id);
  } catch (err) {
    logger.warn('supabase.client', 'proyecto activo, pero no se pudieron obtener las credenciales automático', { reason: err.message });
  }

  return {
    projectRef: data.id,
    name: data.name,
    apiUrl: `https://${data.id}.supabase.co`,
    status: activeProject.status,
    credentials, // { url, publicKey, secretKey } o null si falló la obtención
  };
}

// Corre SQL de esquema (CREATE TABLE, ALTER TABLE para foreign keys, etc).
// Antes de ejecutar, espera a que el proyecto esté activo — si acaba
// de crearse, todavía puede estar aprovisionándose.
async function runSql({ projectRef, query }) {
  assertToken();
  if (!projectRef) throw new Error('supabase.client: falta projectRef');
  if (!query || !query.trim()) throw new Error('supabase.client: falta "query"');

  await waitUntilActive(projectRef);

  logger.info('supabase.client', 'runSql', { projectRef, queryPreview: query.slice(0, 80) });

  const res = await fetch(`${MGMT_API}/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query, read_only: false }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('supabase.client', 'runSql falló', { status: res.status, projectRef });
    throw new Error(`supabase.client: ${res.status} — ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  logger.info('supabase.client', 'SQL ejecutado', { projectRef });
  return data;
}

module.exports = { createProject, runSql, getOrganizations, getProject, waitUntilActive, getApiKeys };
