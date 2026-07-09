'use strict';

const logger = require('../logger');

// ── railway.client.js ───────────────────────────────────────
// Único archivo que habla con la API de Railway (GraphQL v2).
// Endpoint y mutaciones verificados contra la documentación oficial
// (docs.railway.com) — el dominio del endpoint cambió de
// backboard.railway.app a backboard.railway.com, por eso se corrige acá.

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const TOKEN = process.env.RAILWAY_TOKEN;

function assertToken() {
  if (!TOKEN) throw new Error('railway.client: falta RAILWAY_TOKEN en el entorno');
}

async function graphql(query, variables = {}) {
  assertToken();
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    logger.error('railway.client', 'graphql falló', { errors: data.errors });
    throw new Error(`railway.client: ${JSON.stringify(data.errors || res.status)}`);
  }
  return data.data;
}

// Crea un proyecto nuevo en Railway (si el usuario no tiene uno todavía)
async function createProject({ name }) {
  logger.info('railway.client', 'createProject', { name });
  const query = `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id name } }`;
  const result = await graphql(query, { input: { name } });
  logger.info('railway.client', 'proyecto creado', { id: result.projectCreate.id });
  return result.projectCreate;
}

// Crea un servicio nuevo dentro de un proyecto, conectado a un repo de GitHub
async function createServiceFromRepo({ projectId, name, repo, branch = 'main' }) {
  logger.info('railway.client', 'createServiceFromRepo', { projectId, name, repo });
  const query = `mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`;
  const result = await graphql(query, { input: { projectId, name, source: { repo }, branch } });
  logger.info('railway.client', 'servicio creado', { id: result.serviceCreate.id });
  return result.serviceCreate;
}

// Conecta un servicio YA existente a un repo (si se creó vacío antes)
async function connectRepo({ serviceId, repo, branch = 'main' }) {
  logger.info('railway.client', 'connectRepo', { serviceId, repo, branch });
  const query = `mutation serviceConnect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`;
  return graphql(query, { id: serviceId, input: { repo, branch } });
}

// Configura variables de entorno de un servicio de una sola vez
async function setVariables({ projectId, environmentId, serviceId, variables }) {
  logger.info('railway.client', 'setVariables', { projectId, serviceId, keys: Object.keys(variables) });
  const query = `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`;
  return graphql(query, { input: { projectId, environmentId, serviceId, variables } });
}

// Dispara un nuevo deploy para un servicio ya existente
async function triggerDeploy({ serviceId, environmentId }) {
  logger.info('railway.client', 'triggerDeploy', { serviceId, environmentId });
  const query = `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`;
  const result = await graphql(query, { serviceId, environmentId });
  logger.info('railway.client', 'deploy disparado', { serviceId });
  return result;
}

// Consulta el último deploy de un servicio (status: SUCCESS, BUILDING, FAILED, CRASHED...)
// Consulta el environment por default de un proyecto recién creado
// (normalmente "production"). Se usa para encadenar automático:
// crear proyecto -> ya sabemos su environmentId sin que el LLM lo adivine.
async function getDefaultEnvironment({ projectId }) {
  const query = `
    query project($id: String!) {
      project(id: $id) { environments { edges { node { id name } } } }
    }
  `;
  const result = await graphql(query, { id: projectId });
  const edges = result.project?.environments?.edges || [];
  return edges[0]?.node || null;
}

async function getLatestDeployment({ projectId, environmentId, serviceId }) {
  const query = `
    query deployments($input: DeploymentListInput!) {
      deployments(input: $input, first: 1) {
        edges { node { id status createdAt } }
      }
    }
  `;
  const result = await graphql(query, { input: { projectId, environmentId, serviceId } });
  return result.deployments.edges[0]?.node || null;
}

// Crea/expone un dominio público para el servicio (la URL final del backend)
async function createDomain({ projectId, environmentId, serviceId }) {
  logger.info('railway.client', 'createDomain', { serviceId });
  const query = `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`;
  const result = await graphql(query, { input: { projectId, environmentId, serviceId } });
  return result.serviceDomainCreate;
}

module.exports = {
  createProject,
  createServiceFromRepo,
  connectRepo,
  setVariables,
  triggerDeploy,
  getLatestDeployment,
  getDefaultEnvironment,
  createDomain,
};
