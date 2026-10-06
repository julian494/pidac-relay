// ══════════════════════════════════════════════════════════════
//  PIDAC RELAY v2 — corre igual en Render (nube) o en tu portátil (local)
//
//  Rutas:
//    POST /upload   — el ESP32 sube un frame JPEG (header X-Device-Secret)
//    GET  /stream   — MJPEG en vivo para el navegador
//    GET  /snapshot — última foto
//    GET  /status   — JSON de estado
//
//  Cambios vs v1 (todos orientados a latencia):
//   - TCP_NODELAY: los frames no esperan a que se llene un paquete
//   - Si un navegador va lento NO se le acumulan frames (se salta el frame),
//     así el video siempre es "lo más reciente" y no se atrasa
//   - keep-alive largo para que el ESP32 reutilice la conexión
//   - Escucha en 0.0.0.0 e imprime tu IP local (para ponerla en el firmware)
//   - Si existe la carpeta ./public, la sirve (puedes poner ahí el index.html
//     de PIDAC y abrirlo desde http://localhost:3000, mismo origen = sin
//     problemas de Mixed Content)
// ══════════════════════════════════════════════════════════════
const express = require('express');
const os = require('os');
const path = require('path');
const app = express();
 
const PORT = process.env.PORT || 3000;
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'cambia-esto';
 
let lastFrame = null;
let lastFrameTime = 0;
let lastModel = 'ESP32-CAM';
const streamClients = new Set();
 
app.use('/upload', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // opcional
 
function checkSecret(req, res) {
  const given = req.query.secret || req.get('X-Device-Secret');
  if (given !== DEVICE_SECRET) {
    res.status(401).json({ ok: false, error: 'secret inválido' });
    return false;
  }
  return true;
}
 
function broadcast(frame) {
  const head = '--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + frame.length + '\r\n\r\n';
  for (const c of streamClients) {
    if (c.writableNeedDrain) continue; // cliente lento: salta este frame
    c.write(head);
    c.write(frame);
    c.write('\r\n');
  }
}
 
app.post('/upload', (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!req.body || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'body vacío' });
  }
  req.socket.setNoDelay(true);
  if (req.query.model || req.get('X-Model')) lastModel = req.query.model || req.get('X-Model');
 
  lastFrame = req.body;
  lastFrameTime = Date.now();
  broadcast(lastFrame);
 
  res.json({ ok: true });
});
 
app.get('/stream', (req, res) => {
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
 
  if (lastFrame) {
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + lastFrame.length + '\r\n\r\n');
    res.write(lastFrame);
    res.write('\r\n');
  }
 
  streamClients.add(res);
  req.on('close', () => streamClients.delete(res));
});
 
app.get('/snapshot', (req, res) => {
  if (!lastFrame) return res.status(503).json({ ok: false, error: 'sin frames aún' });
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
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
 
app.get('/', (req, res) => {
  res.send('PIDAC relay activo. Endpoints: /stream /snapshot /status /upload');
});
 
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('PIDAC relay escuchando en puerto ' + PORT);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  if (ips.length) {
    console.log('\nPon UNA de estas en el firmware (RELAY_URL):');
    ips.forEach(ip => console.log('   http://' + ip + ':' + PORT));
  }
  console.log('\nPIDAC (en este mismo PC) lee: http://localhost:' + PORT + '/stream\n');
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
 
