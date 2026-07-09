'use strict';

const logger = require('../logger');

// ── github.client.js ────────────────────────────────────────
// Único archivo que habla con la API de GitHub. Lee el token de
// process.env — nunca lo recibe como parámetro ni lo loguea.

const GITHUB_API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;

function assertToken() {
  if (!TOKEN) throw new Error('github.client: falta GITHUB_TOKEN en el entorno');
}

function headers() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

// Averigua el usuario autenticado (necesario para buscar un repo "propio"
// cuando ya existe, sin que el caller tenga que saber su username).
async function getAuthenticatedUser() {
  assertToken();
  const res = await fetch(`${GITHUB_API}/user`, { headers: headers() });
  if (!res.ok) throw new Error(`github.client: no se pudo identificar al usuario (${res.status})`);
  const data = await res.json();
  return data.login;
}

// Crea un repositorio nuevo en la cuenta del usuario autenticado.
// Si ya existe uno con ese nombre, NO falla el plan completo —
// devuelve el repo existente con alreadyExisted: true para que el
// resto de los pasos (subir archivos, etc.) puedan seguir normal.
async function createRepo({ name, private: isPrivate = true, description = '', autoInit = true }) {
  assertToken();
  logger.info('github.client', 'createRepo', { name, isPrivate });

  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name, private: isPrivate, description, auto_init: autoInit }),
  });

  if (res.status === 422) {
    logger.warn('github.client', 'el repo ya existe, se reutiliza', { name });
    const owner = await getAuthenticatedUser();
    const existing = await fetch(`${GITHUB_API}/repos/${owner}/${name}`, { headers: headers() });
    if (!existing.ok) {
      throw new Error(`github.client: el repo "${name}" dio 422 pero no se pudo recuperar (${existing.status})`);
    }
    const data = await existing.json();
    return { owner: data.owner.login, repo: data.name, url: data.html_url, defaultBranch: data.default_branch, alreadyExisted: true };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('github.client', 'createRepo falló', { status: res.status });
    throw new Error(`github.client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  logger.info('github.client', 'repo creado', { fullName: data.full_name });
  return { owner: data.owner.login, repo: data.name, url: data.html_url, defaultBranch: data.default_branch, alreadyExisted: false };
}

// Crea o actualiza un archivo en un repo (commit directo a una rama)
async function upsertFile({ owner, repo, path, content, message, branch = 'main' }) {
  assertToken();
  logger.info('github.client', 'upsertFile', { owner, repo, path, branch });

  let sha;
  try {
    const existing = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
      headers: headers(),
    });
    if (existing.ok) sha = (await existing.json()).sha;
  } catch { /* no existe todavía, se crea de cero */ }

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error('github.client', 'upsertFile falló', { status: res.status, path });
    throw new Error(`github.client: ${res.status} — ${errText.slice(0, 200)}`);
  }

  const result = await res.json();
  logger.info('github.client', 'commit creado', { path, sha: result.commit?.sha });
  return { commitSha: result.commit?.sha, url: result.content?.html_url };
}

// Sube VARIOS archivos en secuencia (no paralelo, para no pisar shas entre sí).
// Pausa corta entre cada uno: GitHub tiene un rate limit secundario para
// requests muy seguidas — sin esto, proyectos con muchos archivos pueden
// empezar a fallar a mitad de camino, no al principio (el típico bug
// intermitente que es doloroso de debuggear).
async function upsertFiles({ owner, repo, branch = 'main', message, files }) {
  logger.info('github.client', 'upsertFiles', { owner, repo, count: files.length });
  const results = [];
  for (const f of files) {
    const r = await upsertFile({ owner, repo, branch, message: message || `add ${f.path}`, path: f.path, content: f.content });
    results.push({ path: f.path, ...r });
    if (files.length > 1) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function getLatestCommitStatus({ owner, repo, branch = 'main' }) {
  assertToken();
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${branch}/status`, { headers: headers() });
  if (!res.ok) throw new Error(`github.client: no se pudo leer status (${res.status})`);
  return res.json();
}

module.exports = { createRepo, upsertFile, upsertFiles, getLatestCommitStatus };
