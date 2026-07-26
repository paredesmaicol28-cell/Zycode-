// chat.js

import express from "express";
import { monitor } from "./monitor.js";
import { askAI } from "./reasoning.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "El mensaje es obligatorio."
      });
    }

    // Obtener el estado actual de ZyCode
    const context = await monitor();

    // Enviar pregunta + contexto a la IA
    const response = await askAI({
      message,
      context
    });

    res.json({
      success: true,
      response
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: "Error interno de Zynay."
    });
  }
});

export default router;
