// Client del relay. Se il server non c'e', il gioco resta in modalita' singola e riprova ogni pochi secondi.
// `url` puo' essere una stringa o una funzione (valutata a ogni tentativo, cosi' dopo la creazione usa il codice stanza).
export function connectRelay({ url, onHello, onState, onWave, onLeave, onStatus, onError }) {
  let ws = null, closed = false, retry = 0, timer = null;
  const api = {
    connected: false,
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(timer); if (ws) ws.close(); },
    reconnect() { if (ws && ws.readyState <= 1) return; closed = false; retry = 0; clearTimeout(timer); open(); },
  };
  function open() {
    if (closed) return;
    try { ws = new WebSocket(typeof url === "function" ? url() : url); } catch { schedule(); return; }
    ws.onopen = () => { retry = 0; api.connected = true; onStatus && onStatus(true); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "hello") onHello && onHello(m);
      else if (m.t === "state") onState && onState(m);
      else if (m.t === "wave") onWave && onWave(m);
      else if (m.t === "leave") onLeave && onLeave(m);
      else if (m.t === "error") { closed = true; clearTimeout(timer); onError && onError(m.why); }
    };
    ws.onclose = () => { api.connected = false; onStatus && onStatus(false); schedule(); };
    ws.onerror = () => {};
  }
  function schedule() {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(open, 1500 * retry);
  }
  open();
  return api;
}
