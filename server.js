'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const logger = require('./logger');
const chatRoutes = require('./routes/chat.routes');
const contextRoutes = require('./routes/context.routes');
const filesRoutes = require('./routes/files.routes');

// ── server.js ────────────────────────────────────────────────
// Único punto de entrada. Carga el .env, arma el servidor HTTP,
// conecta las rutas. No tiene lógica de negocio propia.

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' })); // zips en base64 pesan ~33% más que el archivo original

app.use('/api', chatRoutes);
app.use('/api', contextRoutes);
app.use('/api', filesRoutes);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'zycode-backend' });
});

// Manejador de errores no capturados en rutas — última red de
// seguridad, nunca deja que el server responda vacío o se caiga.
app.use((err, req, res, next) => {
  logger.error('server', 'error no manejado', { reason: err.message });
  res.status(500).json({ success: false, error: 'error interno del servidor' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info('server', `ZyCode backend escuchando en puerto ${PORT}`, {
    env: process.env.NODE_ENV || 'development',
  });
});
