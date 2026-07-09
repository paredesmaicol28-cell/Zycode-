'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// ── local.client.js ─────────────────────────────────────────
// Escribe archivos generados por el agente builder a disco local,
// dentro de una carpeta "sandbox" (nunca fuera de ahí).
//
// FILES_OUTPUT_DIR se puede configurar por .env; si no está,
// usa ./generated dentro del backend.

const OUTPUT_DIR = path.resolve(__dirname, '..', process.env.FILES_OUTPUT_DIR || 'generated');

// ⚠️ Guardia de seguridad: si el LLM propone una ruta con "../" que
// intenta salirse de OUTPUT_DIR (por accidente o por un prompt raro),
// esto lo bloquea explícito en vez de escribir fuera del sandbox.
function resolveSafePath(relativePath) {
  const fullPath = path.resolve(OUTPUT_DIR, relativePath);
  if (!fullPath.startsWith(OUTPUT_DIR + path.sep) && fullPath !== OUTPUT_DIR) {
    throw new Error(`local.client: ruta fuera del directorio permitido: "${relativePath}"`);
  }
  return fullPath;
}

function writeFile({ ruta, contenido }) {
  if (!ruta || contenido === undefined) {
    throw new Error('local.client: falta "ruta" o "contenido"');
  }
  const fullPath = resolveSafePath(ruta);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contenido, 'utf-8');
  logger.info('local.client', 'archivo escrito', { ruta });
  return { ruta, fullPath };
}

function deleteFile({ ruta }) {
  if (!ruta) throw new Error('local.client: falta "ruta"');
  const fullPath = resolveSafePath(ruta);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  logger.info('local.client', 'archivo eliminado', { ruta });
  return { ruta };
}

module.exports = { writeFile, deleteFile, OUTPUT_DIR };
