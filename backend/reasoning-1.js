// reasoning.js

import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompt.js";

// La IA lee su configuración (API key) desde la variable de entorno del servidor
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function askAI({ message, context }) {
  try {
    const response = await ai.responses.create({
      model: "gpt-5",
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content: `
Pregunta:
${message}

Estado actual de ZyCode:
${JSON.stringify(context, null, 2)}
`
        }
      ]
    });

    return response.output_text;

  } catch (error) {
    console.error("AI:", error);

    return "No pude analizar ZyCode en este momento.";
  }
}
