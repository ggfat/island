// Relay multiplayer minimale: nessun database, nessuna logica di gioco.
// Riceve la posizione di ogni giocatore e la rimanda agli altri della stessa stanza (10 Hz).
// Avvio:  node server/relay.js      (PORT=8787 di default, ALLOWED_ORIGIN opzionale)
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const MAX_PER_ROOM = 12;
const TICK_MS = 100;
const STALE_MS = 15000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // es. "https://tuodominio.it"

const rooms = new Map(); // nome -> { players: Map(id -> player), nextTint }
let nextId = 1;

const wss = new WebSocketServer({
  port: PORT,
  maxPayload: 1024,
  verifyClient: ({ origin }) => !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN,
});

const num = (v) => typeof v === "number" && Number.isFinite(v);
const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(num) && Math.abs(a[0]) < 2 && Math.abs(a[1]) < 2 && Math.abs(a[2]) < 2;
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const roomName = (url.searchParams.get("room") || "main").slice(0, 40).replace(/[^\w-]/g, "") || "main";
  let room = rooms.get(roomName);
  if (!room) rooms.set(roomName, (room = { players: new Map(), nextTint: 0 }));
  if (room.players.size >= MAX_PER_ROOM) {
    send(ws, { t: "full" });
    return ws.close();
  }
  const id = nextId++;
  const me = { id, ws, c: room.nextTint++, d: null, f: [0, 0, 1], j: 0, m: 0, i: 0, seen: Date.now(), msgs: 0, winStart: Date.now() };
  room.players.set(id, me);
  send(ws, { t: "hello", id, c: me.c });

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
    } else if (msg.t === "wave") {
      if (process.env.DEBUG) console.log("wave da", id);
      room.players.forEach((p) => p.id !== id && send(p.ws, { t: "wave", id }));
    }
  });
  ws.on("close", () => {
    room.players.delete(id);
    room.players.forEach((p) => send(p.ws, { t: "leave", id }));
    if (room.players.size === 0) rooms.delete(roomName);
  });
  ws.on("error", () => {});
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room) => {
    room.players.forEach((p) => { if (now - p.seen > STALE_MS) p.ws.terminate(); });
    const list = [];
    room.players.forEach((p) => p.d && list.push({ id: p.id, c: p.c, d: p.d, f: p.f, j: p.j, m: p.m, i: p.i }));
    room.players.forEach((p) => send(p.ws, { t: "state", n: room.players.size, p: list.filter((q) => q.id !== p.id) }));
  });
}, TICK_MS);

console.log(`Relay in ascolto su ws://0.0.0.0:${PORT}`);
