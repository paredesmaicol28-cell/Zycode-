'use strict';

// ── logger.js ────────────────────────────────────────────────
// REGLA: no importa nada de ninguna otra carpeta del proyecto.
// Solo consola — nada de archivos de texto en disco. Log = código
// (objetos estructurados), no strings sueltas en un .log.

function emit(level, scope, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...meta,
  };

  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);

  return entry;
}

module.exports = {
  info:  (scope, message, meta) => emit('info', scope, message, meta),
  warn:  (scope, message, meta) => emit('warn', scope, message, meta),
  error: (scope, message, meta) => emit('error', scope, message, meta),
};
