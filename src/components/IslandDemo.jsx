import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadModel } from "../lib/assetLoader.js";

// ---------- Deterministic noise helpers (no external noise lib) ----------
function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function noise2D(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi), b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z) {
  let total = 0, amp = 0.5, freq = 1, max = 0;
  for (let i = 0; i < 4; i++) {
    total += noise2D(x * freq, z * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / max;
}
const ISLAND_R = 34;
function islandHeight(x, z) {
  const d = Math.sqrt(x * x + z * z);
  const edge = 1 - smoothstep(ISLAND_R * 0.58, ISLAND_R, d);
  const n = fbm(x * 0.12, z * 0.12);
  let h = (n * 2 - 1) * 2.6 * edge + edge * 1.4;
  if (d > ISLAND_R) {
    // gentle underwater slope (in absolute units, not a fraction of the island size)
    // so it reads as wading into shallow water rather than falling off a cliff
    const beyond = d - ISLAND_R;
    const t = smoothstep(0, 5, beyond);
    h = -t * 3.2;
  }
  return h;
}

// ---------- Toon gradient texture ----------
function makeToonGradient() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const shades = ["#4a4a4a", "#7d7d7d", "#b0b0b0", "#ffffff"];
  shades.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

const PALETTE = {
  fog: 0xb9c6c3,
  sky: 0xc7d3cf,
  sand: new THREE.Color("#c9b98f"),
  grass: new THREE.Color("#7c8b6f"),
  rock: new THREE.Color("#8c8880"),
  water: 0x5d7a78,
  trunk: "#5c4b3a",
  foliage: "#4f6b52",
  jacket: "#d9a441",
  skin: "#e3b48a",
  pack: "#6b4c3a",
};

export default function IslandDemo() {
  const mountRef = useRef(null);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ---------- Renderer / Scene / Camera ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(PALETTE.fog, ISLAND_R * 0.85, ISLAND_R * 3.1);

    // gradient sky dome (top cooler/lighter, horizon warmer) instead of flat color
    const skyGeo = new THREE.SphereGeometry(140, 24, 16);
    const skyPos = skyGeo.attributes.position;
    const skyColors = [];
    const skyTop = new THREE.Color("#a9c4c8");
    const skyHorizon = new THREE.Color("#e4dcc8");
    for (let i = 0; i < skyPos.count; i++) {
      const y = skyPos.getY(i);
      const t = smoothstep(-10, 90, y);
      const c = new THREE.Color().copy(skyHorizon).lerp(skyTop, t);
      skyColors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute("color", new THREE.Float32BufferAttribute(skyColors, 3));
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 200);

    const gradientMap = makeToonGradient();

    // ---------- Lights ----------
    const hemi = new THREE.HemisphereLight(0xdfe8e6, 0x596356, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3da, 1.1);
    sun.position.set(14, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -35;
    sun.shadow.camera.right = 35;
    sun.shadow.camera.top = 35;
    sun.shadow.camera.bottom = -35;
    sun.shadow.camera.far = 60;
    scene.add(sun);

    // ---------- Terrain ----------
    const segs = 90;
    const size = ISLAND_R * 2.4;
    const terrainGeo = new THREE.PlaneGeometry(size, size, segs, segs);
    terrainGeo.rotateX(-Math.PI / 2);
    const posAttr = terrainGeo.attributes.position;
    const colors = [];
    const tmpColor = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const h = islandHeight(x, z);
      posAttr.setY(i, h);
      if (h < 0.15) tmpColor.copy(PALETTE.sand);
      else if (h < 1.9) {
        const t = smoothstep(0.15, 1.9, h);
        tmpColor.copy(PALETTE.sand).lerp(PALETTE.grass, t);
      } else {
        const t = smoothstep(1.9, 3.6, h);
        tmpColor.copy(PALETTE.grass).lerp(PALETTE.rock, t);
      }
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    }
    terrainGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
    const terrainMat = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap,
    });
    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    scene.add(terrain);

    // ---------- Water ----------
    const waterGeo = new THREE.PlaneGeometry(size * 2.2, size * 2.2, 40, 40);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshToonMaterial({
      color: PALETTE.water,
      gradientMap,
      transparent: true,
      opacity: 0.85,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = -0.6;
    scene.add(water);
    const waterBase = waterGeo.attributes.position.array.slice();

    // ---------- Trees (instanced) ----------
    // sized clearly larger than the character (character total height ~1.65)
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 1.7, 6);
    const foliageGeo = new THREE.ConeGeometry(1.15, 2.7, 7);
    const trunkMat = new THREE.MeshToonMaterial({ color: PALETTE.trunk, gradientMap });
    const foliageMat = new THREE.MeshToonMaterial({ color: PALETTE.foliage, gradientMap });
    const TREE_COUNT = 52;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
    const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, TREE_COUNT);
    trunks.castShadow = true;
    foliage.castShadow = true;
    const dummy = new THREE.Object3D();
    const obstacles = []; // {x, z, r} used for simple circle-vs-circle collision
    const treePlacements = []; // stored so real tree models can be swapped in once loaded
    let placed = 0;
    let seed = 1;
    function rand() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    while (placed < TREE_COUNT) {
      const x = (rand() * 2 - 1) * ISLAND_R * 0.8;
      const z = (rand() * 2 - 1) * ISLAND_R * 0.8;
      const d = Math.sqrt(x * x + z * z);
      if (d > ISLAND_R * 0.78) continue;
      const h = islandHeight(x, z);
      if (h < 0.6) continue;
      const scale = 0.7 + rand() * 1.3;
      dummy.position.set(x, h + 0.85 * scale, z);
      dummy.scale.setScalar(scale);
      dummy.rotation.y = rand() * Math.PI * 2;
      dummy.updateMatrix();
      trunks.setMatrixAt(placed, dummy.matrix);
      dummy.position.y = h + 2.05 * scale;
      dummy.updateMatrix();
      foliage.setMatrixAt(placed, dummy.matrix);
      obstacles.push({ x, z, r: 0.3 * scale, top: h + 1.7 * scale }); // climbable like everything else
      treePlacements.push({ x, z, h, scale, rotY: dummy.rotation.y });
      placed++;
    }
    scene.add(trunks, foliage);

    // swap in the real Pirate-pack-adjacent nature models once loaded, keep the
    // procedural trunks/foliage above as the fallback if they're not available yet
    Promise.all([loadModel("/models/nature/CommonTree_2.gltf"), loadModel("/models/nature/Pine_1.gltf")]).then(
      ([commonTree, pine]) => {
        const variants = [commonTree, pine].filter(Boolean);
        if (variants.length === 0) return; // keep procedural fallback
        scene.remove(trunks, foliage);
        treePlacements.forEach((p, i) => {
          const src = variants[i % variants.length].scene;
          const model = src.clone(true);
          model.position.set(p.x, p.h, p.z);
          model.scale.setScalar(p.scale);
          model.rotation.y = p.rotY;
          model.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          scene.add(model);
        });
      }
    );

    // ---------- Rocks (instanced, ground detail) ----------
    // rocks are real obstacles you can climb onto if you jump high enough
    const rockGeo = new THREE.IcosahedronGeometry(0.4, 0);
    const rockMat = new THREE.MeshToonMaterial({ color: PALETTE.rock, gradientMap });
    const ROCK_COUNT = 30;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    const rockPlacements = [];
    let rplaced = 0;
    while (rplaced < ROCK_COUNT) {
      const x = (rand() * 2 - 1) * ISLAND_R * 0.85;
      const z = (rand() * 2 - 1) * ISLAND_R * 0.85;
      const d = Math.sqrt(x * x + z * z);
      if (d > ISLAND_R * 0.9) continue;
      const h = islandHeight(x, z);
      if (h < 0.1) continue;
      const scale = 0.5 + rand() * 1.1;
      const scaleY = scale * (0.6 + rand() * 0.5);
      const centerY = h + 0.15 * scale;
      dummy.position.set(x, centerY, z);
      dummy.scale.set(scale, scaleY, scale);
      dummy.rotation.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
      dummy.updateMatrix();
      rocks.setMatrixAt(rplaced, dummy.matrix);
      obstacles.push({ x, z, r: 0.4 * scale, top: centerY + 0.4 * scaleY });
      rockPlacements.push({ x, z, centerY, scale, scaleY, rot: dummy.rotation.clone() });
      rplaced++;
    }
    scene.add(rocks);

    Promise.all([loadModel("/models/nature/Rock_Medium_1.gltf"), loadModel("/models/nature/Rock_Medium_3.gltf")]).then(
      ([rock1, rock2]) => {
        const variants = [rock1, rock2].filter(Boolean);
        if (variants.length === 0) return;
        scene.remove(rocks);
        rockPlacements.forEach((p, i) => {
          const src = variants[i % variants.length].scene;
          const model = src.clone(true);
          model.position.set(p.x, p.centerY, p.z);
          model.scale.set(p.scale, p.scaleY, p.scale);
          model.rotation.copy(p.rot);
          model.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          scene.add(model);
        });
      }
    );

    // ---------- Bushes (instanced, same element in several sizes) ----------
    const bushGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const bushMat = new THREE.MeshToonMaterial({ color: "#5f7a4f", gradientMap });
    const BUSH_COUNT = 32;
    const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BUSH_COUNT);
    bushes.castShadow = true;
    bushes.receiveShadow = true;
    const bushPlacements = [];
    let bplaced = 0;
    let battempts = 0;
    while (bplaced < BUSH_COUNT && battempts < 4000) {
      battempts++;
      const x = (rand() * 2 - 1) * ISLAND_R * 0.82;
      const z = (rand() * 2 - 1) * ISLAND_R * 0.82;
      const d = Math.sqrt(x * x + z * z);
      if (d > ISLAND_R * 0.85) continue;
      const h = islandHeight(x, z);
      if (h < 0.4) continue;
      // wide size range so the same bush reads as small shrubs and large clumps
      const scale = 0.35 + rand() * 1.6;
      const bushR = 0.4 * scale;
      // keep clear of trees/rocks already placed, so bushes don't spawn inside them
      let tooClose = false;
      for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        const dx = x - o.x;
        const dz = z - o.z;
        const minDist = o.r + bushR + 0.6;
        if (dx * dx + dz * dz < minDist * minDist) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      dummy.position.set(x, h + 0.32 * scale, z);
      dummy.scale.set(scale, scale * 0.8, scale);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.updateMatrix();
      bushes.setMatrixAt(bplaced, dummy.matrix);
      obstacles.push({ x, z, r: bushR, top: h + 0.72 * scale });
      bushPlacements.push({ x, z, h, scale, rotY: dummy.rotation.y });
      bplaced++;
    }
    scene.add(bushes);

    loadModel("/models/nature/Bush_Common.gltf").then((gltf) => {
      if (!gltf) return;
      scene.remove(bushes);
      bushPlacements.forEach((p) => {
        const model = gltf.scene.clone(true);
        model.position.set(p.x, p.h, p.z);
        model.scale.set(p.scale, p.scale * 0.8, p.scale);
        model.rotation.y = p.rotY;
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        scene.add(model);
      });
    });

    // ---------- Grass tufts (instanced, ground texture) ----------
    // built as 4 thin crossed blades in one custom geometry so it reads as grass, not a mini tree
    function buildTuftGeometry() {
      const positions = [];
      const angles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
      const up = new THREE.Vector3(0, 1, 0);
      angles.forEach((a) => {
        const w = 0.045;
        const h = 0.34;
        const bend = 0.1;
        const p0 = new THREE.Vector3(-w / 2, 0, 0);
        const p1 = new THREE.Vector3(w / 2, 0, 0);
        const p2 = new THREE.Vector3(bend, h, 0);
        [p0, p1, p2].forEach((p) => p.applyAxisAngle(up, a));
        positions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      return geo;
    }
    const tuftGeo = buildTuftGeometry();
    const tuftMat = new THREE.MeshToonMaterial({ color: "#93a879", gradientMap, side: THREE.DoubleSide });
    const TUFT_COUNT = 170;
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFT_COUNT);
    let tplaced = 0;
    while (tplaced < TUFT_COUNT) {
      const x = (rand() * 2 - 1) * ISLAND_R * 0.82;
      const z = (rand() * 2 - 1) * ISLAND_R * 0.82;
      const d = Math.sqrt(x * x + z * z);
      if (d > ISLAND_R * 0.85) continue;
      const h = islandHeight(x, z);
      if (h < 0.4 || h > 2.1) continue;
      const scale = 0.7 + rand() * 0.9;
      dummy.position.set(x, h, z);
      dummy.scale.setScalar(scale);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.updateMatrix();
      tufts.setMatrixAt(tplaced, dummy.matrix);
      tplaced++;
    }
    scene.add(tufts);

    // ---------- Character (low-poly humanoid, joint-based rig, chibi proportions) ----------
    const character = new THREE.Group();
    const jacketMat = new THREE.MeshToonMaterial({ color: PALETTE.jacket, gradientMap });
    const pantsMat = new THREE.MeshToonMaterial({ color: "#46392c", gradientMap });
    const skinMat = new THREE.MeshToonMaterial({ color: PALETTE.skin, gradientMap });
    const hairMat = new THREE.MeshToonMaterial({ color: "#3a2f28", gradientMap });
    const shoeMat = new THREE.MeshToonMaterial({ color: "#2e2a26", gradientMap });
    const packMat = new THREE.MeshToonMaterial({ color: PALETTE.pack, gradientMap });
    const beltMat = new THREE.MeshToonMaterial({ color: "#2e2a26", gradientMap });
    const eyeWhiteMat = new THREE.MeshToonMaterial({ color: "#faf6ee", gradientMap });
    const pupilMat = new THREE.MeshToonMaterial({ color: "#241d18", gradientMap });
    const blushMat = new THREE.MeshToonMaterial({ color: "#e08a6b", gradientMap, transparent: true, opacity: 0.55 });

    function mesh(geo, mat, x, y, z) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    }

    // torso: shorter and rounder (chibi build), rounded caps at both ends hide the flat cylinder rims
    const torsoGroup = new THREE.Group();
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.36, 16), jacketMat, 0, 0.62, 0));
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.27, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), jacketMat, 0, 0.8, 0)); // rounded chest top
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 16), beltMat, 0, 0.45, 0)); // belt
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 10), skinMat, 0, 0.86, 0)); // neck
    torsoGroup.add(mesh(new THREE.BoxGeometry(0.3, 0.34, 0.18), packMat, 0, 0.65, -0.25)); // backpack
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), jacketMat, -0.31, 0.78, 0)); // left shoulder cap
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), jacketMat, 0.31, 0.78, 0)); // right shoulder cap
    character.add(torsoGroup);

    // head: enlarged (chibi ratio), with layered eyes (white + pupil), brows, blush and a proper hair cap
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.14, 0);
    headGroup.add(mesh(new THREE.SphereGeometry(0.3, 22, 18), skinMat, 0, 0, 0));
    // hair: a cluster of overlapping rounded clumps instead of a thin shell, so it reads as
    // actual volume/texture rather than a flat color patch covering half the head
    const hairClumps = [
      { x: 0, y: 0.24, z: -0.03, r: 0.17 }, // crown
      { x: -0.17, y: 0.15, z: -0.15, r: 0.14 }, // back-left
      { x: 0.17, y: 0.15, z: -0.15, r: 0.14 }, // back-right
      { x: -0.13, y: 0.17, z: 0.19, r: 0.12 }, // front-left fringe
      { x: 0.13, y: 0.17, z: 0.19, r: 0.12 }, // front-right fringe
      { x: 0, y: 0.09, z: -0.27, r: 0.13 }, // nape
    ];
    hairClumps.forEach((c) => headGroup.add(mesh(new THREE.SphereGeometry(c.r, 12, 10), hairMat, c.x, c.y, c.z)));
    headGroup.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), eyeWhiteMat, -0.12, 0.01, 0.265)); // left eye white
    headGroup.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), eyeWhiteMat, 0.12, 0.01, 0.265)); // right eye white
    headGroup.add(mesh(new THREE.SphereGeometry(0.026, 8, 8), pupilMat, -0.12, 0.005, 0.3)); // left pupil
    headGroup.add(mesh(new THREE.SphereGeometry(0.026, 8, 8), pupilMat, 0.12, 0.005, 0.3)); // right pupil
    headGroup.add(mesh(new THREE.BoxGeometry(0.09, 0.018, 0.02), hairMat, -0.12, 0.11, 0.29)); // left brow
    headGroup.add(mesh(new THREE.BoxGeometry(0.09, 0.018, 0.02), hairMat, 0.12, 0.11, 0.29)); // right brow
    headGroup.add(mesh(new THREE.SphereGeometry(0.055, 8, 6), blushMat, -0.19, -0.07, 0.235)); // left blush
    headGroup.add(mesh(new THREE.SphereGeometry(0.055, 8, 6), blushMat, 0.19, -0.07, 0.235)); // right blush
    headGroup.add(mesh(new THREE.BoxGeometry(0.04, 0.055, 0.05), skinMat, 0, -0.06, 0.29)); // nose
    headGroup.add(mesh(new THREE.BoxGeometry(0.1, 0.024, 0.02), pupilMat, 0, -0.15, 0.275)); // mouth
    character.add(headGroup);

    // legs: hip pivots so leg + shoe swing together as one rigid limb (short, stubby, chibi-style)
    function makeLeg(sideX) {
      const hip = new THREE.Group();
      hip.position.set(sideX, 0.5, 0);
      hip.add(mesh(new THREE.CylinderGeometry(0.11, 0.095, 0.36, 12), pantsMat, 0, -0.18, 0));
      hip.add(mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.1, 10), skinMat, 0, -0.4, 0)); // ankle
      const shoe = mesh(new THREE.BoxGeometry(0.18, 0.11, 0.29), shoeMat, 0, -0.47, 0.05);
      hip.add(shoe);
      character.add(hip);
      return hip;
    }
    const hipLeft = makeLeg(-0.13);
    const hipRight = makeLeg(0.13);

    // arms: shoulder pivots so arm + hand swing together as one rigid limb
    function makeArm(sideX) {
      const shoulder = new THREE.Group();
      shoulder.position.set(sideX, 0.78, 0);
      const armSign = sideX < 0 ? 1 : -1;
      const arm = mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.4, 10), jacketMat, 0, -0.2, 0);
      arm.rotation.z = armSign * 0.12;
      shoulder.add(arm);
      const hand = mesh(new THREE.SphereGeometry(0.09, 10, 8), skinMat, armSign * 0.04, -0.41, 0);
      shoulder.add(hand);
      character.add(shoulder);
      return shoulder;
    }
    const shoulderLeft = makeArm(-0.34);
    const shoulderRight = makeArm(0.34);

    character.scale.setScalar(1.15);
    character.position.set(0, islandHeight(0, 0), 0);
    scene.add(character);

    // ---------- Optional real character model (replaces the procedural body above) ----------
    // Uses one of the Pirate Kit characters (public/models/characters/). Change
    // CHARACTER_MODEL below to try a different crew member — they're all the same
    // rig/scale, so swapping the filename is enough.
    const CHARACTER_MODEL = "/models/characters/Characters_Anne.gltf";
    const MODEL_SCALE = 1;
    const MODEL_Y_OFFSET = 0;
    let mixer = null;
    let idleAction = null;
    let walkAction = null;
    let jumpAction = null;
    let currentAction = null;
    function setAction(action, fade = 0.2) {
      if (!action || currentAction === action) return;
      action.reset().fadeIn(fade).play();
      if (currentAction) currentAction.fadeOut(fade);
      currentAction = action;
    }
    loadModel(CHARACTER_MODEL).then((gltf) => {
      if (!gltf) return; // file not present yet: keep the procedural fallback
      torsoGroup.visible = false;
      headGroup.visible = false;
      hipLeft.visible = false;
      hipRight.visible = false;
      shoulderLeft.visible = false;
      shoulderRight.visible = false;
      const model = gltf.scene;
      model.scale.setScalar(MODEL_SCALE);
      model.position.y = MODEL_Y_OFFSET;
      model.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      character.add(model);
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        const findClip = (name) => gltf.animations.find((c) => c.name.toLowerCase() === name.toLowerCase());
        const idleClip = findClip("Idle") ?? gltf.animations[0];
        const walkClip = findClip("Walk");
        const jumpClip = findClip("Jump_Idle") ?? findClip("Jump");
        idleAction = idleClip ? mixer.clipAction(idleClip) : null;
        walkAction = walkClip ? mixer.clipAction(walkClip) : null;
        jumpAction = jumpClip ? mixer.clipAction(jumpClip) : null;
        setAction(idleAction, 0);
      }
    });

    // simple soft contact shadow blob
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.38, 16), blobMat);
    blob.rotation.x = -Math.PI / 2;
    scene.add(blob);

    // ---------- Camera rig state ----------
    let yaw = Math.PI * 0.25;
    let pitch = 0.45;
    let camDist = 8;
    const facing = { angle: 0 };

    function updateCamera(dt) {
      pitch = Math.max(0.15, Math.min(1.1, pitch));
      const cx = character.position.x + Math.sin(yaw) * Math.cos(pitch) * camDist;
      const cy = character.position.y + Math.sin(pitch) * camDist + 1.4;
      const cz = character.position.z + Math.cos(yaw) * Math.cos(pitch) * camDist;
      camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 6));
      const lookTarget = new THREE.Vector3(
        character.position.x,
        character.position.y + 1.1,
        character.position.z
      );
      camera.lookAt(lookTarget);
    }

    // ---------- Input: virtual joystick + camera drag + WASD ----------
    const pointers = new Map(); // pointerId -> { role, startX, startY, x, y }
    const joyState = { active: false, dx: 0, dy: 0, baseX: 0, baseY: 0 };
    const keys = { w: false, a: false, s: false, d: false };
    let jumpRequested = false;

    function onKeyDown(e) {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = true;
      if (k === " " || k === "spacebar") jumpRequested = true;
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if (k in keys) keys[k] = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function onPointerDown(e) {
      const isLeft = e.clientX < window.innerWidth / 2;
      const role = isLeft ? "move" : "look";
      pointers.set(e.pointerId, { role, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY });
      if (role === "move") {
        joyState.active = true;
        joyState.baseX = e.clientX;
        joyState.baseY = e.clientY;
        joyState.dx = 0;
        joyState.dy = 0;
        setJoyVisual(e.clientX, e.clientY, 0, 0, true);
      }
      setHint(false);
    }
    function onPointerMove(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      p.x = e.clientX;
      p.y = e.clientY;
      if (p.role === "move") {
        const max = 45;
        const len = Math.min(max, Math.hypot(dx, dy));
        const ang = Math.atan2(dy, dx);
        joyState.dx = (Math.cos(ang) * len) / max;
        joyState.dy = (Math.sin(ang) * len) / max;
        setJoyVisual(joyState.baseX, joyState.baseY, Math.cos(ang) * len, Math.sin(ang) * len, true);
      } else if (p.role === "look") {
        yaw -= dx * 0.005;
        pitch += dy * 0.004;
        p.startX = e.clientX;
        p.startY = e.clientY;
      }
    }
    function onPointerUp(e) {
      const p = pointers.get(e.pointerId);
      if (p && p.role === "move") {
        joyState.active = false;
        joyState.dx = 0;
        joyState.dy = 0;
        setJoyVisual(0, 0, 0, 0, false);
      }
      pointers.delete(e.pointerId);
    }

    const dom = renderer.domElement;
    dom.style.touchAction = "none";
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    // joystick visual elements
    const joyBase = document.createElement("div");
    const joyNub = document.createElement("div");
    Object.assign(joyBase.style, {
      position: "fixed",
      width: "90px",
      height: "90px",
      borderRadius: "50%",
      background: "rgba(35,40,38,0.32)",
      border: "2px solid rgba(35,40,38,0.6)",
      transform: "translate(-50%,-50%)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.15s",
      zIndex: 20,
    });
    Object.assign(joyNub.style, {
      position: "fixed",
      width: "40px",
      height: "40px",
      borderRadius: "50%",
      background: "rgba(217,164,65,0.9)",
      border: "2px solid rgba(35,40,38,0.5)",
      transform: "translate(-50%,-50%)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.15s",
      zIndex: 21,
    });
    mount.appendChild(joyBase);
    mount.appendChild(joyNub);

    // jump button (bottom-right, own pointer handling so it doesn't fight the camera drag)
    const jumpBtn = document.createElement("div");
    jumpBtn.textContent = "SALTA";
    Object.assign(jumpBtn.style, {
      position: "fixed",
      right: "24px",
      bottom: "34px",
      width: "76px",
      height: "76px",
      borderRadius: "50%",
      background: "rgba(35,40,38,0.38)",
      border: "2px solid rgba(35,40,38,0.6)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "12px",
      fontWeight: "700",
      letterSpacing: "0.5px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      userSelect: "none",
      touchAction: "none",
      zIndex: 22,
    });
    jumpBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      jumpRequested = true;
      jumpBtn.style.background = "rgba(217,164,65,0.55)";
    });
    jumpBtn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      jumpBtn.style.background = "rgba(35,40,38,0.38)";
    });
    mount.appendChild(jumpBtn);
    function setJoyVisual(baseX, baseY, nx, ny, visible) {
      joyBase.style.left = baseX + "px";
      joyBase.style.top = baseY + "px";
      joyBase.style.opacity = visible ? "1" : "0";
      joyNub.style.left = baseX + nx + "px";
      joyNub.style.top = baseY + ny + "px";
      joyNub.style.opacity = visible ? "1" : "0";
    }

    // ---------- Animation loop ----------
    const clock = new THREE.Clock();
    let walkPhase = 0;
    let walkAmp = 0;
    let vy = 0;
    let jumpY = 0;
    let grounded = true;
    let renderY = character.position.y;
    const GRAVITY = 20;
    const JUMP_SPEED = 7;
    let raf;
    function animate() {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      if (mixer) mixer.update(dt);

      // gentle water motion
      const arr = waterGeo.attributes.position.array;
      for (let i = 1; i < arr.length; i += 3) {
        const ox = waterBase[i - 1];
        const oz = waterBase[i + 1];
        arr[i] = waterBase[i] + Math.sin(t * 1.2 + ox * 0.3 + oz * 0.3) * 0.08;
      }
      waterGeo.attributes.position.needsUpdate = true;

      // movement input (joystick + keyboard)
      let mx = joyState.dx;
      let my = joyState.dy;
      if (keys.w) my -= 1;
      if (keys.s) my += 1;
      if (keys.a) mx -= 1;
      if (keys.d) mx += 1;
      const mlen = Math.hypot(mx, my);
      const charR = 0.34;
      const STEP_MARGIN = 0.15; // how far above an obstacle's top counts as "standing on it"
      const MOVE_LIMIT = ISLAND_R + 1.6; // lets you wade ~1-2 units into the water before the wall

      // true if (px,pz) is blocked given the character's current world height.
      // climbable obstacles (rocks) use their own footprint radius (matches groundHeightAt)
      // so there's no "dead zone" between being blocked and being supported.
      // non-climbable obstacles (trees/bushes) use footprint + character radius, as a solid wall.
      function blockedAt(px, pz, worldY) {
        for (let i = 0; i < obstacles.length; i++) {
          const o = obstacles[i];
          const dx = px - o.x;
          const dz = pz - o.z;
          if (o.top != null) {
            if (dx * dx + dz * dz < o.r * o.r && worldY < o.top - STEP_MARGIN) return true;
          } else {
            const rr = o.r + charR;
            if (dx * dx + dz * dz < rr * rr) return true;
          }
        }
        return false;
      }
      // ground height at a point, accounting for standing on top of a climbable obstacle
      function groundHeightAt(px, pz) {
        let gy = islandHeight(px, pz);
        for (let i = 0; i < obstacles.length; i++) {
          const o = obstacles[i];
          if (o.top == null) continue;
          const dx = px - o.x;
          const dz = pz - o.z;
          if (dx * dx + dz * dz < o.r * o.r) gy = Math.max(gy, o.top);
        }
        return gy;
      }

      let moving = false;
      const curWorldY = character.position.y;
      if (mlen > 0.05) {
        const nx = mx / Math.max(mlen, 1);
        const ny = my / Math.max(mlen, 1);
        const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
        const right = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2));
        const speed = 5.2;
        const move = new THREE.Vector3()
          .addScaledVector(forward, -ny * speed * dt)
          .addScaledVector(right, nx * speed * dt);

        // resolve collisions per-axis so the character slides along obstacles
        const curX = character.position.x;
        const curZ = character.position.z;
        let newX = curX;
        let newZ = curZ;
        const tryX = curX + move.x;
        if (Math.hypot(tryX, curZ) < MOVE_LIMIT && !blockedAt(tryX, curZ, curWorldY)) {
          newX = tryX;
        }
        const tryZ = curZ + move.z;
        if (Math.hypot(newX, tryZ) < MOVE_LIMIT && !blockedAt(newX, tryZ, curWorldY)) {
          newZ = tryZ;
        }
        if (newX !== curX || newZ !== curZ) {
          character.position.x = newX;
          character.position.z = newZ;
          facing.angle = Math.atan2(move.x, move.z);
          moving = true;
        }
      }
      character.rotation.y += (facing.angle - character.rotation.y) * Math.min(1, dt * 8);

      // jump physics (simple vertical offset above ground height)
      if (jumpRequested && grounded) {
        vy = JUMP_SPEED;
        grounded = false;
      }
      jumpRequested = false;
      vy -= GRAVITY * dt;
      jumpY += vy * dt;

      const groundY = groundHeightAt(character.position.x, character.position.z);
      if (jumpY <= 0) {
        jumpY = 0;
        vy = 0;
        grounded = true;
      }
      const targetY = groundY + jumpY;
      renderY += (targetY - renderY) * Math.min(1, dt * 14);
      character.position.y = renderY;
      blob.position.set(character.position.x, groundY + 0.02, character.position.z);
      blob.scale.setScalar(Math.max(0.4, 1 - jumpY * 0.25));

      // walking animation: smooth, natural cadence, arms and legs move together as real limbs
      walkAmp += ((moving && grounded ? 1 : 0) - walkAmp) * Math.min(1, dt * 6);
      if (moving) walkPhase += dt * 6.5;
      const swing = Math.sin(walkPhase) * 0.5 * walkAmp;
      const counterSwing = Math.sin(walkPhase + Math.PI) * 0.5 * walkAmp;
      hipLeft.rotation.x = swing;
      hipRight.rotation.x = counterSwing;
      shoulderLeft.rotation.x = counterSwing * 0.85;
      shoulderRight.rotation.x = swing * 0.85;
      // airborne pose driven by vertical velocity: legs tuck more near the apex (vy≈0),
      // and stay closer to extended at launch/landing — reads as a real jump arc, not a fixed contortion
      if (!grounded) {
        const vNorm = Math.max(-1, Math.min(1, vy / JUMP_SPEED));
        const apex = 1 - Math.abs(vNorm); // 0 at launch/landing, 1 at the peak
        const tuck = 0.1 + 0.28 * apex;
        hipLeft.rotation.x = tuck;
        hipRight.rotation.x = tuck;
        shoulderLeft.rotation.x = -0.5 - 0.4 * apex;
        shoulderRight.rotation.x = -0.5 - 0.4 * apex;
      }

      updateCamera(dt);
      if (idleAction || walkAction || jumpAction) {
        if (!grounded) setAction(jumpAction ?? walkAction ?? idleAction);
        else if (moving) setAction(walkAction ?? idleAction);
        else setAction(idleAction);
      }
      renderer.render(scene, camera);
    }
    animate();

    function onResize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      dom.removeEventListener("pointerdown", onPointerDown);
      mount.removeChild(joyBase);
      mount.removeChild(joyNub);
      mount.removeChild(jumpBtn);
      renderer.dispose();
      if (mount.contains(dom)) mount.removeChild(dom);
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", position: "relative", background: "#c7d3cf", overflow: "hidden" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      {hint && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(20,24,22,0.55)",
            color: "#f4f1ea",
            padding: "8px 16px",
            borderRadius: 999,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            letterSpacing: 0.2,
            zIndex: 30,
            pointerEvents: "none",
          }}
        >
          Tocca a sinistra per muoverti · trascina a destra per guardarti intorno
        </div>
      )}
    </div>
  );
}
