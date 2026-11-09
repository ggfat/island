# Island Game — demo tecnica

Base Vite + React + Three.js per il prototipo dell'isola esplorabile (personaggio,
cammino, salto, collisioni, oceano). Nasce dalla demo sviluppata in chat con Claude;
questa è la versione "vera", pensata per girare in locale e ricevere gli asset reali.

## Avvio

```bash
npm install
npm run dev
```

Apri l'URL che stampa Vite (di solito `http://localhost:5173`). Con `server.host: true`
(già configurato in `vite.config.js`) puoi aprirlo anche da telefono, se è sulla stessa
rete Wi-Fi del computer, usando l'IP locale al posto di `localhost`.

## Struttura

```
src/
  components/IslandDemo.jsx   ← tutta la scena Three.js (terreno, personaggio, input, camera)
  lib/assetLoader.js          ← helper per caricare modelli .glb con fallback automatico
public/
  models/character/           ← metti qui character.glb quando lo hai
  models/nature/               ← modelli degli asset naturali (alberi, rocce, cespugli...)
```

## Aggiungere il modello del personaggio

1. Copia il file in `public/models/character/character.glb`.
2. Ricarica la pagina: il codice in `IslandDemo.jsx` prova automaticamente a caricarlo
   e, se lo trova, nasconde il personaggio procedurale (fatto di forme geometriche) e
   mette al suo posto il modello vero.
3. Se il modello ha animazioni (es. esportate da Mixamo), la prima clip con un nome che
   contiene "walk", "idle" o "run" parte in automatico. Se i nomi sono diversi, modifica
   il regex in `IslandDemo.jsx` (cerca `MODEL_SCALE` per trovare il punto giusto) oppure
   seleziona direttamente `gltf.animations[0]`, `[1]`, ecc.
4. Se il modello appare troppo grande/piccolo o troppo alto/basso rispetto al terreno,
   regola `MODEL_SCALE` e `MODEL_Y_OFFSET` nello stesso punto del file.

Finché il file non c'è, il gioco continua a usare il personaggio procedurale — nessun
errore, nessuna schermata bianca.

## Aggiungere gli asset naturali (alberi, rocce, cespugli...)

Il terreno, gli alberi, le rocce e i cespugli sono generati proceduralmente in
`IslandDemo.jsx` (cerca i commenti `// ---------- Trees`, `// ---------- Rocks`,
`// ---------- Bushes`). Per sostituirli con i modelli veri del pacchetto nature:

1. Metti i file `.glb` (o `.gltf` + `.bin` + texture) in `public/models/nature/`.
2. Nel punto dove oggi viene creato un `THREE.InstancedMesh` con geometria procedurale,
   usa `loadModel("/models/nature/CommonTree_1.glb")` per caricare il modello e cloná/
   posizionalo nei punti già calcolati dal ciclo di piazzamento (le coordinate x/z e
   l'altezza del terreno sono già pronte, cambia solo la mesh usata).
3. Se preferisci, scrivimelo in chat quando riprendiamo il lavoro: preparo io
   l'integrazione una volta che gli asset sono al loro posto nel repository.

## Stato dell'integrazione asset (aggiornato)

Il codice ora prova a caricare davvero gli asset da `public/models/`, con
fallback automatico su quelli procedurali se un file manca:

- **Personaggio**: `public/models/characters/Characters_Anne.gltf` (cambia
  `CHARACTER_MODEL` in `IslandDemo.jsx` per usare un altro membro dell'equipaggio
  — sono tutti compatibili con lo stesso codice). Le animazioni Idle/Walk/Jump
  del modello vengono usate automaticamente in base allo stato del personaggio.
- **Alberi**: `public/models/nature/CommonTree_2.gltf` e `Pine_1.gltf`, alternati.
- **Rocce**: `public/models/nature/Rock_Medium_1.gltf` e `Rock_Medium_3.gltf`, alternate.
- **Cespugli**: `public/models/nature/Bush_Common.gltf`.
- **Erba**: ancora procedurale (lasciata così di proposito — 170 ciuffi con
  modelli reali individuali sarebbero più pesanti del necessario; se vuoi,
  possiamo ottimizzarla con istanziazione in un secondo momento).
- **Navi** (`public/models/ships/`): non ancora agganciate a nessuna meccanica
  di gioco — pronte per quando implementeremo "costruisci la barca".

Le collisioni, il salto e i confini restano invariati: sono calcolati sulle
stesse coordinate usate per piazzare gli asset, quindi funzionano identici sia
con i modelli procedurali che con quelli veri.

## Note tecniche

- Il loader (`assetLoader.js`) usa `GLTFLoader` da `three/examples/jsm/loaders/...`,
  incluso nel pacchetto `three` ma non esportato dall'entry point principale — per questo
  l'import è specifico (non funzionava nell'anteprima artifact di Claude, funziona qui).
- Le collisioni, il salto e l'animazione di camminata sono agganciati ai gruppi
  procedurali (`hipLeft`, `hipRight`, `shoulderLeft`, `shoulderRight`). Se sostituisci il
  personaggio con un modello animato, quei gruppi vengono semplicemente nascosti — la
  fisica di movimento/salto/collisioni resta quella del personaggio "invisibile" sotto,
  che il modello vero segue. Va benissimo per ora; se in futuro vuoi che le animazioni
  del modello siano guidate direttamente dallo stato di movimento (invece che da una clip
  fissa), è un passo successivo da fare insieme.

## Multiplayer (relay)

Il gioco funziona anche da solo. Per vedere altri giocatori serve il relay (Node, ~100 righe, nessun database):

```bash
npm install
npm run relay            # ws://localhost:8787  (PORT=... per cambiare porta)
npm run dev -- --host    # gioco; aprilo in due schede o da telefono sulla stessa Wi-Fi
```

- Stanza: `?room=nome` nell'URL (default `main`, max 12 giocatori per stanza).
- Server remoto: `VITE_RELAY_URL=wss://tuodominio.it/relay npm run build` (nginx con proxy WebSocket davanti al relay).
- `ALLOWED_ORIGIN=https://tuodominio.it` limita le origini ammesse.
- Tasto **G** o pulsante 👋 per salutare.

## Luoghi speciali

Sul pianeta ci sono 6 luoghi (segnati con un rombo giallo sulla minimappa) che si attivano solo se **almeno 2 persone** stanno nel cerchio: fontana, cerchio di pietre, altalena, lanterne del cielo, prato fiorito, campane del vento.
Per provarli da solo: apri il gioco con `?test=1` (simula un secondo giocatore).

## Controlli e menu

- Sinistra: muoviti · destra: guarda · 👋 / tasto G: saluta · ENTRA: entra nelle case (anche insieme ad altri giocatori).
- Tocca la **minimappa** per ingrandirla (mostra tutto il pianeta, i luoghi speciali col nome e gli altri giocatori in azzurro).
- ☰ → Aiuto, Invita amici (link alla stanza), Riconnetti, Esci. Tocca "offline" per riconnetterti.

## Mondi (stanze) e missioni

- Non esiste una stanza "main": chi entra per primo crea il proprio mondo (codice casuale di 8 caratteri) e invita gli altri col link `?room=CODICE`.
- Massimo 6 giocatori per mondo (`ROOM_CAP`, tetto assoluto 12).
- Un ospite può creare il proprio mondo solo dopo aver completato tutte le 6 missioni (menu ☰ → 🌍 Crea un nuovo mondo).
- Missione = attivare un luogo speciale (servono 2 giocatori). Un luogo attivato resta attivo per sempre nel mondo e compare "Missione completata".
- Stanza di sviluppo: `npm run relay:dev` e apri `?room=test` (disabilitata in produzione, o con `ALLOW_TEST_ROOM=1`).
- Variabili relay: `PORT`, `ROOM_CAP`, `MAX_ROOMS`, `ALLOWED_ORIGIN`. Mondi vuoti recuperabili dall'host per 3 ore.
- Limite noto: progresso e ruolo stanno in localStorage, il blocco "ospite non può creare" è solo lato client.

## Personaggi

Ogni giocatore del mondo ha un personaggio diverso (Anne, Henry, Mako, Capitan Barbarossa, Scheletro, Scheletro senza testa, Sharky), assegnato dal server con lo slot libero più basso. Oltre i 7 giocatori i modelli si ripetono con una tinta diversa.
