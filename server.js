// ══════════════════════════════════════════════════════════════
//  PIDAC RELAY — puente HTTPS público entre el ESP32-CAM (que vive
//  en una red local/hotspot sin certificado válido) y PIDAC en
//  GitHub Pages (HTTPS). El ESP32 EMPUJA frames hacia acá (nunca
//  al revés), así que no necesita puerto abierto ni certificado
//  propio — este servidor es el único que necesita HTTPS "real",
//  y en Render/Railway eso viene gratis y automático.
//
//  Rutas:
//    POST /upload?secret=XXX   — el ESP32 sube un frame JPEG (body binario)
//    GET  /stream              — el navegador ve el video en vivo (MJPEG)
//    GET  /snapshot            — última foto individual (equivalente a /capture)
//    GET  /status              — JSON: si hay cámara conectada y hace cuánto
// ══════════════════════════════════════════════════════════════
const express = require('express');
const app = express();
 
const PORT = process.env.PORT || 3000;
// Clave compartida con el ESP32 — cualquiera que la sepa puede subir frames,
// así que trátala como una contraseña. Se configura como variable de entorno
// en Render/Railway (Settings → Environment), NUNCA la escribas en el código.
const DEVICE_SECRET = process.env.DEVICE_SECRET || 'cambia-esto';
 
let lastFrame = null;      // Buffer JPEG más reciente
let lastFrameTime = 0;     // Date.now() de cuándo llegó
let lastModel = 'ESP32-CAM';
 
// Clientes actualmente viendo /stream — a cada uno le empujamos el frame
// apenas llega, en vez de que cada quien tenga que pedirlo por su cuenta.
const streamClients = new Set();
 
// El body de /upload es la foto JPEG cruda, no JSON — por eso el límite
// de tamaño explícito (una foto no debería pasar de ~1MB nunca).
app.use('/upload', express.raw({ type: '*/*', limit: '2mb' }));
 
function checkSecret(req, res) {
  const given = req.query.secret || req.get('X-Device-Secret');
  if (given !== DEVICE_SECRET) {
    res.status(401).json({ ok: false, error: 'secret inválido' });
    return false;
  }
  return true;
}
 
// ── POST /upload — el ESP32 llama esto cada vez que tiene un frame nuevo
app.post('/upload', (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!req.body || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'body vacío' });
  }
  if (req.query.model || req.get('X-Model')) lastModel = req.query.model || req.get('X-Model');
 
  lastFrame = req.body;
  lastFrameTime = Date.now();
 
  // Empujar a todos los que están viendo /stream ahora mismo
  const boundary = '\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
                    lastFrame.length + '\r\n\r\n';
  for (const client of streamClients) {
    client.write(boundary);
    client.write(lastFrame);
  }
 
  res.json({ ok: true });
});
 
// NOTA: hubo un intento de un endpoint /upload-stream (una sola conexión
// eterna, sin ida-y-vuelta por foto) para subir más el fps. Se quitó:
// Render (como la mayoría de plataformas con proxy delante) almacena en
// buffer el cuerpo de la petición antes de pasarlo a esta app, y como esa
// petición estaba diseñada para no terminar nunca, nunca llegaba nada —
// el ESP32 volvió a /upload (una petición POST normal por foto).
 
// ── GET /stream — MJPEG en vivo para el navegador (mismo formato que
//    el ESP32 servía directo antes, así que el <img> del frontend no
//    necesita cambiar de técnica, solo de URL).
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
 
  // Si ya hay un frame reciente, mándalo de inmediato para no dejar la
  // pantalla en negro mientras se espera el próximo frame del ESP32.
  if (lastFrame) {
    res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
               lastFrame.length + '\r\n\r\n');
    res.write(lastFrame);
  }
 
  streamClients.add(res);
  req.on('close', () => streamClients.delete(res));
});
 
// ── GET /snapshot — una sola foto (equivalente al viejo /capture)
app.get('/snapshot', (req, res) => {
  if (!lastFrame) return res.status(503).json({ ok: false, error: 'sin frames aún' });
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.send(lastFrame);
});
 
// ── GET /status — para que PIDAC sepa si la cámara está "viva"
app.get('/status', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const ageMs = lastFrame ? Date.now() - lastFrameTime : null;
  res.json({
    ok: true,
    connected: ageMs !== null && ageMs < 15000, // sin frame nuevo en 15s = se considera desconectada
    model: lastModel,
    lastFrameAgeMs: ageMs,
    viewers: streamClients.size,
  });
});
 
app.get('/', (req, res) => {
  res.send('PIDAC relay activo. Endpoints: /stream /snapshot /status /upload');
});
 
app.listen(PORT, () => {
  console.log('PIDAC relay escuchando en puerto ' + PORT);
});
 
 
