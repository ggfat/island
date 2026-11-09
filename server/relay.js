// Relay multiplayer minimale: nessun database, nessuna logica di gioco.
// Ogni "mondo" e' una stanza con codice casuale: la crea chi entra senza link, gli altri entrano con il link.
// Avvio:  node server/relay.js            (produzione: la stanza "test" e' spenta)
//         node server/relay.js --dev      (sviluppo: stanza "test" attiva, fino a 50 giocatori)
// Variabili: PORT (8787), ROOM_CAP (6), ALLOWED_ORIGIN, MAX_ROOMS (300)
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT) || 8787;
const DEV = process.argv.includes("--dev") || process.env.ALLOW_TEST_ROOM === "1";
const HARD_CAP = 12;
const ROOM_CAP = Math.min(HARD_CAP, Math.max(2, Number(process.env.ROOM_CAP) || 6));
const TEST_CAP = 50;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const TICK_MS = 100;
const STALE_MS = 15000;
const EMPTY_ROOM_TTL_MS = 3 * 60 * 60 * 1000; // una stanza vuota resta ricreabile per 3 ore
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;

function freeSlot(room) {
  const used = new Set([...room.players.values()].map((p) => p.c));
  let c = 0;
  while (used.has(c)) c++;
  return c;
}
const rooms = new Map(); // codice -> { code, players, hostToken, cap, places:Set, nextTint, emptySince }
let nextId = 1;

const wss = new WebSocketServer({
  port: PORT,
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
function makeRoom(code, hostToken, cap) {
  const r = { code, players: new Map(), hostToken, cap, places: new Set(), nextTint: 0, emptySince: null };
  rooms.set(code, r);
  return r;
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const token = (url.searchParams.get("token") || "").slice(0, 64);
  const mode = url.searchParams.get("mode") === "create" ? "create" : "join";
  const asHost = url.searchParams.get("host") === "1";
  let code = (url.searchParams.get("room") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (!/^[\w-]{8,64}$/.test(token)) return fail(ws, "token");

  let room;
  if (code === "test") {
    if (!DEV) return fail(ws, "notest");
    room = rooms.get("test") || makeRoom("test", token, TEST_CAP);
  } else if (mode === "create") {
    if (rooms.size >= MAX_ROOMS) return fail(ws, "busy");
    room = makeRoom(newCode(), token, ROOM_CAP);
  } else {
    room = rooms.get(code);
    if (!room) {
      // chi ha creato il mondo puo' ricrearlo con lo stesso codice (es. dopo un riavvio del server)
      if (asHost && /^[a-z0-9]{6,12}$/.test(code) && rooms.size < MAX_ROOMS) room = makeRoom(code, token, ROOM_CAP);
      else return fail(ws, "noroom");
    }
  }
  if (room.players.size >= room.cap) return fail(ws, "full");

  const id = nextId++;
  const isHost = room.hostToken === token;
  const me = { id, ws, c: freeSlot(room), d: null, f: [0, 0, 1], j: 0, m: 0, i: 0, b: -1, rx: 0, rz: 0, rh: 0, seen: Date.now(), msgs: 0, winStart: Date.now() };
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

console.log(`Relay su ws://0.0.0.0:${PORT} · max ${ROOM_CAP} giocatori per mondo · stanza test: ${DEV ? "ATTIVA" : "spenta"}`);
