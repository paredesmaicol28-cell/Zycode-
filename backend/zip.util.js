'use strict';

const AdmZip = require('adm-zip');
const logger = require('../logger');

// ── zip.util.js ─────────────────────────────────────────────
// Extrae SOLO archivos de texto/código de un .zip (ignora binarios:
// imágenes, PDFs, ejecutables — esos no le sirven al LLM y solo
// inflan el tamaño del mensaje).

const TEXT_EXT = new Set([
  'js','ts','jsx','tsx','py','json','md','txt','html','css',
  'yml','yaml','sql','sh','env','cjs','mjs','txt',
]);

function extractZip(base64) {
  const buffer = Buffer.from(base64, 'base64');
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const ext = entry.entryName.split('.').pop().toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;

    try {
      files.push({ path: entry.entryName, content: entry.getData().toString('utf8') });
    } catch (err) {
      logger.warn('uploads/zip.util', 'no se pudo leer una entrada del zip', {
        entry: entry.entryName, reason: err.message,
      });
    }
  }

  logger.info('uploads/zip.util', 'zip procesado', { totalEntries: entries.length, textFiles: files.length });
  return files;
}

// Arma un .zip en memoria a partir de archivos {ruta, contenido} —
// lo que usa el botón "Descargar todo" del frontend cuando builder
// genera varios archivos en un mismo plan.
function createZip(files) {
  const zip = new AdmZip();
  for (const f of files) {
    if (!f.ruta || f.contenido === undefined) continue;
    zip.addFile(f.ruta, Buffer.from(f.contenido, 'utf-8'));
  }
  logger.info('uploads/zip.util', 'zip creado', { files: files.length });
  return zip.toBuffer();
}

module.exports = { extractZip, createZip };
