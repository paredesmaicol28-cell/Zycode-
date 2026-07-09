'use strict';

const vm = require('vm');

// ── syntax-checker.js ────────────────────────────────────────
// Verificación de sintaxis DETERMINÍSTICA — el mismo motor que usa
// "node -c", no la opinión de un modelo de IA. Cero dependencias
// internas (como logger.js): cualquier agente puede usar esto sin
// riesgo de dependencia circular.
//
// Limitación honesta: .jsx/.tsx no se pueden verificar así, porque
// V8 no entiende JSX sin transpilar primero (necesitaría Babel como
// dependencia nueva). Se marca explícito como "no verificable", no
// como "válido" — para no dar una falsa sensación de seguridad.

function verifyFileSyntax(ruta, contenido) {
  const ext = (ruta.split('.').pop() || '').toLowerCase();

  if (['js', 'mjs', 'cjs'].includes(ext)) {
    try {
      new vm.Script(contenido, { filename: ruta });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (ext === 'json') {
    try {
      JSON.parse(contenido);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (['jsx', 'tsx'].includes(ext)) {
    return { ok: null, error: 'no verificable sin transpilador (JSX) — revísalo a mano' };
  }

  return { ok: null, error: null }; // no es código (.txt, .md, .sql...), no aplica
}

// Extrae secciones "--- ruta ---\ncontenido" del texto que arma
// routes/chat.routes.js cuando concatena varios archivos — así
// analyzer puede verificar cada archivo por separado, no todo el
// blob como si fuera uno solo.
function extractCodeSections(code) {
  if (!code) return [];
  const sections = [];
  const regex = /--- ([^\n]+?) ---\n([\s\S]*?)(?=\n--- |$)/g;
  let m;
  while ((m = regex.exec(code)) !== null) {
    sections.push({ ruta: m[1].trim(), contenido: m[2] });
  }
  return sections;
}

module.exports = { verifyFileSyntax, extractCodeSections };
