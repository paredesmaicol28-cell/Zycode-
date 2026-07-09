'use strict';

const express = require('express');
const context = require('../supabase/context');
const logger = require('../logger');

const router = express.Router();

// GET /api/context/:project — trae el contexto guardado
router.get('/context/:project', async (req, res) => {
  try {
    const data = await context.getContext({ project: req.params.project });
    res.json({ success: true, context: data });
  } catch (err) {
    logger.error('routes/context', 'fallo en GET', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/context/:project — guarda o actualiza una clave
router.post('/context/:project', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ success: false, error: 'falta "key" o "value"' });
  }
  try {
    await context.saveContext({ project: req.params.project, key, value: String(value) });
    res.json({ success: true });
  } catch (err) {
    logger.error('routes/context', 'fallo en POST', { reason: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
