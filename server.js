// Servidor ligero para Render: solo sirve de "directorio".
// Guarda la IP local de la cámara de cada red y se la dice a quien abre la página desde esa misma red.
const express = require("express");
const cors = require("cors");

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

const TOKEN = process.env.TOKEN;
const locales = new Map(); // ipPublica -> { ip, port, ts }

const publicIp = (req) =>
  (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();

app.get("/", (req, res) => res.send("PIDAC relay activo"));

// El equipo local avisa su IP cada 20 s
app.post("/api/register", (req, res) => {
  if (!TOKEN || req.headers["x-token"] !== TOKEN) return res.sendStatus(401);
  const { ip, port } = req.body || {};
  if (!ip || !port) return res.sendStatus(400);
  locales.set(publicIp(req), { ip, port, ts: Date.now() });
  res.sendStatus(200);
});

// La página pregunta: ¿hay cámara en mi red?
app.get("/api/discover", (req, res) => {
  const s = locales.get(publicIp(req));
  if (!s || Date.now() - s.ts > 60000) return res.json({ found: false });
  res.json({ found: true, url: `http://${s.ip}:${s.port}/` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("PIDAC relay en puerto " + PORT));
