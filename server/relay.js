// Relay multiplayer minimale: nessun database, nessuna logica di gioco.
// Ogni "mondo" e' una stanza con codice casuale: la crea chi entra senza link, gli altri entrano con il link.
// Avvio:  node server/relay.js            (produzione: la stanza "test" e' spenta)
//         node server/relay.js --dev      (sviluppo: stanza "test" attiva, fino a 50 giocatori)
// Variabili: PORT (8787), ROOM_CAP (6), ALLOWED_ORIGIN, MAX_ROOMS (300)
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8787;
const DEV = process.argv.includes("--dev") || process.env.ALLOW_TEST_ROOM === "1";
const HARD_CAP = 6; // un personaggio diverso per ogni giocatore (6 per bioma)
const ROOM_CAP = Math.min(HARD_CAP, Math.max(2, Number(process.env.ROOM_CAP) || 6));
const TEST_CAP = 50;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const TICK_MS = 100;
const STALE_MS = 15000;
const EMPTY_ROOM_TTL_MS = 3 * 60 * 60 * 1000; // una stanza vuota resta ricreabile per 3 ore
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

function freeSlot(room, pref) {
  const used = new Set([...room.players.values()].map((p) => p.c));
  if (Number.isInteger(pref) && pref >= 0 && pref < Math.min(7, room.cap) && !used.has(pref)) return pref;
  let c = 0;
  while (used.has(c)) c++;
  return c;
}
const rooms = new Map(); // codice -> { code, players, hostToken, cap, places:Set, nextTint, emptySince }
let nextId = 1;

// Se esiste la cartella dist/ (dopo "npm run build") il relay serve anche il client: un solo servizio, un solo URL.
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const SERVE_DIST = existsSync(join(DIST, "index.html"));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".woff2": "font/woff2",
};
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith("/")) p += "index.html";
  let file = normalize(join(DIST, p));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); } // niente uscite da dist/
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (extname(p)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
    file = join(DIST, "index.html"); // percorsi senza estensione -> la pagina del gioco
  }
  const hashed = file.startsWith(join(DIST, "assets") + sep); // i file di Vite hanno l'hash nel nome: cache lunga
  res.writeHead(200, {
    "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

// piccola API HTTP: GET /room/CODICE -> quali personaggi sono gia' occupati (serve alla schermata di scelta)
const httpServer = createServer((req, res) => {
  // /health: risposta minima, usata dal keep-alive e dall'health check di Render
  if ((req.url || "").split("?")[0] === "/health") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end("ok"); }
  const cors = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN || "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
  const m = /^\/room\/([a-z0-9]{1,12})$/i.exec((req.url || "").split("?")[0]);
  if (!m) {
    if (SERVE_DIST && (req.method === "GET" || req.method === "HEAD")) return serveStatic(req, res);
    res.writeHead(404, cors); return res.end("{}");
  }
  const room = rooms.get(m[1].toLowerCase());
  if (!room) { res.writeHead(200, cors); return res.end(JSON.stringify({ exists: false, taken: [] })); }
  res.writeHead(200, cors);
  res.end(JSON.stringify({ exists: true, n: room.players.size, cap: room.cap, taken: [...room.players.values()].map((p) => p.c) }));
});
httpServer.listen(PORT);

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 1024,
  verifyClient: ({ origin }) => !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN,
});

const num = (v) => typeof v === "number" && Number.isFinite(v);
const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(num) && Math.abs(a[0]) < 2 && Math.abs(a[1]) < 2 && Math.abs(a[2]) < 2;
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const fail = (ws, why) => { send(ws, { t: "error", why }); ws.close(); };
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // senza caratteri ambigui
function newCode() {
  for (;;) {
    const b = randomBytes(8);
    let c = "";
    for (let i = 0; i < 8; i++) c += ALPHABET[b[i] % ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
}
// un giocatore per personaggio: ogni bioma ha 6 personaggi (la stanza di sviluppo "test" non ha limite)
const biomeCap = (code) => (code === "test" ? 99 : 6);
function makeRoom(code, hostToken, cap) {
  cap = Math.min(cap, biomeCap(code));
  const r = { code, players: new Map(), hostToken, cap, places: new Set(), nextTint: 0, emptySince: null };
  rooms.set(code, r);
  return r;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const token = (url.searchParams.get("token") || "").slice(0, 64);
  const mode = url.searchParams.get("mode") === "create" ? "create" : "join";
  const prefChar = parseInt(url.searchParams.get("char"), 10);
  const asHost = url.searchParams.get("host") === "1";
  let code = (url.searchParams.get("room") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!/^[\w-]{8,64}$/.test(token)) return fail(ws, "token");

  let room;
  if (code === "test") {
    if (!DEV) return fail(ws, "notest");
    room = rooms.get("test") || makeRoom("test", token, TEST_CAP);
  } else if (mode === "create") {
    if (rooms.size >= MAX_ROOMS) return fail(ws, "busy");
    // il client genera il codice (da cui deriva la forma del mondo): il server lo accetta se valido e libero
    if (code) {
      if (!/^[a-hj-km-np-z2-9]{8}$/.test(code) || rooms.has(code)) return fail(ws, "exists");
      room = makeRoom(code, token, ROOM_CAP);
    } else room = makeRoom(newCode(), token, ROOM_CAP);
  } else {
    room = rooms.get(code);
    if (!room) {
      // chi ha creato il mondo puo' ricrearlo con lo stesso codice (es. dopo un riavvio del server)
      if (asHost && /^[a-z0-9]{6,12}$/.test(code) && rooms.size < MAX_ROOMS) room = makeRoom(code, token, ROOM_CAP);
      else return fail(ws, "noroom");
    }
  }
  // stesso dispositivo che rientra (es. Esci e poi Entra con un altro personaggio): la vecchia copia
  // viene tolta subito, altrimenti resta visibile come "fantasma" finche' la sua connessione non scade
  room.players.forEach((p) => {
    if (p.token !== token) return;
    room.players.delete(p.id);
    send(p.ws, { t: "error", why: "replaced" });
    try { p.ws.close(); } catch { /* gia' chiusa */ }
    room.players.forEach((q) => send(q.ws, { t: "leave", id: p.id }));
  });
  if (room.players.size >= room.cap) return fail(ws, "full");

  const id = nextId++;
  const isHost = room.hostToken === token;
  const me = { id, ws, token, c: freeSlot(room, prefChar), d: null, f: [0, 0, 1], j: 0, m: 0, i: 0, b: -1, rx: 0, rz: 0, rh: 0, seen: Date.now(), msgs: 0, winStart: Date.now() };
  room.players.set(id, me);
  room.emptySince = null;
  send(ws, { t: "hello", id, c: me.c, room: room.code, cap: room.cap, host: isHost });

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - me.winStart > 1000) { me.winStart = now; me.msgs = 0; }
    if (++me.msgs > 40) return; // antispam
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    me.seen = now;
    if (msg.t === "pos" && vec3(msg.d) && vec3(msg.f)) {
      me.d = msg.d; me.f = msg.f;
      me.j = num(msg.j) ? Math.max(0, Math.min(10, msg.j)) : 0;
      me.m = msg.m ? 1 : 0;
      me.i = msg.i ? 1 : 0;
      me.b = Number.isInteger(msg.b) && msg.b >= 0 && msg.b < 200 ? msg.b : -1;
      me.rx = num(msg.rx) ? Math.max(-30, Math.min(30, msg.rx)) : 0;
      me.rz = num(msg.rz) ? Math.max(-30, Math.min(30, msg.rz)) : 0;
      me.rh = num(msg.rh) ? msg.rh : 0;
    } else if (msg.t === "bye") {
      ws.close(); // uscita volontaria: libero subito il posto e il personaggio
    } else if (msg.t === "wave") {
      if (process.env.DEBUG) console.log("wave da", id);
      room.players.forEach((p) => p.id !== id && send(p.ws, { t: "wave", id }));
    } else if (msg.t === "place" && Number.isInteger(msg.p) && msg.p >= 0 && msg.p < 16) {
      room.places.add(msg.p); // un luogo attivato resta attivo per tutto il mondo
    }
  });
  ws.on("close", () => {
    room.players.delete(id);
    room.players.forEach((p) => send(p.ws, { t: "leave", id }));
    if (room.players.size === 0) room.emptySince = Date.now();
  });
  ws.on("error", () => {});
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0) {
      if (code !== "test" && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(code);
      return;
    }
    room.players.forEach((p) => { if (now - p.seen > STALE_MS) p.ws.terminate(); });
    const list = [];
    room.players.forEach((p) => p.d && list.push({ id: p.id, c: p.c, d: p.d, f: p.f, j: p.j, m: p.m, i: p.i, b: p.b, rx: p.rx, rz: p.rz, rh: p.rh }));
    const pl = [...room.places];
    room.players.forEach((p) => send(p.ws, { t: "state", n: room.players.size, cap: room.cap, pl, p: list.filter((q) => q.id !== p.id) }));
  });
}, TICK_MS);

// Keep-alive per il piano gratuito di Render, che spegne il servizio dopo 15 minuti senza traffico in ingresso.
// L'URL pubblico lo danno le variabili di Render: in locale non esistono e il ping non parte. KEEP_ALIVE=0 lo disattiva.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || (process.env.RENDER_EXTERNAL_HOSTNAME && `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
if (SELF_URL && process.env.KEEP_ALIVE !== "0") {
  setInterval(() => {
    fetch(SELF_URL.replace(/\/$/, "") + "/health")
      .then((r) => process.env.DEBUG && console.log("keep-alive", r.status))
      .catch(() => {});
  }, Number(process.env.KEEP_ALIVE_MS) || 10 * 60 * 1000);
}

console.log(`Relay su ws://0.0.0.0:${PORT} · max ${ROOM_CAP} giocatori per mondo · stanza test: ${DEV ? "ATTIVA" : "spenta"}`);
