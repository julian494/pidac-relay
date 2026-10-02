// ══════════════════════════════════════════════════════════════
//  PIDAC RELAY v2 — el ESP32 sube frames por UN WebSocket persistente
//  (wss://.../ws-upload) en vez de un POST HTTP por frame. Cero
//  round-trip por foto: el límite pasa a ser el ancho de banda real.
//  El navegador sigue viendo /stream (MJPEG) igual que siempre, así
//  que el frontend NO cambia. /upload (HTTP) se mantiene de respaldo.
//
//  Rutas:
//    WS   /ws-upload      — ESP32 sube frames binarios (header X-Device-Secret)
//    POST /upload         — respaldo HTTP (un frame por petición)
//    GET  /stream         — MJPEG en vivo
//    GET  /snapshot       — última foto
//    GET  /status         — JSON de estado
// ══════════════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
 
const app = express();
const PORT = process.env.PORT || 3000;
// Configúralo en Render → Environment. Si no existe, el relay RECHAZA subidas.
const DEVICE_SECRET = process.env.DEVICE_SECRET || '';
 
let lastFrame = null;
let lastFrameTime = 0;
let lastModel = 'ESP32-CAM';
let wsDevice = false;          // ¿hay un ESP32 conectado por WebSocket?
let framesIn = 0;              // contador para fps de entrada
let fpsIn = 0;
 
const streamClients = new Set();
 
setInterval(() => { fpsIn = framesIn; framesIn = 0; }, 1000);
 
function broadcast(frame) {
  lastFrame = frame;
  lastFrameTime = Date.now();
  framesIn++;
  const head = '\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n';
  for (const c of streamClients) {
    // visor lento: salta el frame en vez de acumular memoria
    if (c.writableLength > 512 * 1024) continue;
    c.write(head);
    c.write(frame);
  }
}
 
function secretOk(given) {
  return DEVICE_SECRET !== '' && given === DEVICE_SECRET;
}
 
// ── HTTP de respaldo
app.use('/upload', express.raw({ type: '*/*', limit: '2mb' }));
app.post('/upload', (req, res) => {
  if (!secretOk(req.query.secret || req.get('X-Device-Secret'))) {
    return res.status(401).json({ ok: false, error: 'secret inválido' });
  }
  if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'body vacío' });
  if (req.get('X-Model')) lastModel = req.get('X-Model');
  broadcast(req.body);
  res.json({ ok: true });
});
 
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  if (lastFrame) {
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + lastFrame.length + '\r\n\r\n');
    res.write(lastFrame);
  }
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
    fpsIn,                 // fps reales que está recibiendo el relay
    transport: wsDevice ? 'websocket' : 'http',
  });
});
 
app.get('/', (req, res) => res.send('PIDAC relay v2 activo. /stream /snapshot /status /ws-upload'));
 
// ── WebSocket de subida (ESP32)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws-upload', maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
 
wss.on('connection', (ws, req) => {
  if (!secretOk(req.headers['x-device-secret'])) { ws.close(1008, 'secret'); return; }
  if (req.headers['x-model']) lastModel = String(req.headers['x-model']);
  wsDevice = true;
  console.log('ESP32 conectado por WebSocket');
  ws.on('message', (data, isBinary) => { if (isBinary) broadcast(data); });
  ws.on('close', () => { wsDevice = false; console.log('ESP32 desconectado'); });
  ws.on('error', () => {});
});
 
server.listen(PORT, () => console.log('PIDAC relay v2 en puerto ' + PORT));
 
