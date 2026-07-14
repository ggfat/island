import * as THREE from "three";

// Tinte pensate per essere moltiplicate sulla texture: il bianco lascia il
// personaggio invariato, le altre lo sfumano quel poco che basta per
// distinguerlo da un altro giocatore con lo stesso personaggio base.
export const PLAYER_TINTS = [
  "#ffffff", "#ffb3b3", "#b3d1ff", "#b3ffc6", "#fff2b3",
  "#e0b3ff", "#ffd9b3", "#b3fff0", "#f7b3d9", "#d1d1d1",
];

// Converte il materiale del modello in cel-shading (coerente col resto del
// gioco) e applica la tinta, clonando il materiale così i giocatori con lo
// stesso personaggio base non si "tingono" a vicenda.
export function applyPlayerTint(model, tintHex, gradientMap) {
  const tint = new THREE.Color(tintHex);
  model.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    o.material = new THREE.MeshToonMaterial({
      map: src.map ?? null,
      color: tint,
      gradientMap,
      transparent: src.transparent,
      alphaTest: src.alphaTest,
      side: src.side,
    });
  });
}

// Data la lista dei personaggi scelti da tutti i giocatori nella sessione,
// restituisce la tinta per un giocatore specifico: il primo a scegliere un
// certo personaggio resta "originale", il successivo prende la tinta n.2, ecc.
export function tintForPlayer(playerIndex, allPlayerCharacterPaths) {
  const myPath = allPlayerCharacterPaths[playerIndex];
  let sameModelCountBefore = 0;
  for (let i = 0; i < playerIndex; i++) {
    if (allPlayerCharacterPaths[i] === myPath) sameModelCountBefore++;
  }
  return PLAYER_TINTS[sameModelCountBefore % PLAYER_TINTS.length];
}
