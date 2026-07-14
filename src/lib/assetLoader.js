import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map();

/**
 * Carica un modello .glb/.gltf da /public (es. "/models/character/character.glb").
 * Se il file non esiste ancora (404) o il caricamento fallisce, risolve a `null`
 * invece di lanciare un errore, così il chiamante può usare un fallback procedurale
 * senza rompere la scena mentre gli asset vengono aggiunti gradualmente.
 */
export function loadModel(path) {
  if (cache.has(path)) return cache.get(path);

  const promise = new Promise((resolve) => {
    loader.load(
      path,
      (gltf) => resolve(gltf),
      undefined,
      (err) => {
        console.info(`[assetLoader] "${path}" non trovato o non caricabile, uso il fallback procedurale.`, err?.message ?? err);
        resolve(null);
      }
    );
  });

  cache.set(path, promise);
  return promise;
}
