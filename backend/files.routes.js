'use strict';

const express = require('express');
const { createZip } = require('../uploads/zip.util');
const logger = require('../logger');

const router = express.Router();

// POST /api/files/zip — arma un .zip en memoria a partir de los
// archivos que ya generó builder en esa conversación (el frontend
// ya tiene el contenido, solo lo reenvía para empaquetarlo).
router.post('/files/zip', (req, res) => {
  const { files } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ success: false, error: 'falta "files" (array de {ruta, contenido})' });
  }

  try {
    const buffer = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="zycode-files.zip"');
    res.send(buffer);
  } catch (err) {
    logger.error('routes/files', 'fallo armando zip', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
