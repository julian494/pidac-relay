// PIDAC RELAY v2 — igual que antes, pero con control de congestión:
// si un navegador va lento, se le SALTAN frames en vez de acumularlos
// (antes se acumulaban en memoria y el video se iba quedando atrás).
const express = require('express');
const app = express();
 
const PORT = process.env.PORT || 3000;
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'cambia-esto';
 
let lastFrame = null;
let lastFrameTime = 0;
let lastModel = 'ESP32-CAM';
const streamClients = new Set();
 
app.use('/upload', express.raw({ type: '*/*', limit: '4mb' }));
 
function checkSecret(req, res) {
  const given = req.query.secret || req.get('X-Device-Secret');
  if (given !== DEVICE_SECRET) {
    res.status(401).json({ ok: false, error: 'secret inválido' });
    return false;
  }
  return true;
}
 
function sendFrame(client, frame) {
  // Cliente lento: su buffer aún no se vació → saltar este frame
  if (client.writableNeedDrain) return;
  client.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n');
  client.write(frame);
  client.write('\r\n');
}
 
app.post('/upload', (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!req.body || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'body vacío' });
  }
  if (req.query.model || req.get('X-Model')) lastModel = req.query.model || req.get('X-Model');
 
  lastFrame = req.body;
  lastFrameTime = Date.now();
  for (const client of streamClients) sendFrame(client, lastFrame);
  res.json({ ok: true });
});
 
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  if (lastFrame) sendFrame(res, lastFrame);
  streamClients.add(res);
  req.on('close', () => streamClients.delete(res));
});
 
app.get('/snapshot', (req, res) => {
  if (!lastFrame) return res.status(503).json({ ok: false, error: 'sin frames aún' });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
  res.send(lastFrame);
});
 
app.get('/status', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const ageMs = lastFrame ? Date.now() - lastFrameTime : null;
  res.json({
    ok: true,
    connected: ageMs !== null && ageMs < 15000,
    model: lastModel,
    lastFrameAgeMs: ageMs,
    viewers: streamClients.size,
  });
});
 
app.get('/', (req, res) => res.send('PIDAC relay activo. Endpoints: /stream /snapshot /status /upload'));
 
app.listen(PORT, () => console.log('PIDAC relay escuchando en puerto ' + PORT));
 
