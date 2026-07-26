// server.js

import express from "express";
import chat from "./chat.js";

const app = express();

app.use(express.json());

// Estado del servidor
app.get("/", (req, res) => {
  res.json({
    name: "Zynay",
    status: "online",
    version: "1.0.0"
  });
});

// Chat con Zynay
app.use("/chat", chat);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Zynay ejecutándose en http://localhost:${PORT}`);
});
