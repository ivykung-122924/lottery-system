console.log("SERVER BOOT START");

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;

// SAFE TEST ROUTE FIRST
app.get("/", (req, res) => {
  console.log("ROOT HIT");
  res.send("OK");
});

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SERVER RUNNING", PORT);
});


