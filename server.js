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
 
// ── POST /upload-stream — el ESP32 abre UNA conexión y empuja frames
//    seguidos sin esperar respuesta entre cada uno (Transfer-Encoding:
//    chunked). Elimina el round-trip HTTP completo por frame que
//    limitaba /upload: ahí cada foto pagaba ida-y-vuelta completa a
//    Render antes de poder mandar la siguiente, así que el techo real
//    de FPS era 1000/RTT (con RTT~200ms, max ~5fps) sin importar qué
//    tan rápido subiera el ESP32. Aquí solo se paga el tiempo de subir
//    los bytes del JPEG — el límite pasa a ser el ancho de banda real,
//    no la latencia a Render.
//
//    Formato que debe mandar el ESP32 por cada frame, dentro del mismo
//    cuerpo de la petición (como chunks HTTP normales):
//      --pidacframe\r\nContent-Length: <N>\r\n\r\n<N bytes JPEG>\r\n
app.post('/upload-stream', (req, res) => {
  if (!checkSecret(req, res)) return;

  let buf = Buffer.alloc(0);
  const BOUNDARY = Buffer.from('--pidacframe\r\n');
  const MAX_BUF = 3 * 1024 * 1024; // tope de seguridad por si algo queda mal formado

  if (req.query.model || req.get('X-Model')) lastModel = req.query.model || req.get('X-Model');

  req.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_BUF) { buf = Buffer.alloc(0); return; } // corta-fuegos

    // Procesa todos los frames completos que ya llegaron en este chunk
    while (true) {
      const bIdx = buf.indexOf(BOUNDARY);
      if (bIdx === -1) break;
      const headerStart = bIdx + BOUNDARY.length;
      const headerEnd = buf.indexOf('\r\n\r\n', headerStart);
      if (headerEnd === -1) break; // el header todavía no llegó completo, espera más datos

      const headerStr = buf.slice(headerStart, headerEnd).toString();
      const m = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(headerEnd + 4); continue; } // header raro, descarta y sigue

      const len = parseInt(m[1], 10);
      const dataStart = headerEnd + 4;
      const dataEnd = dataStart + len;
      if (buf.length < dataEnd + 2) break; // el frame aún no llegó completo

      const frame = buf.slice(dataStart, dataEnd);
      lastFrame = frame;
      lastFrameTime = Date.now();

      const boundaryOut = '\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
                           frame.length + '\r\n\r\n';
      for (const client of streamClients) {
        client.write(boundaryOut);
        client.write(frame);
      }

      buf = buf.slice(dataEnd + 2); // salta el \r\n final de este frame
    }
  });

  req.on('end',   () => { if (!res.headersSent) res.json({ ok: true }); });
  req.on('close', () => { /* el ESP32 cortó la conexión — normal al reconectar */ });
  req.on('error', () => { /* conexión caída a medias — normal en WiFi inestable */ });
});

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
 
