'use strict';

const fs = require('fs');
const path = require('path');
const llmClient = require('../llm-client');
const logger = require('../logger');

const RULES = fs.readFileSync(path.join(__dirname, '../prompts/rules.prompt.txt'), 'utf-8');
const IDENTITY = fs.readFileSync(path.join(__dirname, '../prompts/identity.prompt.txt'), 'utf-8');
const NEXT_STEP_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/next-step.prompt.txt'), 'utf-8');
const SYSTEM_PROMPT = `${RULES}\n\n${IDENTITY}\n\n${NEXT_STEP_PROMPT}`;

const name = 'next-step';

async function run({ message, history = [], projectState = '' }) {
  logger.info(name, 'ejecutando', { historyLength: history.length });

  const fullMessage = projectState ? `${message}\n\nEstado actual del proyecto:\n${projectState}` : message;
  const messages = [...history, { role: 'user', content: fullMessage }];

  try {
    const { text, model } = await llmClient.send({ systemPrompt: SYSTEM_PROMPT, messages, agent: name });
    logger.info(name, 'completado', { model });
    return { agent: name, content: text };
  } catch (err) {
    logger.error(name, 'falló', { reason: err.message });
    throw err;
  }
}

module.exports = { name, run };
