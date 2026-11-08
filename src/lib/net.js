// Client del relay. Se il server non c'e', il gioco resta in modalita' singola e riprova ogni pochi secondi.
export function connectRelay({ url, onHello, onState, onWave, onLeave, onStatus }) {
  let ws = null, closed = false, retry = 0, timer = null;
  const api = {
    connected: false,
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(timer); if (ws) ws.close(); },
  };
  function open() {
    if (closed) return;
    try { ws = new WebSocket(url); } catch { schedule(); return; }
    ws.onopen = () => { retry = 0; api.connected = true; onStatus && onStatus(true); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "hello") onHello && onHello(m);
      else if (m.t === "state") onState && onState(m);
      else if (m.t === "wave") onWave && onWave(m);
      else if (m.t === "leave") onLeave && onLeave(m);
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
