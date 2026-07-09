'use strict';

const fs = require('fs');
const path = require('path');
const llmClient = require('../llm-client');
const logger = require('../logger');

const RULES = fs.readFileSync(path.join(__dirname, '../prompts/rules.prompt.txt'), 'utf-8');
const IDENTITY = fs.readFileSync(path.join(__dirname, '../prompts/identity.prompt.txt'), 'utf-8');
const ARCHITECT_PROMPT = fs.readFileSync(path.join(__dirname, '../prompts/architect.prompt.txt'), 'utf-8');
const SYSTEM_PROMPT = `${RULES}\n\n${IDENTITY}\n\n${ARCHITECT_PROMPT}`;

const name = 'architect';

async function run({ message, history = [], code = '', images = [] }) {
  logger.info(name, 'ejecutando', { historyLength: history.length, hasCode: Boolean(code), images: images.length });

  const fullMessage = code ? `${message}\n\n\`\`\`\n${code}\n\`\`\`` : message;
  const messages = [...history, { role: 'user', content: fullMessage }];

  try {
    const { text, model } = await llmClient.send({
      systemPrompt: SYSTEM_PROMPT,
      messages,
      agent: name,
      hasCode: Boolean(code),
      codeSize: code.length,
      images,
    });
    logger.info(name, 'completado', { model });
    return { agent: name, content: text };
  } catch (err) {
    logger.error(name, 'falló', { reason: err.message });
    throw err;
  }
}

module.exports = { name, run };
