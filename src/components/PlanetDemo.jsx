import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadModel } from "../lib/assetLoader.js";
import { createAudio } from "../lib/audio.js";
import { connectRelay } from "../lib/net.js";
import { PLAYER_TINTS, applyPlayerTint } from "../lib/characterTint.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

// Draws N copies of a loaded model with ONE draw call (InstancedMesh) instead of N clones.
function extractInstanceSources(gltf) {
  const sources = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (o.isMesh) sources.push({ geometry: o.geometry, material: o.material, localMatrix: o.matrixWorld.clone() });
  });
  return sources;
}
function buildInstanced(sources, placements) {
  const meshes = sources.map(({ geometry, material }) => {
    const inst = new THREE.InstancedMesh(geometry, material, placements.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    return inst;
  });
  const m = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  placements.forEach((p, i) => {
    m.compose(p.pos, p.quat, new THREE.Vector3(p.scale, p.scale, p.scale));
    sources.forEach((src, sIdx) => {
      tmp.multiplyMatrices(m, src.localMatrix);
      meshes[sIdx].setMatrixAt(i, tmp);
    });
  });
  meshes.forEach((mm) => (mm.instanceMatrix.needsUpdate = true));
  return meshes;
}

// ---------- Seamless pseudo-3D noise (no poles/seams, unlike lat-long noise) ----------
// A handful of fixed "wave directions" summed together — cheap and good enough
// for gentle planet terrain, with none of the pole-pinching artifacts you'd get
// from projecting 2D noise onto a sphere via spherical coordinates.
const NOISE_WAVES = [
  { v: new THREE.Vector3(1, 0.3, -0.5).normalize(), f: 1.3, a: 1.0, p: 0.7 },
  { v: new THREE.Vector3(-0.6, 1, 0.2).normalize(), f: 2.1, a: 0.5, p: 1.9 },
  { v: new THREE.Vector3(0.4, -0.7, 1).normalize(), f: 3.7, a: 0.25, p: 3.1 },
  { v: new THREE.Vector3(-1, -0.2, 0.6).normalize(), f: 5.3, a: 0.125, p: 4.4 },
];
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function noiseAt(dir) {
  let h = 0;
  for (const n of NOISE_WAVES) h += Math.sin(dir.dot(n.v) * n.f * Math.PI + n.p) * n.a;
  return h;
}
// Water is concentrated into exactly two seas instead of scattered wherever the
// noise happens to dip — each sea is a region around a fixed center direction.
const SEA_CENTERS = [new THREE.Vector3(0.6, -0.3, 0.7).normalize(), new THREE.Vector3(-0.7, 0.2, -0.5).normalize()];
const SEA_RADIUS = 0.6; // radians
function seaMask(dir) {
  let m = 0;
  for (const c of SEA_CENTERS) {
    const ang = dir.angleTo(c);
    m = Math.max(m, 1 - smoothstep(SEA_RADIUS * 0.5, SEA_RADIUS, ang));
  }
  return m; // 1 deep inside a sea region, fading to 0 outside SEA_RADIUS
}
// Catene montuose: cime lontane dai mari e dal punto di partenza.
const MOUNTAINS = [
  { c: new THREE.Vector3(0.9, 0.2, -0.4).normalize(), r: 0.58, h: 8.0 },
  { c: new THREE.Vector3(-0.8, -0.4, 0.45).normalize(), r: 0.52, h: 7.0 },
  { c: new THREE.Vector3(0.2, -0.9, -0.3).normalize(), r: 0.5, h: 6.2 },
  { c: new THREE.Vector3(0.5, -0.2, -0.8).normalize(), r: 0.4, h: 5.0 },
];
function mountainAt(dir) {
  let m = 0;
  for (const mt of MOUNTAINS) {
    const k = 1 - smoothstep(0.0, mt.r, dir.angleTo(mt.c));
    if (k <= 0) continue;
    const ridge = 0.85 + 0.15 * Math.sin(dir.x * 23 + dir.y * 17 + dir.z * 29);
    m = Math.max(m, mt.h * k * k * ridge);
  }
  return m;
}
function hillsAt(dir) {
  // colline morbide sparse su tutto il pianeta
  const a = Math.sin(dir.dot(new THREE.Vector3(0.7, 0.2, -0.6)) * 7.5 + 1.3);
  const b = Math.sin(dir.dot(new THREE.Vector3(-0.3, 0.8, 0.5)) * 9.1 + 0.4);
  return Math.max(0, a * b) * 2.2;
}
function terrainHeight(dir) {
  const noise = noiseAt(dir);
  const mask = seaMask(dir);
  const landH = noise * 0.55 + 1.0 + hillsAt(dir) + mountainAt(dir); // colline e montagne vere
  const seaH = noise * 0.3 - 2.2; // genuinely deep water inside the two sea regions
  return landH * (1 - mask) + seaH * mask;
}

const PLANET_R = 40; // ~un terzo della superficie di prima (era 68)
const SEA_LEVEL = -0.5; // verified empirically: land never dips this low outside the two sea regions

function makeToonGradient() {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  ["#4a4a4a", "#7d7d7d", "#b0b0b0", "#ffffff"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(i, 0, 1, 1);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

export default function PlanetDemo() {
  const mountRef = useRef(null);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const loadStat = { pending: 0, done: 0 };
    const loadModelT = (pth) => {
      loadStat.pending++;
      return Promise.resolve(loadModel(pth)).finally(() => loadStat.done++);
    };
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ---------- Renderer / Scene / Camera ----------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#bcd6d8", PLANET_R * 2.4, PLANET_R * 6.5);

    const camera = new THREE.PerspectiveCamera(52, width / height, 0.1, PLANET_R * 40);
    const gradientMap = makeToonGradient();

    // ---------- Sky: a large gradient dome surrounding everything ----------
    const skyGeo = new THREE.SphereGeometry(PLANET_R * 18, 24, 16);
    const skyPos = skyGeo.attributes.position;
    const skyColors = [];
    const skyTop = new THREE.Color("#5f9fc7");
    const skyHorizon = new THREE.Color("#dce9e6");
    for (let i = 0; i < skyPos.count; i++) {
      const y = skyPos.getY(i);
      const t = smoothstep(-PLANET_R * 2, PLANET_R * 10, y);
      const c = new THREE.Color().copy(skyHorizon).lerp(skyTop, t);
      skyColors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute("color", new THREE.Float32BufferAttribute(skyColors, 3));
    const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // ---------- Lights ----------
    const hemi = new THREE.HemisphereLight(0xdfe8e6, 0x596356, 0.95);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3da, 1.15);
    sun.position.set(18, 24, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    scene.add(sun.target);
    const sunDirVec = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

    // ---------- Planet: an icosahedron displaced by seamless noise, so it reads ----------
    // as a small rocky/grassy world you can walk all the way around
    const PALETTE = { sand: "#c9b98f", grass: "#7c8b6f", rock: "#8c8880", snow: "#eef1ee", trunk: "#5c4b3a", foliage: "#4f6b52" };
    const sandC = new THREE.Color(PALETTE.sand);
    const grassC = new THREE.Color(PALETTE.grass);
    const rockC = new THREE.Color(PALETTE.rock);
    const snowC = new THREE.Color(PALETTE.snow);

    const planetGeo = new THREE.IcosahedronGeometry(PLANET_R, 40);
    const posAttr = planetGeo.attributes.position;
    const dir = new THREE.Vector3();
    const colors = [];
    const tmpColor = new THREE.Color();
    for (let i = 0; i < posAttr.count; i++) {
      dir.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
      const h = terrainHeight(dir);
      posAttr.setXYZ(i, dir.x * (PLANET_R + h), dir.y * (PLANET_R + h), dir.z * (PLANET_R + h));
      if (h < SEA_LEVEL + 0.35) tmpColor.copy(sandC);
      else if (h < 1.1) tmpColor.copy(sandC).lerp(grassC, smoothstep(SEA_LEVEL + 0.35, 1.1, h));
      else if (h < 3.4) tmpColor.copy(grassC).lerp(rockC, smoothstep(2.6, 3.4, h));
      else tmpColor.copy(rockC).lerp(snowC, smoothstep(5.6, 6.6, h));
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    }
    planetGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    planetGeo.computeVertexNormals();
    const planetMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
    const planet = new THREE.Mesh(planetGeo, planetMat);
    planet.receiveShadow = true;
    planet.castShadow = true;
    scene.add(planet);
    planet.updateMatrixWorld(true);

    // Surface point + smooth normal computed from the same terrain formula the mesh is built from.
    // With the fine mesh above it matches the rendered ground to ~1 cm, so nothing floats or sinks.
    function getSurfacePoint(d) {
      const dn = d.clone().normalize();
      const point = dn.clone().multiplyScalar(PLANET_R + terrainHeight(dn));
      const ref = Math.abs(dn.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const t1 = new THREE.Vector3().crossVectors(ref, dn).normalize();
      const t2 = new THREE.Vector3().crossVectors(dn, t1).normalize();
      const e = 1.0 / PLANET_R;
      const d1 = dn.clone().addScaledVector(t1, e).normalize();
      const d2 = dn.clone().addScaledVector(t2, e).normalize();
      const p1 = d1.multiplyScalar(PLANET_R + terrainHeight(d1));
      const p2 = d2.multiplyScalar(PLANET_R + terrainHeight(d2));
      const normal = new THREE.Vector3().crossVectors(p1.sub(point), p2.sub(point)).normalize();
      if (normal.dot(dn) < 0) normal.negate();
      return { point, normal };
    }

    // ---------- Sea: a translucent sphere at sea level — land pokes above it, low areas sit under it ----------
    const seaMat = new THREE.MeshToonMaterial({ color: "#4f86a0", gradientMap, transparent: true, opacity: 0.82 });
    const sea = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R + SEA_LEVEL, 160, 110), seaMat);
    scene.add(sea);

    // ---------- Clouds: small fluffy low-poly clusters drifting around the planet ----------
    const cloudMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
    const clouds = [];
    let cloudSeed = 7;
    function cloudRand() {
      cloudSeed = (cloudSeed * 9301 + 49297) % 233280;
      return cloudSeed / 233280;
    }
    for (let i = 0; i < 16; i++) {
      const axis = new THREE.Vector3(cloudRand() * 2 - 1, cloudRand() * 2 - 1, cloudRand() * 2 - 1).normalize();
      const startDir = new THREE.Vector3(cloudRand() * 2 - 1, cloudRand() * 2 - 1, cloudRand() * 2 - 1).normalize();
      const altitude = PLANET_R * (0.22 + cloudRand() * 0.16);
      const group = new THREE.Group();
      const puffCount = 3 + Math.floor(cloudRand() * 3);
      for (let p = 0; p < puffCount; p++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1.1 + cloudRand() * 0.9, 8, 6), cloudMat);
        puff.position.set((cloudRand() - 0.5) * 3.2, (cloudRand() - 0.5) * 0.6, (cloudRand() - 0.5) * 1.6);
        puff.scale.y = 0.6;
        group.add(puff);
      }
      scene.add(group);
      clouds.push({ group, axis, startDir, altitude, speed: 0.015 + cloudRand() * 0.02 });
    }

    // ---------- Deterministic PRNG (so reloading gives the same layout) ----------
    let seed = 1;
    function rand() {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    }
    // uniformly random direction on the sphere
    function randomDir() {
      let v;
      do {
        v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      } while (v.lengthSq() < 0.01);
      return v.normalize();
    }
    // orient an object so its local +Y points along `normal`, with a random spin
    // around that axis for natural variety
    function orientToSurface(obj, normal, spin) {
      obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      obj.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));
    }

    // ---------- Obstacles: real collision on the sphere, using angular distance ----------
    // instead of flat XZ distance (the sphere equivalent of the old system)
    const obstacles = []; // { dir: Vector3, r: angular radius in radians }
    const CHAR_ANGULAR_R = 0.35 / PLANET_R;
    function isBlocked(testDir) {
      for (let i = 0; i < obstacles.length; i++) {
        if (testDir.angleTo(obstacles[i].dir) < obstacles[i].r + CHAR_ANGULAR_R) return true;
      }
      return false;
    }

    // ---------- Decorative trees/rocks/bushes — grounded on the REAL mesh surface, all solid ----------
    const trunkMat = new THREE.MeshToonMaterial({ color: PALETTE.trunk, gradientMap });
    const foliageMat = new THREE.MeshToonMaterial({ color: PALETTE.foliage, gradientMap });
    const rockMat = new THREE.MeshToonMaterial({ color: PALETTE.rock, gradientMap });
    const bushMat = new THREE.MeshToonMaterial({ color: "#5f7a4f", gradientMap });
    // ---------- Posizione dei villaggi (decisa prima della vegetazione, cosi' gli alberi non li bloccano) ----------
    const VILLAGES = [];
    {
      const cands = [];
      const N = 160;
      for (let i = 0; i < N; i++) {
        const y = 1 - (2 * (i + 0.5)) / N, rr = Math.sqrt(1 - y * y), th = i * 2.399963;
        cands.push(new THREE.Vector3(Math.cos(th) * rr, y, Math.sin(th) * rr));
      }
      const spawn0 = new THREE.Vector3(0, 1, 0);
      cands.sort((a, b) => a.angleTo(spawn0) - b.angleTo(spawn0));
      for (const c of cands) {
        if (VILLAGES.length >= 4) break;
        if (VILLAGES.some((v) => v.angleTo(c) < 0.95)) continue;
        let ok = true;
        const ref = Math.abs(c.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const t1 = new THREE.Vector3().crossVectors(ref, c).normalize();
        const t2 = new THREE.Vector3().crossVectors(c, t1).normalize();
        for (let k = -1; k < 8 && ok; k++) {
          const q = k < 0 ? c.clone() : c.clone().addScaledVector(t1, Math.cos((k / 8) * 6.283) * 0.36).addScaledVector(t2, Math.sin((k / 8) * 6.283) * 0.36).normalize();
          const h = terrainHeight(q);
          if (h < SEA_LEVEL + 0.7 || h > 3.2) ok = false;
        }
        if (ok) VILLAGES.push(c.clone());
      }
    }
    const nearVillage = (d) => VILLAGES.some((v) => v.angleTo(d) < 0.5);
    const decor = { tree: [], bush: [], rock: [] };
    for (let i = 0; i < 520; i++) {
      const d = randomDir();
      const h = terrainHeight(d);
      if (h < SEA_LEVEL + 0.05) continue; // keep the beaches clear
      if (nearVillage(d)) continue;
      const surf = getSurfacePoint(d);
      if (h < 4.2 && (h < 2.6 || rand() < 0.55)) {
        // tree
        const scale = 2.5 + rand() * 1.7;
        const group = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.85, 6), trunkMat);
        trunk.position.y = 0.42;
        trunk.castShadow = true;
        group.add(trunk);
        const foliage = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.3, 7), foliageMat);
        foliage.position.y = 1.15;
        foliage.castShadow = true;
        group.add(foliage);
        group.position.copy(surf.point);
        group.scale.setScalar(scale);
        orientToSurface(group, surf.normal, rand() * Math.PI * 2);
        scene.add(group);
        decor.tree.push({ obj: group, pos: surf.point.clone(), quat: group.quaternion.clone(), scale: 0.8 + ((scale - 2.5) / 1.7) * 0.45 });
        obstacles.push({ dir: d.clone(), r: (0.32 * scale) / PLANET_R });
      } else if (h < 3.4) {
        // bush (rounded shrub, smaller than trees, tucked in the same grass/rock transition band)
        const scale = 0.5 + rand() * 0.6;
        const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), bushMat);
        bush.position.copy(surf.point).addScaledVector(surf.normal, 0.28 * scale);
        bush.scale.set(scale, scale * 0.8, scale);
        bush.castShadow = true;
        orientToSurface(bush, surf.normal, rand() * Math.PI * 2);
        scene.add(bush);
        decor.bush.push({ obj: bush, pos: surf.point.clone(), quat: bush.quaternion.clone(), scale: 0.6 + ((scale - 0.5) / 0.6) * 0.5 });
        obstacles.push({ dir: d.clone(), r: (0.4 * scale) / PLANET_R });
      } else {
        // rock
        const scale = 0.35 + rand() * 0.4;
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), rockMat);
        rock.position.copy(surf.point).addScaledVector(surf.normal, 0.15 * scale);
        rock.scale.set(scale, scale * 0.8, scale);
        rock.castShadow = true;
        orientToSurface(rock, surf.normal, rand() * Math.PI * 2);
        scene.add(rock);
        decor.rock.push({ obj: rock, pos: surf.point.clone(), quat: rock.quaternion.clone(), scale: scale * 0.9 });
        obstacles.push({ dir: d.clone(), r: (0.42 * scale) / PLANET_R });
      }
    }

    // ---------- Quality fallback: if the real models make it too slow, go back to the light stand-ins ----------
    const quality = {
      downgraded: false,
      frameTimes: [],
      groups: [],
      register(proc, real) {
        this.groups.push({ proc, real });
      },
      sample(dt, elapsed) {
        if (this.downgraded) return;
        this.frameTimes.push(dt);
        if (this.frameTimes.length > 60) this.frameTimes.shift();
        if (elapsed < 5 || this.frameTimes.length < 60) return;
        const fps = 1 / (this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length);
        if (fps < 24) {
          this.downgraded = true;
          this.groups.forEach(({ proc, real }) => {
            proc.forEach((o) => (o.visible = true));
            real.forEach((o) => (o.visible = false));
          });
        }
      },
    };

    // ---------- Real models (trees, rocks, bushes) swapped in once loaded; stand-ins stay as fallback ----------
    function swapInReal(kind, paths) {
      Promise.all(paths.map((pth) => loadModelT(pth))).then((models) => {
        const variants = models.filter(Boolean);
        if (variants.length === 0 || decor[kind].length === 0) return;
        const realMeshes = [];
        variants.forEach((gltf, vIdx) => {
          const placements = decor[kind].filter((_, i) => i % variants.length === vIdx);
          buildInstanced(extractInstanceSources(gltf), placements).forEach((im) => {
            scene.add(im);
            realMeshes.push(im);
          });
        });
        const procObjs = decor[kind].map((e) => e.obj);
        procObjs.forEach((o) => (o.visible = false));
        quality.register(procObjs, realMeshes);
      });
    }
    swapInReal("tree", ["/models/nature/CommonTree_2.gltf", "/models/nature/Pine_1.gltf"]);
    swapInReal("rock", ["/models/nature/Rock_Medium_1.gltf", "/models/nature/Rock_Medium_3.gltf"]);
    swapInReal("bush", ["/models/nature/Bush_Common.gltf"]);

    // ---------- Ambient wildlife ----------
    // birds: orbit the planet at a fixed altitude around a random fixed axis —
    // the sphere equivalent of "circle overhead", correct at any altitude
    const birdMat = new THREE.MeshToonMaterial({ color: "#f4f1ea", gradientMap });
    const birds = [];
    for (let i = 0; i < 8; i++) {
      const axis = randomDir();
      const startDir = randomDir();
      const altitude = PLANET_R * (0.1 + rand() * 0.08);
      const g = new THREE.Group();
      const body = mesh(new THREE.ConeGeometry(0.09, 0.4, 6), birdMat, 0, 0, 0);
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const wingL = mesh(new THREE.BoxGeometry(0.42, 0.015, 0.15), birdMat, -0.23, 0, 0);
      const wingR = mesh(new THREE.BoxGeometry(0.42, 0.015, 0.15), birdMat, 0.23, 0, 0);
      g.add(wingL, wingR);
      scene.add(g);
      birds.push({ g, wingL, wingR, axis, startDir, altitude, speed: 0.25 + rand() * 0.2, flapPhase: rand() * 10 });
    }

    // fish: swim in small circles around a point that's confirmed underwater
    const fishMat = new THREE.MeshToonMaterial({ color: "#6fb0d8", gradientMap });
    const fish = [];
    let fishAttempts = 0;
    while (fish.length < 10 && fishAttempts < 2000) {
      fishAttempts++;
      const d = randomDir();
      if (terrainHeight(d) > SEA_LEVEL - 0.2) continue; // needs to be well underwater
      const g = new THREE.Group();
      const body = mesh(new THREE.ConeGeometry(0.11, 0.4, 6), fishMat, 0, 0, 0);
      body.rotation.x = Math.PI / 2;
      g.add(body);
      const tail = mesh(new THREE.ConeGeometry(0.1, 0.16, 4), fishMat, 0, 0, -0.24);
      tail.rotation.x = Math.PI / 2;
      g.add(tail);
      scene.add(g);
      fish.push({ g, center: d, angle: rand() * Math.PI * 2, radius: 0.02 + rand() * 0.02, speed: 0.3 + rand() * 0.3 });
    }

    // crabs: scuttle around a home point on the beach band, tangent to the surface
    const crabMat = new THREE.MeshToonMaterial({ color: "#e2543a", gradientMap });
    const crabs = [];
    let crabAttempts = 0;
    while (crabs.length < 6 && crabAttempts < 2000) {
      crabAttempts++;
      const d = randomDir();
      const h = terrainHeight(d);
      if (h < SEA_LEVEL - 0.05 || h > SEA_LEVEL + 0.15) continue; // beach band only
      const g = new THREE.Group();
      const body = mesh(new THREE.SphereGeometry(0.17, 10, 8), crabMat, 0, 0.1, 0);
      body.scale.set(1, 0.55, 0.8);
      g.add(body);
      [-1, 1].forEach((s) => {
        const claw = mesh(new THREE.SphereGeometry(0.075, 8, 6), crabMat, s * 0.22, 0.13, 0.11);
        claw.scale.set(1.3, 0.8, 0.9);
        g.add(claw);
      });
      scene.add(g);
      crabs.push({ g, homeDir: d.clone(), dir: d.clone(), targetDir: d.clone(), pauseUntil: 0, phase: rand() * 10 });
    }

    // ---------- Promontori: tall jagged rock formations, solid landmarks for orientation ----------
    function buildPromontorio(d) {
      const surf = getSurfacePoint(d);
      const g = new THREE.Group();
      const blocks = 4;
      for (let i = 0; i < blocks; i++) {
        const s = 1.7 - i * 0.28;
        const block = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rockMat);
        block.position.set((rand() - 0.5) * 0.5, i * 1.15 + 0.9, (rand() - 0.5) * 0.5);
        block.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
        block.castShadow = true;
        g.add(block);
      }
      g.position.copy(surf.point);
      orientToSurface(g, surf.normal, rand() * Math.PI * 2);
      scene.add(g);
      obstacles.push({ dir: d.clone(), r: 1.7 / PLANET_R });
    }
    [
      new THREE.Vector3(0.8, 0.3, -0.4),
      new THREE.Vector3(-0.6, 0.4, 0.7),
      new THREE.Vector3(0.2, -0.3, 0.9),
      new THREE.Vector3(-0.9, -0.2, -0.3),
      new THREE.Vector3(0.15, 0.55, -0.75),
    ].forEach((v) => {
      const d = v.clone().normalize();
      if (terrainHeight(d) > SEA_LEVEL + 0.15) buildPromontorio(d);
    });

    // ---------- A small village (huts + a road connecting it to the spawn point) ----------
    function findVillageSpot() {
      const candidates = [
        new THREE.Vector3(0.35, 0.85, 0.25),
        new THREE.Vector3(0.5, 0.7, -0.3),
        new THREE.Vector3(-0.4, 0.8, 0.3),
        new THREE.Vector3(0.2, 0.6, 0.7),
      ];
      for (const c of candidates) {
        const d = c.clone().normalize();
        const h = terrainHeight(d);
        if (h > SEA_LEVEL + 0.2 && h < 1.4) return d;
      }
      return new THREE.Vector3(0.35, 0.85, 0.25).normalize();
    }
    const villageCenter = VILLAGES[0] ? VILLAGES[0].clone() : findVillageSpot();

    // ---------- Buildings ----------
    // Three building types. Footprints are those of the real Pirate-kit houses (scaled by HS so the
    // doors fit the character); the procedural stand-ins use the SAME footprints, so collisions, the
    // ground foundation and the door position are identical whether the real model or the stand-in
    // is shown. The door is always on the local +Z face, at x = 0.
    const HS = 0.94;
    const BUILDING_TYPES = [
      { name: "long", x0: -4.6, x1: 4.65, z0: -2.3, z1: 2.3, h: 4.4, roofH: 2.2, roomKey: "large" },
      { name: "tower", x0: -1.7, x1: 1.7, z0: -2.05, z1: 1.3, h: 6.6, roofH: 2.6, roomKey: "small" },
      { name: "ship", x0: -2.8, x1: 2.8, z0: -1.57, z1: 1.57, h: 5.2, roofH: 1.8, roomKey: "medium" },
    ].map((t) => ({ ...t, x0: t.x0 * HS, x1: t.x1 * HS, z0: t.z0 * HS, z1: t.z1 * HS, h: t.h * HS, roofH: t.roofH * HS }));
    const DOOR_H = 2.0;
    const wallMats = [
      new THREE.MeshToonMaterial({ color: "#8a6a4a", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#7a5c40", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#9a7a58", gradientMap }),
    ];
    const roofMats = [
      new THREE.MeshToonMaterial({ color: "#5a3f33", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#6b3a34", gradientMap }),
    ];
    const doorMat = new THREE.MeshToonMaterial({ color: "#3a2a1e", gradientMap });
    const windowMat = new THREE.MeshToonMaterial({ color: "#5a8fc4", gradientMap });
    const foundationMat = new THREE.MeshToonMaterial({ color: "#77726a", gradientMap });
    function makeGableRoof(w, d, roofH) {
      const shape = new THREE.Shape();
      shape.moveTo(-d / 2 - 0.25, 0);
      shape.lineTo(d / 2 + 0.25, 0);
      shape.lineTo(0, roofH);
      shape.lineTo(-d / 2 - 0.25, 0);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: w + 0.5, bevelEnabled: false });
      geo.translate(0, 0, -(w + 0.5) / 2);
      geo.rotateY(Math.PI / 2); // ridge runs along the building's long (x) axis
      return geo;
    }
    const buildings = []; // { g, standIn, foundation, T, typeIdx, doorWorld, exitDir, roomKey, pos, quat }

    // Looks at the ground under the footprint (relative to a plane tangent at the center). Returns
    // null if the site is too steep or too close to the water; otherwise how high the floor must sit
    // and how low the foundation must reach so no gap is ever visible, even on a slope.
    function planBuilding(d, facingTangent, T, maxSlope) {
      const surf = getSurfacePoint(d);
      if (terrainHeight(d) < SEA_LEVEL + 0.5) return null;
      const zAxis = facingTangent.clone().addScaledVector(surf.normal, -facingTangent.dot(surf.normal)).normalize();
      const xAxis = new THREE.Vector3().crossVectors(surf.normal, zAxis).normalize();
      const xs = [T.x0 - 0.5, (T.x0 + T.x1) / 2, T.x1 + 0.5];
      const zs = [T.z0 - 0.5, (T.z0 + T.z1) / 2, T.z1 + 0.5];
      let dmin = 0;
      let dmax = 0;
      for (const x of xs) {
        for (const z of zs) {
          const dd = surf.point.clone().addScaledVector(xAxis, x).addScaledVector(zAxis, z).normalize();
          const h = terrainHeight(dd);
          if (h < SEA_LEVEL + 0.3) return null;
          const q = dd.multiplyScalar(PLANET_R + h);
          const delta = q.sub(surf.point).dot(surf.normal);
          dmin = Math.min(dmin, delta);
          dmax = Math.max(dmax, delta);
        }
      }
      if (dmax - dmin > maxSlope) return null;
      return { surf, zAxis, lift: Math.max(0, dmax), dmin };
    }

    function placeBuilding(d, facingTangent, typeIdx, maxSlope) {
      const T = BUILDING_TYPES[typeIdx];
      const plan = planBuilding(d, facingTangent, T, maxSlope);
      if (!plan) return null;
      const w = T.x1 - T.x0;
      const dp = T.z1 - T.z0;
      const cx = (T.x0 + T.x1) / 2;
      const cz = (T.z0 + T.z1) / 2;
      const g = new THREE.Group();

      // stand-in (shown when the real model isn't available)
      const standIn = new THREE.Group();
      const wallMat = wallMats[Math.floor(rand() * wallMats.length)];
      const roofMat = roofMats[Math.floor(rand() * roofMats.length)];
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, T.h, dp), wallMat);
      body.position.set(cx, T.h / 2, cz);
      body.castShadow = true;
      standIn.add(body);
      const roof = new THREE.Mesh(makeGableRoof(w, dp, T.roofH), roofMat);
      roof.position.set(cx, T.h, cz);
      roof.castShadow = true;
      standIn.add(roof);
      const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, DOOR_H, 0.1), doorMat);
      door.position.set(0, DOOR_H / 2, T.z1 + 0.04);
      standIn.add(door);
      const winCount = w > 6 ? 4 : 2;
      for (let i = 0; i < winCount; i++) {
        const wx = winCount === 2 ? (i === 0 ? -1 : 1) * Math.min(w * 0.3, 1.1) : [-0.38, -0.2, 0.2, 0.38][i] * w * (i % 3 === 0 ? 1 : 1.9) * 0.5;
        const win = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.8, 0.08), windowMat);
        win.position.set(wx, T.h * 0.62, T.z1 + 0.04);
        standIn.add(win);
      }
      g.add(standIn);

      // foundation: reaches down to the lowest ground point under the footprint
      const fh = plan.lift - plan.dmin + 0.7;
      const foundation = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, fh, dp + 0.5), foundationMat);
      foundation.position.set(cx, -fh / 2 + 0.04, cz);
      foundation.receiveShadow = true;
      g.add(foundation);

      g.position.copy(plan.surf.point).addScaledVector(plan.surf.normal, plan.lift);
      g.up.copy(plan.surf.normal);
      g.lookAt(g.position.clone().add(plan.zAxis));
      scene.add(g);
      g.updateMatrixWorld(true);

      // collision: several circles along the long axis
      const r = dp / 2 + 0.25;
      const n = Math.max(1, Math.round(w / dp));
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? cx : T.x0 + r + ((w - 2 * r) * i) / (n - 1);
        const wp = g.localToWorld(new THREE.Vector3(x, 0, cz));
        obstacles.push({ dir: wp.normalize(), r: r / PLANET_R });
      }
      const doorWorld = g.localToWorld(new THREE.Vector3(0, 1.0, T.z1 + 0.3));
      const exitDir = g.localToWorld(new THREE.Vector3(0, 0, T.z1 + 1.9)).normalize();
      const rec = { g, standIn, foundation, T, typeIdx, doorWorld, exitDir, roomKey: T.roomKey, pos: g.position.clone(), quat: g.quaternion.clone() };
      buildings.push(rec);
      return rec;
    }

    // villaggi: un anello di case rivolte verso la piazza, con pozzo, lampioni e stradine
    const wellStone = new THREE.MeshToonMaterial({ color: "#8d8a84", gradientMap });
    const lampGlow = new THREE.MeshBasicMaterial({ color: "#ffd98a" });
    const lampPost = new THREE.MeshToonMaterial({ color: "#3b3a3c", gradientMap });
    function orientUp(obj, surf) {
      obj.position.copy(surf.point);
      obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surf.normal);
    }
    function addWell(dir) {
      const surf = getSurfacePoint(dir);
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.9, 12), wellStone); ring.position.y = 0.45; ring.castShadow = true; g.add(ring);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.05, 12), new THREE.MeshBasicMaterial({ color: "#5aa6c8" })); water.position.y = 0.88; g.add(water);
      [-1, 1].forEach((sd) => { const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.7, 0.12), woodPostMat); post.position.set(sd * 0.95, 1.2, 0); g.add(post); });
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.8, 4), roofMats[0]); roof.position.y = 2.3; roof.rotation.y = Math.PI / 4; roof.castShadow = true; g.add(roof);
      orientUp(g, surf); scene.add(g);
      obstacles.push({ dir: dir.clone(), r: 1.5 / PLANET_R });
    }
    function addLamp(dir) {
      const surf = getSurfacePoint(dir);
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 2.4, 6), lampPost); pole.position.y = 1.2; g.add(pole);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), lampGlow); lamp.position.y = 2.5; g.add(lamp);
      orientUp(g, surf); scene.add(g);
      obstacles.push({ dir: dir.clone(), r: 0.3 / PLANET_R });
    }
    const woodPostMat = new THREE.MeshToonMaterial({ color: "#6b4a2e", gradientMap });
    const VILLAGE_ORDERS = [[0, 2, 1, 2, 1, 0, 2], [1, 0, 2, 0, 1, 2], [2, 1, 0, 1, 2, 0], [0, 1, 2, 1, 0]];
    VILLAGES.forEach((vc, vi) => {
      const order = VILLAGE_ORDERS[vi % VILLAGE_ORDERS.length];
      const ta = new THREE.Vector3(1, 0, 0).addScaledVector(vc, -vc.x).normalize();
      const tb = new THREE.Vector3().crossVectors(vc, ta).normalize();
      const ringAt = (angle, dist) => vc.clone().addScaledVector(ta, Math.cos(angle) * dist).addScaledVector(tb, Math.sin(angle) * dist).normalize();
      addWell(vc);
      for (let i = 0; i < order.length; i++) {
        const angle = (i / order.length) * Math.PI * 2 + 0.3 + vi;
        const hutDir = ringAt(angle, 17 / PLANET_R);
        const T = BUILDING_TYPES[order[i]];
        const bR = Math.hypot((T.x1 - T.x0) / 2, (T.z1 - T.z0) / 2) + 1;
        let clear = true;
        for (let k = 0; k < obstacles.length; k++) {
          if (hutDir.angleTo(obstacles[k].dir) < obstacles[k].r + bR / PLANET_R) { clear = false; break; }
        }
        if (clear && placeBuilding(hutDir, vc.clone().sub(hutDir), order[i], 1.8)) {
          buildRoad(vc, ringAt(angle, 11 / PLANET_R), 5);
        }
        const lampDir = ringAt(angle + Math.PI / order.length, 12 / PLANET_R);
        if (terrainHeight(lampDir) > SEA_LEVEL + 0.5) addLamp(lampDir);
      }
    });

    // the rest of the town, spread over the dry land
    const SCATTERED_BUILDING_COUNT = 12;
    let scatteredBuilt = 0;
    let scatterAttempts = 0;
    while (scatteredBuilt < SCATTERED_BUILDING_COUNT && scatterAttempts < 5000) {
      scatterAttempts++;
      const d = randomDir();
      const h = terrainHeight(d);
      if (h < SEA_LEVEL + 0.6 || h > 1.5) continue;
      const typeIdx = Math.floor(rand() * BUILDING_TYPES.length);
      const T = BUILDING_TYPES[typeIdx];
      const bR = Math.hypot((T.x1 - T.x0) / 2, (T.z1 - T.z0) / 2) + 3;
      let tooClose = false;
      for (let i = 0; i < obstacles.length; i++) {
        if (d.angleTo(obstacles[i].dir) < obstacles[i].r + bR / PLANET_R) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      if (placeBuilding(d, randomDir(), typeIdx, 0.9)) scatteredBuilt++;
    }

    // ---------- Real houses (Pirate kit), swapped in once loaded; the stand-ins stay as fallback ----------
    // The foundation under each house stays visible in both cases.
    const HOUSE_PATHS = ["/models/buildings/Environment_House1.gltf", "/models/buildings/Environment_House2.gltf", "/models/buildings/Environment_House3.gltf"];
    Promise.all(HOUSE_PATHS.map((pth) => loadModelT(pth))).then((models) => {
      const realMeshes = [];
      const standIns = [];
      models.forEach((gltf, typeIdx) => {
        if (!gltf) return;
        const list = buildings.filter((b) => b.typeIdx === typeIdx);
        if (list.length === 0) return;
        buildInstanced(extractInstanceSources(gltf), list.map((b) => ({ pos: b.pos, quat: b.quat, scale: HS }))).forEach((im) => {
          scene.add(im);
          realMeshes.push(im);
        });
        list.forEach((b) => standIns.push(b.standIn));
      });
      if (realMeshes.length === 0) return;
      standIns.forEach((o) => (o.visible = false));
      quality.register(standIns, realMeshes);
    });

    // road: a chain of flat tiles following the great-circle arc from spawn to the village
    function buildRoad(dirA, dirB, steps) {
      const roadMat = new THREE.MeshToonMaterial({ color: "#a89a7c", gradientMap });
      const a = dirA.clone().normalize();
      const b = dirB.clone().normalize();
      const angleTotal = a.angleTo(b);
      if (angleTotal < 0.005) return;
      const sinTotal = Math.sin(angleTotal);
      const segLen = (angleTotal * PLANET_R) / steps;
      function slerpDir(t) {
        const wa = Math.sin((1 - t) * angleTotal) / sinTotal;
        const wb = Math.sin(t * angleTotal) / sinTotal;
        return new THREE.Vector3().addScaledVector(a, wa).addScaledVector(b, wb).normalize();
      }
      for (let i = 0; i <= steps; i++) {
        const tt = i / steps;
        const d = slerpDir(tt);
        if (terrainHeight(d) < SEA_LEVEL + 0.25) continue;
        const dNext = slerpDir(Math.min(1, tt + 0.01));
        const surf = getSurfacePoint(d);
        const rawTangent = dNext.clone().sub(d);
        const tangent = rawTangent.addScaledVector(surf.normal, -rawTangent.dot(surf.normal)).normalize();
        const tile = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, segLen * 1.4), roadMat);
        tile.receiveShadow = true;
        tile.position.copy(surf.point).addScaledVector(surf.normal, 0.03);
        tile.up.copy(surf.normal);
        tile.lookAt(tile.position.clone().add(tangent));
        scene.add(tile);
      }
    }
    buildRoad(findLandSpawn(), villageCenter, Math.max(6, Math.round((findLandSpawn().angleTo(villageCenter) * PLANET_R) / 1.1)));
    for (let i = 0; i + 1 < VILLAGES.length; i++) buildRoad(VILLAGES[i], VILLAGES[i + 1], Math.round((VILLAGES[i].angleTo(VILLAGES[i + 1]) * PLANET_R) / 1.1));

    // ---------- Character (low-poly humanoid, joint-based rig) ----------
    const jacketMat = new THREE.MeshToonMaterial({ color: "#c1503f", gradientMap });
    const pantsMat = new THREE.MeshToonMaterial({ color: "#46392c", gradientMap });
    const skinMat = new THREE.MeshToonMaterial({ color: "#e3b48a", gradientMap });
    const hairMat = new THREE.MeshToonMaterial({ color: "#3a2f28", gradientMap });
    const shoeMat = new THREE.MeshToonMaterial({ color: "#2e2a26", gradientMap });
    const packMat = new THREE.MeshToonMaterial({ color: "#6b4c3a", gradientMap });
    const eyeWhiteMat = new THREE.MeshToonMaterial({ color: "#faf6ee", gradientMap });
    const pupilMat = new THREE.MeshToonMaterial({ color: "#241d18", gradientMap });

    function mesh(geo, mat, x, y, z) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    }

    // the character group's LOCAL +Y is "up relative to the character" — we
    // orient the whole group to the planet's surface normal every frame, so
    // everything built here in local space just works regardless of where on
    // the planet the character is standing
    const character = new THREE.Group();

    const torsoGroup = new THREE.Group();
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.36, 16), jacketMat, 0, 0.62, 0));
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.27, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), jacketMat, 0, 0.8, 0));
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.08, 16), shoeMat, 0, 0.45, 0));
    torsoGroup.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 10), skinMat, 0, 0.86, 0));
    torsoGroup.add(mesh(new THREE.BoxGeometry(0.3, 0.34, 0.18), packMat, 0, 0.65, -0.25));
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), jacketMat, -0.31, 0.78, 0));
    torsoGroup.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), jacketMat, 0.31, 0.78, 0));
    character.add(torsoGroup);

    const headProfile = [
      [0.08, -0.33],
      [0.16, -0.24],
      [0.22, -0.13],
      [0.26, -0.01],
      [0.27, 0.09],
      [0.24, 0.19],
      [0.16, 0.28],
      [0.06, 0.33],
    ];
    function headRadiusAt(y) {
      for (let i = 0; i < headProfile.length - 1; i++) {
        const [ra, ya] = headProfile[i];
        const [rb, yb] = headProfile[i + 1];
        if (y >= ya && y <= yb) {
          const t = (y - ya) / (yb - ya);
          return ra + (rb - ra) * t;
        }
      }
      return headProfile[headProfile.length - 1][0];
    }
    const headGeo = new THREE.LatheGeometry(
      headProfile.map(([r, y]) => new THREE.Vector2(r, y)),
      24
    );
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.14, 0);
    headGroup.add(mesh(headGeo, skinMat, 0, 0, 0));
    headGroup.add(mesh(new THREE.SphereGeometry(0.075, 10, 8), skinMat, 0, -0.33, 0));
    headGroup.add(mesh(new THREE.SphereGeometry(0.055, 8, 8), skinMat, 0, 0.335, 0));
    const hairR = 0.36;
    const domeThetaEnd = Math.PI * 0.34;
    const sideThetaEnd = Math.PI * 0.433;
    const backThetaEnd = Math.PI * 0.56;
    headGroup.add(mesh(new THREE.SphereGeometry(hairR, 20, 10, 0, Math.PI * 2, 0, domeThetaEnd), hairMat, 0, 0, 0));
    const deg = Math.PI / 180;
    headGroup.add(mesh(new THREE.SphereGeometry(hairR, 12, 6, 145 * deg, 45 * deg, domeThetaEnd, sideThetaEnd - domeThetaEnd), hairMat, 0, 0, 0));
    headGroup.add(mesh(new THREE.SphereGeometry(hairR, 12, 6, -10 * deg, 45 * deg, domeThetaEnd, sideThetaEnd - domeThetaEnd), hairMat, 0, 0, 0));
    headGroup.add(mesh(new THREE.SphereGeometry(hairR, 16, 8, 190 * deg, 160 * deg, domeThetaEnd, backThetaEnd - domeThetaEnd), hairMat, 0, 0, 0));
    const eyeY = 0.04;
    const eyeZ = headRadiusAt(eyeY) - 0.02;
    [-1, 1].forEach((side) => {
      const white = mesh(new THREE.SphereGeometry(0.055, 12, 10), eyeWhiteMat, side * 0.115, eyeY, eyeZ);
      white.scale.set(1.25, 0.8, 0.55);
      headGroup.add(white);
      headGroup.add(mesh(new THREE.SphereGeometry(0.026, 8, 8), pupilMat, side * 0.125, eyeY - 0.005, eyeZ + 0.025));
      const brow = mesh(new THREE.BoxGeometry(0.1, 0.02, 0.02), hairMat, side * 0.115, eyeY + 0.09, eyeZ + 0.03);
      brow.rotation.z = -side * 0.15;
      headGroup.add(brow);
    });
    const noseY = -0.02;
    const nose = mesh(new THREE.ConeGeometry(0.032, 0.09, 8), skinMat, 0, noseY, headRadiusAt(noseY) - 0.01);
    nose.rotation.x = -Math.PI / 2;
    headGroup.add(nose);
    const mouthY = -0.15;
    headGroup.add(mesh(new THREE.BoxGeometry(0.08, 0.018, 0.015), pupilMat, 0, mouthY, headRadiusAt(mouthY) - 0.01));
    character.add(headGroup);

    function makeLeg(sideX) {
      const hip = new THREE.Group();
      hip.position.set(sideX, 0.5, 0);
      hip.add(mesh(new THREE.CylinderGeometry(0.11, 0.095, 0.36, 12), pantsMat, 0, -0.18, 0));
      hip.add(mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.1, 10), skinMat, 0, -0.4, 0));
      const shoeGroup = new THREE.Group();
      shoeGroup.position.set(0, -0.45, 0.035);
      shoeGroup.add(mesh(new THREE.BoxGeometry(0.13, 0.08, 0.18), shoeMat, 0, 0, -0.02));
      const toe = mesh(new THREE.SphereGeometry(0.065, 8, 6), shoeMat, 0, 0, 0.085);
      toe.scale.set(1, 0.8, 0.85);
      shoeGroup.add(toe);
      shoeGroup.add(mesh(new THREE.BoxGeometry(0.145, 0.03, 0.25), shoeMat, 0, -0.05, 0.015));
      shoeGroup.position.y += 0.05;
      hip.add(shoeGroup);
      character.add(hip);
      return hip;
    }
    const hipLeft = makeLeg(-0.13);
    const hipRight = makeLeg(0.13);

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
    scene.add(character);

    // Real character (Anne): ~1.81 m native with feet 0.18 below her origin; the group is scaled 1.15,
    // so this brings her to ~1.7 m in the world. The procedural rig stays as fallback.
    let mixer = null;
    let idleAction = null;
    let walkAction = null;
    let jumpAction = null;
    let currentAnim = null;
    function setAnimAction(action, fade = 0.2) {
      if (!action || currentAnim === action) return;
      action.reset().fadeIn(fade).play();
      if (currentAnim) currentAnim.fadeOut(fade);
      currentAnim = action;
    }
    function syncRealAnim(moving) {
      if (!(idleAction || walkAction || jumpAction)) return;
      if (waveAction && performance.now() < waveUntil && grounded && !moving) { setAnimAction(waveAction); return; }
      if (!grounded) setAnimAction(jumpAction ?? walkAction ?? idleAction);
      else if (moving) setAnimAction(walkAction ?? idleAction);
      else setAnimAction(idleAction);
    }
    let anneGltf = null;
    let waveAction = null;
    let waveUntil = 0;
    const findWaveClip = (anims) => anims.find((c) => /wave/i.test(c.name)) ?? anims.find((c) => /^yes$/i.test(c.name));
    loadModelT("/models/characters/Characters_Anne.gltf").then((gltf) => {
      if (!gltf) return;
      anneGltf = gltf;
      const model = gltf.scene;
      const sc = 1.7 / (1.81 * 1.15);
      model.scale.setScalar(sc);
      model.position.y = 0.18 * sc;
      model.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      character.add(model);
      const procParts = [torsoGroup, headGroup, hipLeft, hipRight, shoulderLeft, shoulderRight];
      procParts.forEach((o) => (o.visible = false));
      quality.register(procParts, [model]);
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(model);
        const find = (n) => gltf.animations.find((c) => c.name.toLowerCase() === n.toLowerCase());
        const idle = find("Idle") ?? gltf.animations[0];
        const walk = find("Walk");
        const jump = find("Jump_Idle") ?? find("Jump");
        idleAction = idle ? mixer.clipAction(idle) : null;
        walkAction = walk ? mixer.clipAction(walk) : null;
        jumpAction = jump ? mixer.clipAction(jump) : null;
        const wv = findWaveClip(gltf.animations);
        waveAction = wv ? mixer.clipAction(wv) : null;
        setAnimAction(idleAction, 0);
      }
    });

    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
    const blob = new THREE.Mesh(new THREE.CircleGeometry(0.38, 16), blobMat);
    scene.add(blob);

    // ================= Movement on the sphere =================
    // `charDir`: normalized direction from the planet's center to the character
    // (this IS "up" from the character's point of view). `facing`: a unit
    // vector tangent to the sphere at that point, representing which way the
    // character/camera face — re-projected onto the new tangent plane every
    // frame since "tangent" keeps changing as you walk.
    function findLandSpawn() {
      const candidates = [
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0.4, 1, 0.25),
        new THREE.Vector3(-0.4, 1, -0.25),
        new THREE.Vector3(0.6, 0.7, 0.5),
        new THREE.Vector3(-0.6, 0.7, -0.5),
        new THREE.Vector3(1, 0.25, 0),
        new THREE.Vector3(-1, 0.25, 0),
        new THREE.Vector3(0, 0.25, 1),
        new THREE.Vector3(0, 0.25, -1),
      ];
      for (const c of candidates) {
        const d = c.clone().normalize();
        if (terrainHeight(d) > SEA_LEVEL + 0.15) return d;
      }
      return new THREE.Vector3(0, 1, 0);
    }
    // ---------- Interiors ----------
    // Rooms are built at the planet's center (inside the solid ground, so invisible from outside),
    // wrapped in a dark dome so nothing else shows through. Cutaway view: no ceiling and no front
    // wall, with a fixed camera, so the camera never ends up inside a wall.
    const ROOM_SPECS = { small: { W: 5.0, D: 4.4, H: 3.0 }, medium: { W: 6.8, D: 5.8, H: 3.2 }, large: { W: 9.4, D: 8.0, H: 3.6 } };
    const stage = new THREE.Mesh(new THREE.SphereGeometry(45, 20, 14), new THREE.MeshBasicMaterial({ color: "#29262f", side: THREE.BackSide, fog: false }));
    stage.visible = false;
    scene.add(stage);
    const roomLight = new THREE.PointLight(0xffd9a8, 0, 28, 1.4);
    scene.add(roomLight);
    const rWall = new THREE.MeshToonMaterial({ color: "#b79c78", gradientMap });
    const rFloor = new THREE.MeshToonMaterial({ color: "#7a5a3a", gradientMap });
    const rWood = new THREE.MeshToonMaterial({ color: "#6b4a30", gradientMap });
    const rDark = new THREE.MeshToonMaterial({ color: "#3a2a1e", gradientMap });
    const rRug = new THREE.MeshToonMaterial({ color: "#8a3f38", gradientMap });
    const rCloth = new THREE.MeshToonMaterial({ color: "#c9c2a8", gradientMap });
    const rBlue = new THREE.MeshToonMaterial({ color: "#5a8fc4", gradientMap });
    const rGold = new THREE.MeshToonMaterial({ color: "#d4af37", gradientMap });
    const rooms = {};
    // Ogni tipo di casa ha il suo interno: grande = taverna, piccola (torre) = studio, media (nave) = cabina.
    const THEMES = {
      large: { wall: "#b08a5c", floor: "#6b4a2e", win: "#e8b86a" },
      small: { wall: "#8b93b5", floor: "#4f4866", win: "#9ec7e8" },
      medium: { wall: "#4f7f8c", floor: "#7a5a3a", win: "#bfe3f0" },
    };
    const rStone = new THREE.MeshToonMaterial({ color: "#6d6a68", gradientMap });
    const rFire = new THREE.MeshBasicMaterial({ color: "#ff9a3c" });
    const rGreen = new THREE.MeshToonMaterial({ color: "#4f8a5a", gradientMap });
    const rRed = new THREE.MeshToonMaterial({ color: "#b8483f", gradientMap });
    const rMap = new THREE.MeshToonMaterial({ color: "#e6d8a8", gradientMap });
    const rNavy = new THREE.MeshToonMaterial({ color: "#2f4a63", gradientMap });
    const rIron = new THREE.MeshToonMaterial({ color: "#4a4a50", gradientMap });
    Object.entries(ROOM_SPECS).forEach(([key, { W, D, H }]) => {
      const th = THEMES[key];
      const wallM = new THREE.MeshToonMaterial({ color: th.wall, gradientMap });
      const floorM = new THREE.MeshToonMaterial({ color: th.floor, gradientMap });
      const winM = new THREE.MeshBasicMaterial({ color: th.win });
      const g = new THREE.Group();
      g.visible = false;
      const add = (geo, mat, x, y, z) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        g.add(m);
        return m;
      };
      const box = (w, h, d, mat, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
      const cyl = (r, h, mat, x, y, z, seg = 12) => add(new THREE.CylinderGeometry(r, r, h, seg), mat, x, y, z);
      const colliders = [];
      const col = (x, z, r) => colliders.push({ x, z, r });
      const table = (tx, tz, r) => {
        cyl(r, 0.08, rWood, tx, 0.78, tz, 16);
        cyl(0.09, 0.75, rWood, tx, 0.38, tz, 8);
        col(tx, tz, r + 0.05);
      };
      const stool = (x, z) => { cyl(0.22, 0.45, rWood, x, 0.22, z, 10); col(x, z, 0.26); };
      const barrel = (x, z) => { cyl(0.38, 0.85, rWood, x, 0.42, z, 12); cyl(0.39, 0.06, rDark, x, 0.25, z, 12); cyl(0.39, 0.06, rDark, x, 0.62, z, 12); col(x, z, 0.42); };
      const chest = (x, z) => { box(0.9, 0.5, 0.55, rWood, x, 0.25, z); box(0.94, 0.08, 0.59, rGold, x, 0.52, z); col(x, z, 0.6); };

      // guscio comune: pavimento, pareti, porta d'uscita sul fondo
      box(W + 0.4, 0.3, D + 0.4, floorM, 0, -0.15, 0);
      box(W + 0.4, H, 0.2, wallM, 0, H / 2, -D / 2 - 0.1);
      box(0.2, H, D + 0.4, wallM, -W / 2 - 0.1, H / 2, 0);
      box(0.2, H, D + 0.4, wallM, W / 2 + 0.1, H / 2, 0);
      box(1.3, DOOR_H + 0.12, 0.12, rDark, 0, (DOOR_H + 0.12) / 2, -D / 2 + 0.02);
      box(1.0, DOOR_H, 0.14, rWood, 0, DOOR_H / 2, -D / 2 + 0.05);
      box(1.2, 0.03, 0.7, rRug, 0, 0.02, -D / 2 + 0.55);

      if (key === "large") {
        // TAVERNA: bancone, botti, camino, tavoli rotondi con sgabelli, tappeto lungo
        [-1, 1].forEach((sd) => box(0.06, 1.0, 1.3, winM, sd * (W / 2 - 0.02), H * 0.6, D * 0.25));
        box(1.6, 0.03, 4.6, rRug, 0, 0.02, 0.5);
        box(0.8, 1.05, 4.4, rWood, W / 2 - 1.1, 0.52, -0.2);
        box(0.95, 0.08, 4.55, rDark, W / 2 - 1.1, 1.08, -0.2);
        for (let i = 0; i < 4; i++) col(W / 2 - 1.1, -2.1 + i * 1.3, 0.7);
        [-1.7, -0.5, 0.7, 1.9].forEach((z, i) => { barrel(W / 2 - 0.5, z - 0.2 + (i % 2) * 0.1); });
        box(3.2, 0.1, 0.3, rWood, W / 2 - 0.3, 2.2, -0.2);
        [-1, 0, 1].forEach((o) => cyl(0.12, 0.3, rGold, W / 2 - 0.35, 2.4, -0.2 + o * 1.0, 8));
        // camino
        box(0.6, 1.7, 2.0, rStone, -W / 2 + 0.35, 0.85, -D * 0.12);
        box(0.12, 0.7, 1.1, rFire, -W / 2 + 0.68, 0.4, -D * 0.12);
        box(0.7, 0.15, 2.2, rDark, -W / 2 + 0.35, 1.75, -D * 0.12);
        col(-W / 2 + 0.5, -D * 0.12 - 0.6, 0.8); col(-W / 2 + 0.5, -D * 0.12 + 0.6, 0.8);
        // tavoli
        [[-2.2, 1.0], [-2.2, -1.4], [0.6, 2.2]].forEach(([tx, tz]) => {
          table(tx, tz, 0.75);
          [0, 2.1, 4.2].forEach((a) => stool(tx + Math.cos(a) * 1.1, tz + Math.sin(a) * 1.1));
        });
        // lanterne appese
        [[-2.2, 0], [1.2, 1.0]].forEach(([x, z]) => { cyl(0.02, 0.8, rDark, x, H - 0.4, z, 4); cyl(0.17, 0.3, rFire, x, H - 0.95, z, 8); });
      } else if (key === "small") {
        // STUDIO DEL TORRIONE: librerie, scrivania con mappamondo, telescopio, poltrona
        [-1, 1].forEach((sd) => box(0.06, 0.9, 0.9, winM, sd * (W / 2 - 0.02), H * 0.62, -D * 0.1));
        // librerie alte lungo la parete sinistra
        box(0.45, 2.5, 3.2, rWood, -W / 2 + 0.3, 1.25, 0.1);
        const bookMats = [rRed, rBlue, rGreen, rGold, rCloth, rRug];
        for (let row = 0; row < 4; row++) for (let i = 0; i < 6; i++) box(0.3, 0.38, 0.14, bookMats[(row * 3 + i) % 6], -W / 2 + 0.55, 0.45 + row * 0.6, -1.3 + i * 0.52);
        col(-W / 2 + 0.4, -1.0, 0.7); col(-W / 2 + 0.4, 0.1, 0.7); col(-W / 2 + 0.4, 1.2, 0.7);
        // scrivania + mappamondo + candela
        box(1.5, 0.08, 0.8, rWood, 0.9, 0.8, 0.9);
        box(0.08, 0.78, 0.7, rWood, 0.2, 0.39, 0.9); box(0.08, 0.78, 0.7, rWood, 1.6, 0.39, 0.9);
        add(new THREE.SphereGeometry(0.22, 12, 10), rBlue, 1.25, 1.1, 0.9);
        cyl(0.04, 0.2, rGold, 1.25, 0.9, 0.9, 6);
        cyl(0.04, 0.2, rCloth, 0.6, 0.94, 0.85, 6); box(0.05, 0.05, 0.05, rFire, 0.6, 1.07, 0.85);
        col(0.9, 0.9, 0.95);
        // poltrona
        box(0.8, 0.45, 0.8, rRed, 0.9, 0.22, 1.75); box(0.8, 0.7, 0.2, rRed, 0.9, 0.6, 2.0);
        col(0.9, 1.75, 0.55);
        // telescopio sul treppiede
        [0, 2.1, 4.2].forEach((a) => { const m = cyl(0.03, 1.2, rWood, 1.55 + Math.cos(a) * 0.2, 0.55, -0.9 + Math.sin(a) * 0.2, 5); m.rotation.z = Math.cos(a) * 0.2; m.rotation.x = Math.sin(a) * 0.2; });
        const tel = cyl(0.07, 1.3, rGold, 1.55, 1.4, -0.9, 8); tel.rotation.z = 0.9;
        col(1.55, -0.9, 0.4);
        // tappeto rotondo
        cyl(1.0, 0.03, rBlue, -0.3, 0.02, 0.4, 20);
        // letto piccolo nell'angolo
        box(0.95, 0.4, 1.9, rWood, -W / 2 + 1.2, 0.2, -D / 2 + 1.3); box(0.85, 0.16, 1.5, rCloth, -W / 2 + 1.2, 0.46, -D / 2 + 1.4);
        col(-W / 2 + 1.2, -D / 2 + 1.0, 0.75); col(-W / 2 + 1.2, -D / 2 + 1.8, 0.75);
      } else {
        // CABINA DEL CAPITANO: oblò, tavolo con carta nautica, amache, timone, barili e bauli
        [-1, 1].forEach((sd) => [-1.3, 0.9].forEach((z) => { const o = cyl(0.42, 0.08, rGold, sd * (W / 2 - 0.02), H * 0.6, z, 16); o.rotation.z = Math.PI / 2; const o2 = cyl(0.34, 0.1, winM, sd * (W / 2 - 0.03), H * 0.6, z, 16); o2.rotation.z = Math.PI / 2; }));
        // tavolo con carta nautica
        box(2.1, 0.1, 1.2, rWood, 0.3, 0.8, 0.5);
        box(0.1, 0.78, 0.1, rWood, -0.65, 0.39, 0.1); box(0.1, 0.78, 0.1, rWood, 1.25, 0.39, 0.1);
        box(0.1, 0.78, 0.1, rWood, -0.65, 0.39, 0.9); box(0.1, 0.78, 0.1, rWood, 1.25, 0.39, 0.9);
        box(1.5, 0.02, 0.9, rMap, 0.3, 0.87, 0.5); box(0.3, 0.025, 0.04, rRed, 0.1, 0.88, 0.4);
        cyl(0.05, 0.25, rGold, 0.9, 0.98, 0.7, 8);
        col(0.3, 0.5, 1.15);
        [-0.9, 1.5].forEach((x) => stool(x, 0.5));
        // amache (due letti a rete sospesi)
        [[-W / 2 + 0.75, -0.4], [-W / 2 + 0.75, 1.5]].forEach(([x, z]) => {
          cyl(0.04, 1.9, rDark, x, 0.95, z - 0.55, 6); cyl(0.04, 1.9, rDark, x, 0.95, z + 0.55, 6);
          box(0.8, 0.12, 1.6, rCloth, x, 0.85, z); box(0.7, 0.14, 0.4, rBlue, x, 0.98, z - 0.6);
          col(x, z, 0.7);
        });
        // timone al muro destro
        const wheel = add(new THREE.TorusGeometry(0.55, 0.07, 8, 16), rWood, W / 2 - 0.2, 1.7, -D * 0.2);
        wheel.rotation.y = Math.PI / 2;
        for (let i = 0; i < 4; i++) { const sp = box(0.06, 1.1, 0.06, rWood, W / 2 - 0.2, 1.7, -D * 0.2); sp.rotation.x = (i * Math.PI) / 4; }
        cyl(0.08, 0.7, rWood, W / 2 - 0.25, 1.35, -D * 0.2, 8).rotation.z = Math.PI / 2;
        // barili e bauli, bandiera
        barrel(W / 2 - 0.55, D * 0.25); barrel(W / 2 - 0.55, D * 0.25 + 0.8);
        chest(W / 2 - 0.75, D * 0.05 - 0.2); box(0.04, 0.5, 0.9, rRed, 0, H - 0.7, -D / 2 + 0.07);
        // rotolo di corda
        const rope = add(new THREE.TorusGeometry(0.3, 0.09, 6, 14), rCloth, -W / 2 + 0.9, 0.12, D / 2 - 0.9); rope.rotation.x = Math.PI / 2;
        col(-W / 2 + 0.9, D / 2 - 0.9, 0.45);
        box(2.4, 0.03, 1.6, rNavy, 0.3, 0.02, 1.7);
      }
      scene.add(g);
      rooms[key] = { key, group: g, W, D, H, colliders };
    });
    function roomFree(room, x, z) {
      if (Math.abs(x) > room.W / 2 - 0.45 || z < -room.D / 2 + 0.35 || z > room.D / 2 - 0.45) return false;
      for (let i = 0; i < room.colliders.length; i++) {
        const c = room.colliders[i];
        if (Math.hypot(x - c.x, z - c.z) < c.r + 0.3) return false;
      }
      return true;
    }
    let inside = null; // { room, returnDir, returnFacing } while the character is indoors
    const inPos = new THREE.Vector3();
    const inHeading = new THREE.Vector3(0, 0, 1);
    let snapCam = false;
    let snapOutCam = false;

    let charDir = findLandSpawn();
    // asse di rotazione del sole, scelto in modo che il punto di partenza abbia giorno e notte
    const SUN_N = new THREE.Vector3(0.35, 1, 0.25).normalize();
    SUN_N.addScaledVector(charDir, 0.25 - SUN_N.dot(charDir)).normalize();
    const SUN_U = new THREE.Vector3().crossVectors(SUN_N, new THREE.Vector3(0, 0, 1)).normalize();
    const SUN_V = new THREE.Vector3().crossVectors(SUN_N, SUN_U).normalize();
    const SUN_A0 = Math.atan2(charDir.dot(SUN_V), charDir.dot(SUN_U));
    let facing = new THREE.Vector3(0, 0, -1);
    let charFacing = new THREE.Vector3(0, 0, -1);
    let camPitch = 0.45;
    let jumpHeight = 0;
    let jumpVel = 0;
    let grounded = true;
    const GRAVITY = 16;
    const JUMP_SPEED = 6;
    const MOVE_SPEED = 6.5;

    function groundRadiusAt(d) {
      return PLANET_R + Math.max(terrainHeight(d), SEA_LEVEL);
    }

    // ---------- Input: virtual joystick + jump button (camera is automatic, no drag) ----------
    let jumpRequested = false;
    const moveJoy = { dx: 0, dy: 0 };
    const lookJoy = { dx: 0, dy: 0 };

    function onKeyDown(e) {
      const k = e.key.toLowerCase();
      if (k === "w") keys.w = true;
      if (k === "a") keys.a = true;
      if (k === "s") keys.s = true;
      if (k === "d") keys.d = true;
      if (k === "arrowleft") keys.left = true;
      if (k === "arrowright") keys.right = true;
      if (k === "arrowup") keys.up = true;
      if (k === "arrowdown") keys.down = true;
      if (k === " ") jumpRequested = true;
    }
    function onKeyUp(e) {
      const k = e.key.toLowerCase();
      if (k === "w") keys.w = false;
      if (k === "a") keys.a = false;
      if (k === "s") keys.s = false;
      if (k === "d") keys.d = false;
      if (k === "arrowleft") keys.left = false;
      if (k === "arrowright") keys.right = false;
      if (k === "arrowup") keys.up = false;
      if (k === "arrowdown") keys.down = false;
    }
    const keys = { w: false, a: false, s: false, d: false, left: false, right: false, up: false, down: false };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function makeJoyVisual(nubColor) {
      const base = document.createElement("div");
      const nub = document.createElement("div");
      Object.assign(base.style, {
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
      Object.assign(nub.style, {
        position: "fixed",
        width: "40px",
        height: "40px",
        borderRadius: "50%",
        background: nubColor,
        border: "2px solid rgba(35,40,38,0.5)",
        transform: "translate(-50%,-50%)",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 0.15s",
        zIndex: 21,
      });
      mount.appendChild(base);
      mount.appendChild(nub);
      return {
        base,
        nub,
        set(baseX, baseY, nx, ny, visible) {
          base.style.left = baseX + "px";
          base.style.top = baseY + "px";
          base.style.opacity = visible ? "1" : "0";
          nub.style.left = baseX + nx + "px";
          nub.style.top = baseY + ny + "px";
          nub.style.opacity = visible ? "1" : "0";
        },
      };
    }
    const moveVisual = makeJoyVisual("rgba(217,164,65,0.9)");
    const lookVisual = makeJoyVisual("rgba(110,170,205,0.9)");

    mount.style.userSelect = "none";
    mount.style.webkitUserSelect = "none";
    mount.style.webkitTouchCallout = "none";
    mount.style.touchAction = "none";
    const noCtx = (e) => e.preventDefault();
    mount.addEventListener("contextmenu", noCtx);
    const pointers = new Map();
    function resetInput() {
      pointers.clear();
      moveJoy.dx = moveJoy.dy = lookJoy.dx = lookJoy.dy = 0;
      moveVisual.set(0, 0, 0, 0, false);
      lookVisual.set(0, 0, 0, 0, false);
    }
    const onVis = () => { if (document.hidden) resetInput(); };
    window.addEventListener("blur", resetInput);
    document.addEventListener("visibilitychange", onVis);
    function onPointerDown(e) {
      const role = e.clientX < window.innerWidth / 2 ? "move" : "look";
      pointers.set(e.pointerId, { role, startX: e.clientX, startY: e.clientY });
      (role === "move" ? moveVisual : lookVisual).set(e.clientX, e.clientY, 0, 0, true);
      setHint(false);
    }
    function onPointerMove(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      const max = p.role === "move" ? 55 : 80;
      const len = Math.min(max, Math.hypot(dx, dy));
      const ang = Math.atan2(dy, dx);
      const nx = (Math.cos(ang) * len) / max;
      const ny = (Math.sin(ang) * len) / max;
      if (p.role === "move") {
        moveJoy.dx = nx;
        moveJoy.dy = ny;
        moveVisual.set(p.startX, p.startY, Math.cos(ang) * len, Math.sin(ang) * len, true);
      } else {
        lookJoy.dx = nx;
        lookJoy.dy = ny;
        lookVisual.set(p.startX, p.startY, Math.cos(ang) * len, Math.sin(ang) * len, true);
      }
    }
    function onPointerUp(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      pointers.delete(e.pointerId);
      if (p.role === "move") {
        moveJoy.dx = 0;
        moveJoy.dy = 0;
        moveVisual.set(0, 0, 0, 0, false);
      } else {
        lookJoy.dx = 0;
        lookJoy.dy = 0;
        lookVisual.set(0, 0, 0, 0, false);
      }
    }
    const dom = renderer.domElement;
    dom.style.touchAction = "none";
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

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
      border: "2px solid rgba(255,255,255,0.6)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "12px",
      fontWeight: "700",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
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

    // action button: ENTRA next to a door, ESCI next to the interior door
    const actionBtn = document.createElement("div");
    actionBtn.textContent = "ENTRA";
    Object.assign(actionBtn.style, {
      position: "fixed",
      right: "24px",
      bottom: "124px",
      width: "76px",
      height: "76px",
      borderRadius: "50%",
      background: "rgba(35,40,38,0.38)",
      border: "2px solid rgba(255,211,92,0.85)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "12px",
      fontWeight: "700",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      userSelect: "none",
      touchAction: "none",
      zIndex: 22,
      opacity: "0",
      pointerEvents: "none",
      transition: "opacity 0.15s",
    });
    let actionRequested = false;
    actionBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      actionRequested = true;
      actionBtn.style.background = "rgba(255,211,92,0.55)";
    });
    actionBtn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      actionBtn.style.background = "rgba(35,40,38,0.38)";
    });
    mount.appendChild(actionBtn);
    function setAction(label) {
      if (label) {
        actionBtn.textContent = label;
        actionBtn.style.opacity = "1";
        actionBtn.style.pointerEvents = "auto";
      } else {
        actionBtn.style.opacity = "0";
        actionBtn.style.pointerEvents = "none";
      }
    }
    const fadeEl = document.createElement("div");
    Object.assign(fadeEl.style, { position: "fixed", inset: "0", background: "#000", opacity: "0", pointerEvents: "none", zIndex: 40 });
    mount.appendChild(fadeEl);
    function flash() {
      fadeEl.style.transition = "none";
      fadeEl.style.opacity = "1";
      void fadeEl.offsetWidth;
      fadeEl.style.transition = "opacity 0.4s";
      fadeEl.style.opacity = "0";
    }

    // ---------- Audio ----------
    const audio = createAudio();
    const startAudio = () => audio.start();
    window.addEventListener("pointerdown", startAudio);
    window.addEventListener("keydown", startAudio);
    const muteBtn = document.createElement("div");
    muteBtn.textContent = "\u{1F50A}";
    Object.assign(muteBtn.style, {
      position: "absolute", top: "12px", right: "12px", width: "40px", height: "40px", borderRadius: "50%",
      background: "rgba(35,40,38,0.38)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: "20px", cursor: "pointer", userSelect: "none", touchAction: "none", zIndex: 22,
    });
    const audioPanel = document.createElement("div");
    Object.assign(audioPanel.style, {
      position: "absolute", top: "58px", right: "12px", padding: "8px", borderRadius: "12px", display: "none",
      background: "rgba(35,40,38,0.7)", color: "#fff", font: "13px system-ui, sans-serif", zIndex: 22, flexDirection: "column", gap: "6px",
    });
    const chips = {};
    [["music", "Musica"], ["sfx", "Effetti"], ["amb", "Ambiente"]].forEach(([k, label]) => {
      const c = document.createElement("div");
      Object.assign(c.style, { padding: "6px 12px", borderRadius: "8px", cursor: "pointer", userSelect: "none", touchAction: "none", textAlign: "center" });
      const paint = () => {
        c.textContent = (audio.isOn(k) ? "\u2713 " : "\u2715 ") + label;
        c.style.background = audio.isOn(k) ? "rgba(120,190,120,0.55)" : "rgba(255,255,255,0.15)";
      };
      paint();
      c.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        audio.start();
        audio.toggle(k);
        paint();
        muteBtn.textContent = ["music", "sfx", "amb"].every((x) => !audio.isOn(x)) ? "\u{1F507}" : "\u{1F50A}";
      });
      chips[k] = c;
      audioPanel.appendChild(c);
    });
    muteBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      audio.start();
      audioPanel.style.display = audioPanel.style.display === "none" ? "flex" : "none";
    });
    mount.appendChild(muteBtn);
    mount.appendChild(audioPanel);

    // ---------- Identita', mondi e missioni ----------
    const store = {
      get(k) { try { return localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
      del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } },
    };
    let myToken = store.get("island_token");
    if (!myToken) {
      myToken = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      store.set("island_token", myToken);
    }
    const urlParams = new URLSearchParams(location.search);
    const isTestMode = urlParams.has("test");
    const urlRoom = (urlParams.get("room") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || null;
    const TOTAL_MISSIONS = 6;
    let missionsDone = new Set();
    if (!isTestMode) { try { missionsDone = new Set(JSON.parse(store.get("island_missions") || "[]")); } catch { /* ignora */ } }
    let role = store.get("island_role"); // "host" (ha creato un mondo) | "guest" (invitato)
    let myRoom = store.get("island_myroom");
    let roomName = null, roomCap = 6;
    let curMode = "join", curCode = null, curHost = false;
    const canCreate = () => role !== "guest" || missionsDone.size >= TOTAL_MISSIONS;
    function computeEntry() {
      if (isTestMode && !urlRoom) return { mode: "solo", label: "ENTRA (TEST)", msg: "Modalita' test: gioco da solo con un compagno simulato." };
      if (urlRoom) return { mode: "join", code: urlRoom, host: urlRoom === myRoom, label: "ENTRA NEL MONDO", msg: urlRoom === "test" ? "Stanza di sviluppo." : "Sei stato invitato in un mondo." };
      if (myRoom) return { mode: "join", code: myRoom, host: true, label: "TORNA NEL TUO MONDO", msg: "Il tuo mondo ti aspetta." };
      if (canCreate()) return { mode: "create", label: "CREA IL TUO MONDO", msg: "Crea un mondo tutto tuo e invita chi vuoi." };
      return { mode: "solo", label: "ESPLORA DA SOLO", msg: "Per creare il tuo mondo serve un invito: completa tutte le missioni nel mondo di chi ti ha invitato." };
    }
    let entry = computeEntry();

    // ---------- Splash / caricamento ----------
    const splash = document.createElement("div");
    Object.assign(splash.style, {
      position: "absolute", inset: "0", zIndex: 60, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: "18px", background: "linear-gradient(#2c4a52, #7fb0a6 70%, #e8d9a8)", color: "#fff", font: "15px system-ui, sans-serif",
      transition: "opacity 0.7s", textAlign: "center", padding: "24px",
    });
    splash.innerHTML = '<div style="font-size:54px;font-weight:700;letter-spacing:10px;text-shadow:0 3px 12px rgba(0,0,0,.35)">ISLAND</div>' +
      '<div id="splashMsg" style="opacity:.9;max-width:300px;min-height:3em">' + entry.msg + '</div>';
    const barWrap = document.createElement("div");
    Object.assign(barWrap.style, { width: "220px", height: "8px", borderRadius: "4px", background: "rgba(255,255,255,.25)", overflow: "hidden" });
    const barFill = document.createElement("div");
    Object.assign(barFill.style, { width: "0%", height: "100%", background: "#fff", transition: "width .25s" });
    barWrap.appendChild(barFill);
    const enterBtn = document.createElement("div");
    enterBtn.textContent = entry.label;
    Object.assign(enterBtn.style, {
      display: "none", padding: "12px 38px", borderRadius: "30px", background: "#fff", color: "#2c4a52", fontWeight: "700",
      letterSpacing: "3px", cursor: "pointer", userSelect: "none", touchAction: "none",
    });
    splash.appendChild(barWrap);
    splash.appendChild(enterBtn);
    mount.appendChild(splash);
    let splashGone = false;
    const splashStart = performance.now();
    const splashTimer = setInterval(() => {
      const total = Math.max(1, loadStat.pending);
      const ratio = Math.min(1, loadStat.done / total);
      barFill.style.width = Math.round(ratio * 100) + "%";
      if ((loadStat.done >= loadStat.pending && performance.now() - splashStart > 900) || performance.now() - splashStart > 15000) {
        barWrap.style.display = "none";
        enterBtn.style.display = "block";
        clearInterval(splashTimer);
      }
    }, 120);
    const splashMsgEl = splash.querySelector("#splashMsg");
    function showSplash(msg, label) {
      splashMsgEl.textContent = msg;
      enterBtn.textContent = label;
      splashGone = false;
      splash.style.display = "flex";
      splash.style.pointerEvents = "auto";
      requestAnimationFrame(() => (splash.style.opacity = "1"));
      barWrap.style.display = "none";
      enterBtn.style.display = "block";
    }
    function closeSplash() {
      if (splashGone) return;
      splashGone = true;
      audio.start();
      try { startNet(); } catch { /* non ancora pronto */ }
      splash.style.opacity = "0";
      splash.style.pointerEvents = "none";
      setTimeout(() => { if (splashGone) splash.style.display = "none"; }, 800);
      if (!helpSeen) {
        helpSeen = true;
        try { localStorage.setItem("island_help", "1"); } catch { /* ignora */ }
        setTimeout(() => showHelp(), 900);
      }
    }
    enterBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); closeSplash(); });

    // ---------- Minimappa (proiezione azimutale centrata su di te, "avanti" = su) ----------
    let MAP_PX = 112, MAP_RES = 36, MAP_ANG = 1.5, mapBig = false, mapZoom = 1;
    const MAP_FULL = Math.PI * 0.995;
    const mapCanvas = document.createElement("canvas");
    mapCanvas.width = MAP_PX; mapCanvas.height = MAP_PX;
    Object.assign(mapCanvas.style, { position: "absolute", top: "12px", left: "12px", width: MAP_PX + "px", height: MAP_PX + "px", borderRadius: "50%", border: "3px solid rgba(255,255,255,.75)", background: "#123", zIndex: 22, boxShadow: "0 2px 10px rgba(0,0,0,.3)" });
    mount.appendChild(mapCanvas);
    const mctx = mapCanvas.getContext("2d");
    const mapTmp = document.createElement("canvas");
    mapTmp.width = MAP_RES; mapTmp.height = MAP_RES;
    const mtx = mapTmp.getContext("2d");
    let mapImg = mtx.createImageData(MAP_RES, MAP_RES);
    let mapTimer = 0;
    const mapBackdrop = document.createElement("div");
    Object.assign(mapBackdrop.style, { position: "absolute", inset: "0", background: "rgba(10,20,25,0.55)", zIndex: 44, display: "none" });
    mount.appendChild(mapBackdrop);
    function applyMapSize() {
      MAP_PX = mapBig ? Math.max(220, Math.min(380, window.innerWidth - 32, window.innerHeight - 100)) : 112;
      MAP_RES = mapBig ? 110 : 36;
      MAP_ANG = mapBig ? MAP_FULL / mapZoom : 1.5;
      mapCtl.style.display = mapBig ? "flex" : "none";
      mapCtl.style.top = mapBig ? `calc(50% + ${MAP_PX / 2 + 12}px)` : "0";
      mapCanvas.width = MAP_PX; mapCanvas.height = MAP_PX;
      mapTmp.width = MAP_RES; mapTmp.height = MAP_RES;
      mapImg = mtx.createImageData(MAP_RES, MAP_RES);
      Object.assign(mapCanvas.style, mapBig
        ? { width: MAP_PX + "px", height: MAP_PX + "px", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 45 }
        : { width: "112px", height: "112px", top: "12px", left: "12px", transform: "none", zIndex: 22 });
      mapBackdrop.style.display = mapBig ? "block" : "none";
      mapTimer = 0;
    }
    mapCanvas.style.pointerEvents = "auto";
    mapCanvas.style.cursor = "pointer";
    mapCanvas.style.touchAction = "none";
    const mapCtl = document.createElement("div");
    Object.assign(mapCtl.style, { position: "absolute", left: "50%", transform: "translateX(-50%)", display: "none", gap: "12px", zIndex: 46 });
    const mapBtn = (label, fn) => {
      const b = document.createElement("div");
      b.textContent = label;
      Object.assign(b.style, { width: "46px", height: "46px", borderRadius: "50%", background: "rgba(255,255,255,0.92)", color: "#223", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px", fontWeight: "700", cursor: "pointer", userSelect: "none", touchAction: "none", font: "700 22px system-ui, sans-serif" });
      b.addEventListener("pointerdown", (e) => { e.stopPropagation(); fn(); });
      mapCtl.appendChild(b);
    };
    const setZoom = (z) => { mapZoom = Math.max(1, Math.min(4, z)); MAP_ANG = MAP_FULL / mapZoom; mapTimer = 0; };
    const closeMap = () => { mapBig = false; mapZoom = 1; applyMapSize(); };
    mapBtn("\u2212", () => setZoom(mapZoom / 1.5));
    mapBtn("+", () => setZoom(mapZoom * 1.5));
    mapBtn("\u2715", closeMap);
    mount.appendChild(mapCtl);
    // piccola: un tocco la apre. Grande: un tocco NON la chiude; zoom con +/- , rotella o pinch (due dita).
    const mapPtrs = new Map();
    let pinchD0 = 0, pinchZ0 = 1;
    mapCanvas.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (!mapBig) { mapBig = true; mapZoom = 1; applyMapSize(); return; }
      mapPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mapPtrs.size === 2) { const [a, b] = [...mapPtrs.values()]; pinchD0 = Math.hypot(a.x - b.x, a.y - b.y); pinchZ0 = mapZoom; }
    });
    mapCanvas.addEventListener("pointermove", (e) => {
      if (!mapPtrs.has(e.pointerId)) return;
      mapPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mapPtrs.size === 2 && pinchD0 > 0) { const [a, b] = [...mapPtrs.values()]; setZoom(pinchZ0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinchD0)); }
    });
    const mapUp = (e) => mapPtrs.delete(e.pointerId);
    mapCanvas.addEventListener("pointerup", mapUp);
    mapCanvas.addEventListener("pointercancel", mapUp);
    mapCanvas.addEventListener("wheel", (e) => { if (!mapBig) return; e.preventDefault(); setZoom(mapZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
    mapBackdrop.addEventListener("pointerdown", (e) => { e.stopPropagation(); closeMap(); });
    const mpR = new THREE.Vector3(), mpD = new THREE.Vector3(), mpT = new THREE.Vector3();
    function updateMinimap(dt) {
      mapTimer -= dt;
      if (mapTimer > 0) return;
      mapTimer = mapBig ? 0.5 : 0.25;
      mpR.crossVectors(facing, charDir).normalize();
      for (let j = 0; j < MAP_RES; j++) {
        for (let i = 0; i < MAP_RES; i++) {
          const px = ((i + 0.5) / MAP_RES) * 2 - 1, py = ((j + 0.5) / MAP_RES) * 2 - 1;
          const r = Math.hypot(px, py);
          const o = (j * MAP_RES + i) * 4;
          if (r > 1) { mapImg.data[o + 3] = 0; continue; }
          const ang = r * MAP_ANG;
          const k = r > 0.0001 ? Math.sin(ang) / r : 0;
          mpD.copy(charDir).multiplyScalar(Math.cos(ang)).addScaledVector(mpR, px * k).addScaledVector(facing, -py * k).normalize();
          const h = terrainHeight(mpD);
          let c;
          if (h <= SEA_LEVEL + 0.15) c = [70, 130, 168];
          else if (h < SEA_LEVEL + 0.9) c = [226, 208, 150];
          else if (h > 5.8) c = [240, 240, 244];
          else if (h > 3.6) c = [128, 126, 122];
          else c = [128, 170, 98];
          mapImg.data[o] = c[0]; mapImg.data[o + 1] = c[1]; mapImg.data[o + 2] = c[2]; mapImg.data[o + 3] = 255;
        }
      }
      mtx.putImageData(mapImg, 0, 0);
      mctx.clearRect(0, 0, MAP_PX, MAP_PX);
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(mapTmp, 0, 0, MAP_PX, MAP_PX);
      const Rm = MAP_PX / 2;
      for (let i = 0; i < buildings.length; i++) {
        mpD.copy(buildings[i].pos).normalize();
        const dp = mpD.dot(charDir);
        const ang = Math.acos(Math.min(1, Math.max(-1, dp)));
        if (ang > MAP_ANG * 0.97) continue;
        mpT.copy(mpD).addScaledVector(charDir, -dp);
        const tl = mpT.length();
        if (tl < 1e-5) continue;
        const rr = (ang / MAP_ANG) * Rm;
        mctx.fillStyle = "#d9503f";
        mctx.fillRect(Rm + (mpT.dot(mpR) / tl) * rr - 2, Rm - (mpT.dot(facing) / tl) * rr - 2, 4, 4);
      }
      for (let i = 0; i < places.length; i++) {
        mpD.copy(places[i].dir);
        const dp = mpD.dot(charDir), ang = Math.acos(Math.min(1, Math.max(-1, dp)));
        if (ang > MAP_ANG * 0.97) continue;
        mpT.copy(mpD).addScaledVector(charDir, -dp);
        const tl = mpT.length();
        if (tl < 1e-5) continue;
        const rr = (ang / MAP_ANG) * Rm, cx = Rm + (mpT.dot(mpR) / tl) * rr, cy = Rm - (mpT.dot(facing) / tl) * rr;
        const k = mapBig ? 1.5 : 1;
        mctx.fillStyle = places[i].act > 0.5 ? "#ffffff" : "#ffd35c"; mctx.strokeStyle = "#7a5a00"; mctx.lineWidth = 1;
        mctx.beginPath(); mctx.moveTo(cx, cy - 5 * k); mctx.lineTo(cx + 4 * k, cy); mctx.lineTo(cx, cy + 5 * k); mctx.lineTo(cx - 4 * k, cy); mctx.closePath(); mctx.fill(); mctx.stroke();
        if (mapBig) { mctx.font = "600 11px system-ui, sans-serif"; mctx.lineWidth = 3; mctx.strokeStyle = "rgba(0,0,0,.65)"; mctx.strokeText(places[i].name, cx + 9, cy + 4); mctx.fillStyle = "#fff"; mctx.fillText(places[i].name, cx + 9, cy + 4); }
      }
      remotes.forEach((r) => {
        if (!r.curDir) return;
        mpD.copy(r.curDir);
        const dp = mpD.dot(charDir), ang = Math.acos(Math.min(1, Math.max(-1, dp)));
        if (ang > MAP_ANG * 0.99) return;
        mpT.copy(mpD).addScaledVector(charDir, -dp);
        const tl = mpT.length();
        const rr = (ang / MAP_ANG) * Rm;
        const cx = tl < 1e-5 ? Rm : Rm + (mpT.dot(mpR) / tl) * rr, cy = tl < 1e-5 ? Rm : Rm - (mpT.dot(facing) / tl) * rr;
        mctx.fillStyle = "#4fe3ff"; mctx.strokeStyle = "#fff"; mctx.lineWidth = 2;
        mctx.beginPath(); mctx.arc(cx, cy, mapBig ? 6 : 4, 0, 6.283); mctx.fill(); mctx.stroke();
      });
      mctx.fillStyle = "#fff"; mctx.strokeStyle = "#222"; mctx.lineWidth = 1.5;
      mctx.beginPath(); mctx.moveTo(Rm, Rm - 6); mctx.lineTo(Rm + 5, Rm + 5); mctx.lineTo(Rm - 5, Rm + 5); mctx.closePath(); mctx.fill(); mctx.stroke();
    }

    // ---------- Polvere (passi e atterraggio) ----------
    const dustGeo = new THREE.SphereGeometry(0.12, 6, 5);
    const dust = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(dustGeo, new THREE.MeshBasicMaterial({ color: "#e8dcc0", transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      dust.push({ m, vel: new THREE.Vector3(), life: 0, max: 0.6 });
    }
    let dustIdx = 0;
    function puff(pos, up, count, spread) {
      for (let i = 0; i < count; i++) {
        const d = dust[dustIdx++ % dust.length];
        d.m.position.copy(pos);
        d.vel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread).addScaledVector(up, 0.5 + Math.random() * 0.6);
        d.life = d.max = 0.45 + Math.random() * 0.3;
        d.m.visible = true;
      }
    }
    function updateDust(dt) {
      for (const d of dust) {
        if (d.life <= 0) continue;
        d.life -= dt;
        if (d.life <= 0) { d.m.visible = false; continue; }
        const k = d.life / d.max;
        d.m.position.addScaledVector(d.vel, dt);
        d.m.scale.setScalar(0.6 + (1 - k) * 1.2);
        d.m.material.opacity = k * 0.5;
      }
    }

    // ---------- Multiplayer (relay) ----------
    const remotes = new Map(); // id -> { root, mixer, actions, curDir, tgtDir, facing, jump, moving, inside, bubble, waveUntil }
    const relayUrl = (import.meta.env && import.meta.env.VITE_RELAY_URL) || `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;
    let myNetId = null;
    let playersOnline = 1;
    const netLabel = document.createElement("div");
    Object.assign(netLabel.style, { position: "absolute", top: "134px", left: "12px", font: "12px system-ui, sans-serif", color: "#fff", background: "rgba(35,40,38,0.45)", padding: "3px 9px", borderRadius: "10px", zIndex: 22, pointerEvents: "none" });
    netLabel.textContent = "○ offline";
    mount.appendChild(netLabel);

    function makeBubble() {
      const c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      const x = c.getContext("2d");
      x.font = "44px serif"; x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText("\u{1F44B}", 32, 36);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
      sp.scale.set(0.9, 0.9, 1);
      sp.position.y = 2.7;
      sp.visible = false;
      sp.renderOrder = 10;
      return sp;
    }
    function addRemote(id, tintIdx) {
      const root = new THREE.Group();
      const r = { root, mixer: null, idle: null, walk: null, jumpA: null, waveA: null, cur: null, curDir: null, tgtDir: new THREE.Vector3(), facing: new THREE.Vector3(0, 0, 1), jump: 0, moving: false, inside: false, bubble: makeBubble(), waveUntil: 0, b: -1, rh: 0, ip: new THREE.Vector3(), ipT: new THREE.Vector3(), ipInit: false };
      if (anneGltf) {
        const model = SkeletonUtils.clone(anneGltf.scene);
        applyPlayerTint(model, PLAYER_TINTS[tintIdx % PLAYER_TINTS.length], gradientMap);
        model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
        root.add(model);
        if (anneGltf.animations?.length) {
          r.mixer = new THREE.AnimationMixer(model);
          const find = (n) => anneGltf.animations.find((c) => c.name.toLowerCase() === n.toLowerCase());
          const idle = find("Idle") ?? anneGltf.animations[0], walk = find("Walk"), jmp = find("Jump_Idle") ?? find("Jump"), wv = findWaveClip(anneGltf.animations);
          r.idle = idle ? r.mixer.clipAction(idle) : null; r.walk = walk ? r.mixer.clipAction(walk) : null;
          r.jumpA = jmp ? r.mixer.clipAction(jmp) : null; r.waveA = wv ? r.mixer.clipAction(wv) : null;
          r.cur = r.idle; if (r.cur) r.cur.play();
        }
      } else {
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 8), new THREE.MeshToonMaterial({ color: PLAYER_TINTS[tintIdx % PLAYER_TINTS.length], gradientMap }));
        body.position.y = 0.9;
        root.add(body);
      }
      root.add(r.bubble);
      root.visible = false;
      scene.add(root);
      remotes.set(id, r);
      return r;
    }
    function removeRemote(id) {
      const r = remotes.get(id);
      if (!r) return;
      scene.remove(r.root);
      remotes.delete(id);
    }
    let net = { connected: false, send() {}, close() {}, reconnect() {} };
    function startNet() {
      if (disposed || net.connected || netStarted) return;
      if (entry.mode === "solo") { netLabel.textContent = "\u25CB da solo"; return; }
      netStarted = true;
      curMode = entry.mode; curCode = entry.code || null; curHost = !!entry.host;
      net = connectRelay({
      url: () => `${relayUrl}/?room=${curCode || ""}&token=${myToken}&mode=${curMode}${curHost ? "&host=1" : ""}`,
      onError: (why) => {
        net.close();
        net = { connected: false, send() {}, close() {}, reconnect() {} };
        netStarted = false;
        [...remotes.keys()].forEach(removeRemote);
        netLabel.textContent = "\u25CB offline";
        if (why === "noroom") {
          if (curCode && curCode === myRoom) { store.del("island_myroom"); myRoom = null; }
          urlParams.delete("room");
          history.replaceState(null, "", location.pathname);
          entry = { ...computeEntry() };
          entry.code = undefined;
          if (!canCreate()) entry = { mode: "solo", label: "ESPLORA DA SOLO", msg: "Questo mondo non esiste piu'. Chiedi un nuovo invito, oppure completa le missioni per creare il tuo mondo." };
          else entry = { mode: "create", label: "CREA IL TUO MONDO", msg: "Questo mondo non esiste piu'. Puoi crearne uno nuovo." };
        } else if (why === "full") entry = { ...entry, msg: "Questo mondo e' al completo. Riprova tra poco.", label: "RIPROVA" };
        else if (why === "notest") entry = { mode: "solo", label: "ESPLORA DA SOLO", msg: "La stanza di test non e' attiva su questo server." };
        else if (why === "busy") entry = { ...entry, msg: "Il server e' molto occupato. Riprova tra poco.", label: "RIPROVA" };
        else entry = { ...entry, msg: "Impossibile entrare nel mondo (" + why + ").", label: "RIPROVA" };
        showSplash(entry.msg, entry.label);
      },
      onHello: (m) => {
        myNetId = m.id;
        roomName = m.room; curCode = m.room; curMode = "join"; roomCap = m.cap || 6;
        if (m.host) { curHost = true; role = role || "host"; store.set("island_role", role); store.set("island_myroom", m.room); myRoom = m.room; }
        else if (!role) { role = "guest"; store.set("island_role", "guest"); }
        entry = { mode: "join", code: m.room, host: !!m.host, label: m.host ? "TORNA NEL TUO MONDO" : "TORNA NEL MONDO", msg: "" };
        if (m.room !== "test") history.replaceState(null, "", location.pathname + "?room=" + m.room + (isTestMode ? "&test=1" : ""));
        // evita di spawnare sopra un altro giocatore: ognuno parte in un punto leggermente diverso
        if (m.id > 1 && !inside) {
          const ang = m.id * 1.0;
          const rt = new THREE.Vector3().crossVectors(facing, charDir).normalize();
          const tg = facing.clone().multiplyScalar(Math.cos(ang)).addScaledVector(rt, Math.sin(ang));
          const cand = charDir.clone().addScaledVector(tg, 0.035 * (1 + Math.floor(m.id / 6) * 0.6)).normalize();
          if (!isBlocked(cand)) charDir = cand;
        }
      },
      onStatus: (ok) => {
        if (!ok) { netLabel.textContent = "○ offline — tocca per riconnettere"; [...remotes.keys()].forEach(removeRemote); }
        else netLabel.textContent = "● online";
      },
      onState: (m) => {
        playersOnline = m.n;
        roomCap = m.cap || roomCap;
        netLabel.textContent = "\u25CF " + m.n + "/" + roomCap + (m.n > 1 ? " nel mondo" : " \u00B7 da solo");
        (m.pl || []).forEach((pid) => { const lp = places.find((x) => x.pid === pid); if (lp && !lp.locked) lp.locked = true; });
        const present = new Set();
        m.p.forEach((q) => {
          present.add(q.id);
          const r = remotes.get(q.id) ?? addRemote(q.id, q.c);
          r.tgtDir.set(q.d[0], q.d[1], q.d[2]).normalize();
          if (!r.curDir) r.curDir = r.tgtDir.clone();
          r.facing.set(q.f[0], q.f[1], q.f[2]);
          r.jump = q.j; r.moving = !!q.m; r.inside = !!q.i;
          r.b = q.b ?? -1; r.rh = q.rh || 0; r.ipT.set(q.rx || 0, 0, q.rz || 0);
          if (!r.ipInit) { r.ip.copy(r.ipT); r.ipInit = true; }
        });
        [...remotes.keys()].forEach((id) => { if (!present.has(id)) removeRemote(id); });
      },
      onWave: (m) => {
        const r = remotes.get(m.id);
        if (!r) return;
        r.waveUntil = performance.now() + 1800;
        if (r.curDir && r.curDir.dot(charDir) > 0.97) audio.greet();
      },
      onLeave: (m) => removeRemote(m.id),
      });
    }
    let netStarted = false;
    let disposed = false;
    const netFallback = 0; // la connessione parte quando premi il pulsante della schermata iniziale
    let netSendT = 0;
    const tmpUp = new THREE.Vector3(), tmpPos = new THREE.Vector3(), tmpLook = new THREE.Vector3();
    function updateRemotes(dt) {
      remotes.forEach((r) => {
        if (!r.curDir) return;
        r.curDir.lerp(r.tgtDir, 1 - Math.exp(-dt * 10)).normalize();
        if (r.inside) {
          // dentro un edificio: lo vedi solo se sei nello stesso edificio
          r.root.visible = !!inside && inside.bIdx === r.b;
          if (!r.root.visible) return;
          r.ip.lerp(r.ipT, 1 - Math.exp(-dt * 10));
          tmpPos.set(r.ip.x, r.jump, r.ip.z);
          r.root.position.copy(tmpPos);
          r.root.up.set(0, 1, 0);
          r.root.lookAt(tmpPos.x + Math.sin(r.rh), tmpPos.y, tmpPos.z + Math.cos(r.rh));
        } else {
          r.root.visible = !inside;
          if (inside) return;
          const gr = groundRadiusAt(r.curDir);
          tmpPos.copy(r.curDir).multiplyScalar(gr + r.jump);
          r.root.position.copy(tmpPos);
          r.root.up.copy(r.curDir);
          tmpLook.copy(r.facing).addScaledVector(r.curDir, -r.facing.dot(r.curDir));
          if (tmpLook.lengthSq() > 1e-6) { tmpLook.normalize().add(tmpPos); r.root.lookAt(tmpLook); }
        }
        const waving = performance.now() < r.waveUntil;
        r.bubble.visible = waving;
        if (r.mixer) {
          const want = waving && !r.moving && r.jump < 0.05 && r.waveA ? r.waveA : r.jump > 0.05 ? (r.jumpA ?? r.walk ?? r.idle) : r.moving ? (r.walk ?? r.idle) : r.idle;
          if (want && want !== r.cur) { want.reset().fadeIn(0.15).play(); if (r.cur) r.cur.fadeOut(0.15); r.cur = want; }
          r.mixer.update(dt);
        }
      });
    }
    function sendNet(dt) {
      netSendT -= dt;
      if (netSendT > 0 || !net.connected) return;
      netSendT = 0.1;
      const d = inside ? inside.returnDir : charDir;
      const f = inside ? inside.returnFacing : charFacing;
      const q = (v) => Math.round(v * 1000) / 1000;
      net.send({ t: "pos", d: [q(d.x), q(d.y), q(d.z)], f: [q(f.x), q(f.y), q(f.z)], j: q(inside ? jumpHeight : jumpHeight), m: lastMoving ? 1 : 0, i: inside ? 1 : 0, b: inside ? inside.bIdx : -1, rx: inside ? q(inPos.x) : 0, rz: inside ? q(inPos.z) : 0, rh: inside ? q(Math.atan2(inHeading.x, inHeading.z)) : 0 });
    }
    let lastMoving = false;

    // ---------- Pulsante "saluta" ----------
    const greetBtn = document.createElement("div");
    greetBtn.textContent = "\u{1F44B}";
    Object.assign(greetBtn.style, {
      position: "fixed", right: "112px", bottom: "40px", width: "56px", height: "56px", borderRadius: "50%",
      background: "rgba(35,40,38,0.38)", border: "2px solid rgba(255,255,255,0.55)", display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: "26px", cursor: "pointer", userSelect: "none", touchAction: "none", zIndex: 22,
    });
    function doGreet() {
      if (inside) return;
      waveUntil = performance.now() + 1800;
      audio.greet();
      net.send({ t: "wave" });
    }
    greetBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); greetBtn.style.background = "rgba(217,164,65,0.55)"; doGreet(); });
    greetBtn.addEventListener("pointerup", (e) => { e.stopPropagation(); greetBtn.style.background = "rgba(35,40,38,0.38)"; });
    mount.appendChild(greetBtn);
    const onGreetKey = (e) => { if (e.key === "g" || e.key === "G") doGreet(); };
    window.addEventListener("keydown", onGreetKey);


    // ---------- Indizi, menu, aiuto ----------
    let alwaysDay = false;
    try { alwaysDay = localStorage.getItem("island_day") === "1"; } catch { /* ignora */ }
    const nearLabel = document.createElement("div");
    Object.assign(nearLabel.style, { position: "absolute", top: "160px", left: "12px", font: "12px system-ui, sans-serif", color: "#fff", background: "rgba(35,40,38,0.45)", padding: "3px 9px", borderRadius: "10px", zIndex: 22, pointerEvents: "none", maxWidth: "200px" });
    mount.appendChild(nearLabel);
    const toastEl = document.createElement("div");
    Object.assign(toastEl.style, { position: "absolute", top: "64px", left: "50%", transform: "translateX(-50%)", font: "14px system-ui, sans-serif", color: "#fff", background: "rgba(35,40,38,0.75)", padding: "9px 18px", borderRadius: "16px", zIndex: 30, pointerEvents: "none", opacity: "0", transition: "opacity .4s", textAlign: "center", maxWidth: "86%" });
    mount.appendChild(toastEl);
    let toastTimer = null;
    function toast(msg, ms = 4500) {
      toastEl.textContent = msg;
      toastEl.style.opacity = "1";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toastEl.style.opacity = "0"), ms);
    }
    const menuPanel = document.createElement("div");
    Object.assign(menuPanel.style, { position: "absolute", top: "58px", right: "12px", padding: "8px", borderRadius: "12px", display: "none", background: "rgba(35,40,38,0.78)", color: "#fff", font: "14px system-ui, sans-serif", zIndex: 23, flexDirection: "column", gap: "6px", minWidth: "170px" });
    const menuItem = (label, fn) => {
      const c = document.createElement("div");
      c.textContent = label;
      Object.assign(c.style, { padding: "9px 12px", borderRadius: "8px", cursor: "pointer", userSelect: "none", touchAction: "none", background: "rgba(255,255,255,0.14)" });
      c.addEventListener("pointerdown", (e) => e.stopPropagation());
      c.addEventListener("click", (e) => { e.stopPropagation(); menuPanel.style.display = "none"; fn(); });
      menuPanel.appendChild(c);
      return c;
    };
    const menuBtn = document.createElement("div");
    menuBtn.textContent = "☰";
    Object.assign(menuBtn.style, { position: "absolute", top: "12px", right: "60px", width: "40px", height: "40px", borderRadius: "50%", background: "rgba(35,40,38,0.38)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", cursor: "pointer", userSelect: "none", touchAction: "none", zIndex: 22 });
    menuBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      audioPanel.style.display = "none";
      menuPanel.style.display = menuPanel.style.display === "none" ? "flex" : "none";
    });
    mount.appendChild(menuBtn);
    mount.appendChild(menuPanel);
    muteBtn.addEventListener("pointerdown", () => { menuPanel.style.display = "none"; });

    const helpEl = document.createElement("div");
    Object.assign(helpEl.style, { position: "absolute", inset: "0", zIndex: 55, display: "none", alignItems: "center", justifyContent: "center", background: "rgba(10,20,25,0.6)" });
    helpEl.innerHTML = '<div style="background:#fff;color:#223;max-width:340px;margin:16px;padding:20px 22px;border-radius:18px;font:14px/1.55 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)">' +
      '<div style="font-size:19px;font-weight:700;margin-bottom:8px">Come si gioca</div>' +
      '<div>\u{1F449} <b>Muoviti</b>: trascina a sinistra. <b>Guarda</b>: trascina a destra.</div>' +
      '<div>\u{1F3E0} Vicino a una porta premi <b>ENTRA</b>.</div>' +
      '<div>\u{1F44B} <b>Saluta</b> chi incontri (tasto G sul PC).</div>' +
      '<div>\u{1F5FA}️ <b>Tocca la mappa</b> per ingrandirla: i rombi gialli sono i <b>luoghi speciali</b>.</div>' +
      '<div>✨ Un luogo speciale si attiva solo se <b>almeno 2 persone</b> stanno insieme nel suo cerchio dorato.</div>' +
      '<div>\u{1F517} Gli altri compaiono solo se li inviti: <b>☰ → Invita amici</b> e manda il link.</div>' +
      '<div style="margin-top:14px;text-align:center"><span style="display:inline-block;padding:9px 30px;border-radius:22px;background:#2c4a52;color:#fff;font-weight:700;cursor:pointer">Capito</span></div></div>';
    mount.appendChild(helpEl);
    const showHelp = () => { helpEl.style.display = "flex"; };
    helpEl.addEventListener("pointerdown", (e) => { e.stopPropagation(); helpEl.style.display = "none"; });
    function inviteLink() {
      const u = new URL(location.href);
      u.searchParams.set("room", curCode);
      u.searchParams.delete("test");
      return u.toString();
    }
    const shareEl = document.createElement("div");
    Object.assign(shareEl.style, { position: "absolute", inset: "0", zIndex: 56, display: "none", alignItems: "center", justifyContent: "center", background: "rgba(10,20,25,0.6)" });
    shareEl.innerHTML = '<div style="background:#fff;color:#223;width:min(360px,88%);padding:18px 20px;border-radius:18px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)">' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:6px">Invita amici</div>' +
      '<div style="margin-bottom:10px">Manda questo link: chi lo apre entra nel tuo stesso mondo.</div>' +
      '<input id="shareInput" readonly style="width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:8px;font:13px system-ui,sans-serif">' +
      '<div style="display:flex;gap:10px;margin-top:12px;justify-content:center">' +
      '<span id="shareCopy" style="padding:9px 22px;border-radius:20px;background:#2c4a52;color:#fff;font-weight:700;cursor:pointer">Copia</span>' +
      '<span id="shareClose" style="padding:9px 22px;border-radius:20px;background:#e3e7e8;color:#223;font-weight:700;cursor:pointer">Chiudi</span></div></div>';
    mount.appendChild(shareEl);
    const shareInput = shareEl.querySelector("#shareInput");
    shareEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    shareEl.querySelector("#shareClose").addEventListener("click", () => (shareEl.style.display = "none"));
    shareEl.querySelector("#shareCopy").addEventListener("click", async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(shareInput.value); ok = true; } catch { /* prova il metodo vecchio */ }
      if (!ok) { try { shareInput.focus(); shareInput.select(); ok = document.execCommand("copy"); } catch { ok = false; } }
      toast(ok ? "Link copiato!" : "Seleziona il testo e copialo a mano");
    });
    function invite() {
      if (!curCode || !net.connected) { toast("Entra prima in un mondo online per invitare qualcuno."); return; }
      const link = inviteLink();
      if (navigator.share) { navigator.share({ title: "Island", text: "Vieni a esplorare con me!", url: link }).catch(() => {}); return; }
      shareInput.value = link;
      shareEl.style.display = "flex";
    }
    function leaveGame() {
      net.close();
      net = { connected: false, send() {}, close() {}, reconnect() {} };
      netStarted = false;
      [...remotes.keys()].forEach(removeRemote);
      netLabel.textContent = "\u25CB offline";
      if (curCode) entry = { mode: "join", code: curCode, host: curHost, label: curHost ? "TORNA NEL TUO MONDO" : "TORNA NEL MONDO", msg: "" };
      showSplash(entry.msg || "Sei fuori dal gioco.", entry.label);
    }
    const missionsEl = document.createElement("div");
    Object.assign(missionsEl.style, { position: "absolute", inset: "0", zIndex: 55, display: "none", alignItems: "center", justifyContent: "center", background: "rgba(10,20,25,0.6)" });
    mount.appendChild(missionsEl);
    missionsEl.addEventListener("pointerdown", (e) => { e.stopPropagation(); missionsEl.style.display = "none"; });
    function showMissions() {
      const rows = places.map((pl) => '<div>' + (missionsDone.has(pl.name) ? "\u2705" : "\u2B1C") + " " + pl.name + "</div>").join("");
      const done = missionsDone.size;
      missionsEl.innerHTML = '<div style="background:#fff;color:#223;max-width:340px;margin:16px;padding:20px 22px;border-radius:18px;font:14px/1.7 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)">' +
        '<div style="font-size:19px;font-weight:700;margin-bottom:6px">Missioni ' + done + "/" + TOTAL_MISSIONS + "</div>" +
        '<div style="margin-bottom:8px;opacity:.8">Attiva ogni luogo speciale insieme a un\'altra persona. Un luogo attivato resta attivo.</div>' + rows +
        '<div style="margin-top:10px;font-weight:600">' + (done >= TOTAL_MISSIONS ? "Hai completato tutto: puoi creare il tuo mondo da \u2630." : "Completale tutte per poter creare il tuo mondo.") + "</div>" +
        '<div style="margin-top:12px;text-align:center"><span style="display:inline-block;padding:9px 30px;border-radius:22px;background:#2c4a52;color:#fff;font-weight:700;cursor:pointer">Chiudi</span></div></div>';
      missionsEl.style.display = "flex";
    }
    function completeMission(pl) {
      missionsDone.add(pl.name);
      if (!isTestMode) store.set("island_missions", JSON.stringify([...missionsDone]));
      const k = missionsDone.size;
      toast(k >= TOTAL_MISSIONS ? "\u{1F389} Tutte le missioni completate! Ora puoi creare il tuo mondo da \u2630." : "\u2705 Missione completata: " + pl.name + " (" + k + "/" + TOTAL_MISSIONS + ")", 6000);
    }
    menuItem("❓ Aiuto", showHelp);
    menuItem("\u{1F517} Invita amici", invite);
    menuItem("\u{1F3AF} Missioni", showMissions);
    menuItem("\u{1F30D} Crea un nuovo mondo", () => {
      if (!canCreate()) { toast("Completa tutte le missioni per creare il tuo mondo (" + missionsDone.size + "/" + TOTAL_MISSIONS + ")."); return; }
      if (!window.confirm("Creare un nuovo mondo? Quello attuale resta raggiungibile solo con il suo link.")) return;
      store.del("island_myroom");
      location.href = location.pathname;
    });
    menuItem("\u{1F504} Riconnetti", () => {
      if (net.connected) { toast("Sei gia' online"); return; }
      if (!netStarted) { startNet(); toast("Mi connetto..."); return; }
      net.reconnect(); toast("Mi riconnetto...");
    });
    const dayItem = menuItem("\u2600\uFE0F Giorno / notte: " + (alwaysDay ? "sempre giorno" : "automatico"), () => {
      alwaysDay = !alwaysDay;
      try { localStorage.setItem("island_day", alwaysDay ? "1" : "0"); } catch { /* ignora */ }
      dayItem.textContent = "\u2600\uFE0F Giorno / notte: " + (alwaysDay ? "sempre giorno" : "automatico");
      toast(alwaysDay ? "Sempre giorno" : "Giorno e notte automatici");
    });
    menuItem("\u{1F6AA} Esci", leaveGame);
    netLabel.style.pointerEvents = "auto";
    netLabel.style.cursor = "pointer";
    netLabel.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (!net.connected) { net.reconnect(); toast("Mi riconnetto..."); } });
    let helpSeen = false;
    try { helpSeen = localStorage.getItem("island_help") === "1"; } catch { /* storage non disponibile */ }
    let aloneT = 0, aloneToasted = false;

    // ---------- Luoghi speciali: si attivano solo se almeno 2 persone sono vicine ----------
    const TEST_PARTNER = new URLSearchParams(location.search).has("test"); // ?test=1 simula un secondo giocatore
    const PLACE_RADIUS = 3.4;
    let placeNearFlag = false; // i suoni dei luoghi si sentono solo da vicino
    const places = [];
    const mkMat = (c) => new THREE.MeshToonMaterial({ color: c, gradientMap });
    const glowMat = (c) => new THREE.MeshBasicMaterial({ color: c });
    const stoneM = mkMat("#8a8782"), woodM = mkMat("#7a5636"), waterM = new THREE.MeshBasicMaterial({ color: "#6fc3e8", transparent: true, opacity: 0.8 });
    const lerpColor = (m, c1, c2, k) => m.color.set(c1).lerp(new THREE.Color(c2), k);
    function newPlace(name, build) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(PLACE_RADIUS - 0.3, 0.07, 6, 40), new THREE.MeshBasicMaterial({ color: "#ffd35c", transparent: true, opacity: 0.35 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.08;
      g.add(ring);
      // faro luminoso visibile da lontano + etichetta col nome
      const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 16, 8, 1, true), new THREE.MeshBasicMaterial({ color: "#ffd35c", transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
      beacon.position.y = 8;
      g.add(beacon);
      const cv = document.createElement("canvas");
      cv.width = 512; cv.height = 96;
      const cx2 = cv.getContext("2d");
      cx2.font = "600 40px system-ui, sans-serif"; cx2.textAlign = "center"; cx2.textBaseline = "middle";
      cx2.lineWidth = 8; cx2.strokeStyle = "rgba(20,30,35,.85)"; cx2.strokeText("\u2728 " + name, 256, 48);
      cx2.fillStyle = "#fff"; cx2.fillText("\u2728 " + name, 256, 48);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
      label.scale.set(5.5, 1.03, 1); label.position.y = 5.2; label.renderOrder = 11;
      g.add(label);
      const upd = build(g);
      return { name, group: g, ring, beacon, label, upd, act: 0, wasOn: false, dir: null, count: 1, locked: false, pid: -1 };
    }
    const BUILDERS = [
      ["Fontana dei desideri", (g) => {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.5, 0.55, 20), stoneM); base.position.y = 0.27; g.add(base);
        const pool = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.08, 20), waterM); pool.position.y = 0.58; g.add(pool);
        const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 1.1, 8), stoneM); pil.position.y = 1.0; g.add(pil);
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.35, 0.3, 14), stoneM); bowl.position.y = 1.6; g.add(bowl);
        const bowlW = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 14), waterM); bowlW.position.y = 1.77; g.add(bowlW);
        const drops = [];
        for (let i = 0; i < 16; i++) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), glowMat("#bfe9ff")); d.visible = false; g.add(d); drops.push({ m: d, a: (i / 16) * 6.283, ph: (i * 0.37) % 1 }); }
        return (act, t) => {
          pool.material.color.set("#6fc3e8").lerp(new THREE.Color("#c8f0ff"), act);
          drops.forEach((d) => { const u = (t * 0.8 + d.ph) % 1; const r = 0.15 + u * 1.0; d.m.position.set(Math.cos(d.a) * r, 1.9 + 1.8 * (4 * u * (1 - u)) - u * 1.1, Math.sin(d.a) * r); d.m.scale.setScalar(act); d.m.visible = act > 0.05; });
        };
      }],
      ["Cerchio di pietre", (g) => {
        const runes = [];
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * 6.283, st = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.9 + (i % 3) * 0.3, 0.4), stoneM);
          st.position.set(Math.cos(a) * 2.2, 0.9, Math.sin(a) * 2.2); st.rotation.y = -a; g.add(st);
          const rn = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.5, 0.05), glowMat("#445566")); rn.position.set(0, 0.2, 0.22); st.add(rn); runes.push(rn);
        }
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 16, 16, 1, true), new THREE.MeshBasicMaterial({ color: "#8fe8ff", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
        beam.position.y = 8; g.add(beam);
        return (act, t) => { runes.forEach((r, i) => lerpColor(r.material, "#445566", "#7ff3ff", act * (0.7 + 0.3 * Math.sin(t * 3 + i)))); beam.material.opacity = act * 0.32; beam.scale.set(1 + 0.1 * Math.sin(t * 4), 1, 1 + 0.1 * Math.sin(t * 4)); beam.visible = act > 0.02; };
      }],
      ["Altalena a bilico", (g) => {
        [-1, 1].forEach((sd) => { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.2, 0.14), woodM); leg.position.set(0, 0.55, sd * 0.35); leg.rotation.x = sd * 0.35; g.add(leg); });
        const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 8), mkMat("#3b3a3c")); axle.rotation.x = Math.PI / 2; axle.position.y = 1.0; g.add(axle);
        const plank = new THREE.Group(); plank.position.y = 1.05; g.add(plank);
        const pl = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.18, 0.7), mkMat("#d9a05b")); plank.add(pl);
        [-1, 1].forEach((sd) => {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.7), mkMat(sd < 0 ? "#d9503f" : "#4f86c9")); seat.position.set(sd * 2.0, 0.16, 0); plank.add(seat);
          const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.6), mkMat("#3b3a3c")); bar.position.set(sd * 1.65, 0.45, 0); plank.add(bar);
        });
        return (act, t) => { plank.rotation.z = (0.1 + Math.sin(t * 2.2) * 0.3) * (0.15 + act * 0.85); };
      }],
      ["Lanterne del cielo", (g) => {
        const ls = [];
        for (let i = 0; i < 9; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), glowMat("#ffb347")); const a = (i / 9) * 6.283; l.userData = { a, r: 0.8 + (i % 3) * 0.5, ph: i * 0.9 }; g.add(l); ls.push(l); }
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.4, 6), woodM); pole.position.y = 0.7; g.add(pole);
        return (act, t) => ls.forEach((l, i) => { const u = l.userData; l.position.set(Math.cos(u.a + t * 0.2 * act) * u.r, 0.4 + act * (3 + i * 0.9) + Math.sin(t * 1.5 + u.ph) * 0.15, Math.sin(u.a + t * 0.2 * act) * u.r); l.scale.setScalar(0.7 + act * 0.5); });
      }],
      ["Prato fiorito", (g) => {
        const fl = [], cols = ["#ff7aa8", "#ffd35c", "#ffffff", "#b58cff", "#ff9a5c"];
        for (let i = 0; i < 28; i++) {
          const a = i * 2.4, r = 0.4 + Math.sqrt(i / 28) * 2.3, f = new THREE.Group();
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.7, 5), mkMat("#4f8a4a")); stem.position.y = 0.35; f.add(stem);
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), mkMat(cols[i % 5])); head.position.y = 0.75; f.add(head);
          f.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); g.add(f); fl.push(f);
        }
        return (act, t) => fl.forEach((f, i) => { const k = Math.max(0.12, act); f.scale.set(k, 0.15 + 1.0 * act + 0.08 * Math.sin(t * 2 + i) * act, k); });
      }],
      ["Campane del vento", (g) => {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.14, 0.14), woodM); frame.position.y = 2.6; g.add(frame);
        [-1.5, 1.5].forEach((x) => { const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 6), woodM); lg.position.set(x, 1.3, 0); g.add(lg); });
        const bells = [];
        for (let i = 0; i < 5; i++) { const piv = new THREE.Group(); piv.position.set(-1.2 + i * 0.6, 2.55, 0); const b = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, 0.5 + i * 0.12, 8), mkMat("#d4af37")); b.position.y = -0.55 - i * 0.06; piv.add(b); g.add(piv); bells.push(piv); }
        let timer = 0, idx = 0;
        return (act, t, dt) => { bells.forEach((b, i) => { b.rotation.z = Math.sin(t * 2.4 + i * 1.3) * 0.35 * act; }); if (act > 0.6 && placeNearFlag) { timer -= dt; if (timer <= 0) { timer = 0.55 + Math.random() * 0.5; audio.chime(idx++ + Math.floor(Math.random() * 3)); } } };
      }],
    ];
    {
      const chosen = [];
      for (const [bi, [name, build]] of BUILDERS.entries()) {
        for (let attempt = 0; attempt < 2500; attempt++) {
          const d = randomDir();
          const h = terrainHeight(d);
          if (h < SEA_LEVEL + 0.8 || h > 2.2) continue;
          let ok = true;
          for (let i = 0; i < obstacles.length && ok; i++) if (d.angleTo(obstacles[i].dir) < obstacles[i].r + (attempt > 1500 ? 4 : 6) / PLANET_R) ok = false;
          for (let i = 0; i < chosen.length && ok; i++) if (d.angleTo(chosen[i].dir) < (attempt > 1200 ? 0.6 : 0.9)) ok = false;
          if (!ok) continue;
          // solo su terreno pianeggiante: nessuna differenza di quota significativa nel cerchio
          {
            const ref = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
            const t1 = new THREE.Vector3().crossVectors(ref, d).normalize();
            const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
            let lo = 99, hi = -99;
            for (let k = 0; k < 8; k++) {
              const a2 = (k / 8) * 6.283;
              const q = d.clone().addScaledVector(t1, (Math.cos(a2) * 3.4) / PLANET_R).addScaledVector(t2, (Math.sin(a2) * 3.4) / PLANET_R).normalize();
              const hh = terrainHeight(q);
              lo = Math.min(lo, hh); hi = Math.max(hi, hh);
            }
            if (hi - lo > 0.6 + attempt * 0.0012) ok = false;
          }
          if (!ok) continue;
          const pl = newPlace(name, build);
          const surf = getSurfacePoint(d);
          pl.dir = d.clone();
          pl.pid = bi;
          pl.group.position.copy(surf.point);
          pl.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surf.normal);
          scene.add(pl.group);
          obstacles.push({ dir: d.clone(), r: (name === "Fontana dei desideri" ? 1.7 : 0.9) / PLANET_R });
          chosen.push(pl);
          places.push(pl);
          break;
        }
      }
    }
    if (TEST_PARTNER) window.__info = () => ({ villages: VILLAGES.length, buildings: buildings.length, trees: decor.tree.length, places: places.length });
    if (TEST_PARTNER) window.__tpPlace = (i) => { const pl = places[i]; if (!pl) return places.length; charDir = pl.dir.clone().addScaledVector(facing, -0.02).normalize(); return places.length; };
    const placeHint = document.createElement("div");
    Object.assign(placeHint.style, { position: "absolute", bottom: "34px", left: "50%", transform: "translateX(-50%)", font: "14px system-ui, sans-serif", color: "#fff", background: "rgba(35,40,38,0.55)", padding: "7px 16px", borderRadius: "16px", zIndex: 22, pointerEvents: "none", opacity: "0", transition: "opacity .3s", whiteSpace: "nowrap" });
    mount.appendChild(placeHint);
    function updatePlaces(dt, t) {
      let hint = "";
      for (const pl of places) {
        let n = 0;
        const r2 = PLACE_RADIUS / PLANET_R;
        if (!inside && charDir.angleTo(pl.dir) < r2) n++;
        remotes.forEach((r) => { if (r.curDir && !r.inside && r.curDir.angleTo(pl.dir) < r2) n++; });
        if (TEST_PARTNER && n >= 1) n++;
        pl.count = n;
        // una volta attivato, un luogo resta attivo per sempre (anche per chi arriva dopo)
        if (n >= 2 && !pl.locked) { pl.locked = true; audio.place(); net.send({ t: "place", p: pl.pid }); }
        const on = pl.locked;
        pl.act += ((on ? 1 : 0) - pl.act) * Math.min(1, dt * 2.5);
        const here = !inside && charDir.angleTo(pl.dir) < r2;
        if (here && on && pl.act > 0.5 && !missionsDone.has(pl.name)) completeMission(pl);
        placeNearFlag = !inside && charDir.angleTo(pl.dir) * PLANET_R < 22;
        pl.ring.material.opacity = 0.3 + 0.5 * pl.act + (n === 1 ? 0.15 * Math.sin(t * 5) : 0);
        pl.ring.material.color.set("#ffd35c").lerp(new THREE.Color("#ffffff"), pl.act);
        pl.upd(pl.act, t, dt);
        if (!inside && charDir.angleTo(pl.dir) < r2 * 1.6) hint = on ? "✨ " + pl.name + " — " + (missionsDone.has(pl.name) ? "missione completata ✅" : "attivo!") : "✨ " + pl.name + " — serve qualcun altro qui con te";
      }
      let nearest = null, nearAng = 9;
      for (const pl of places) {
        const a = inside ? 9 : charDir.angleTo(pl.dir);
        pl.beacon.material.opacity = 0.16 + 0.3 * pl.act + 0.06 * Math.sin(t * 2 + pl.dir.x * 9);
        pl.label.visible = a * PLANET_R < 30;
        pl.beacon.visible = a * PLANET_R > PLACE_RADIUS + 2;
        pl.label.material.opacity = Math.min(1, Math.max(0.15, 1.4 - (a * PLANET_R) / 22));
        if (a < nearAng) { nearAng = a; nearest = pl; }
      }
      nearLabel.style.display = inside || !nearest ? "none" : "block";
      if (nearest && !inside) nearLabel.textContent = "\u25C6 " + nearest.name + " \u00B7 " + Math.round(nearAng * PLANET_R) + " m";
      if (net.connected && playersOnline <= 1 && !inside) { aloneT += dt; if (aloneT > 30 && !aloneToasted) { aloneToasted = true; toast("Sei da solo nel mondo. \u2630 \u2192 Invita amici per giocare insieme e attivare i luoghi speciali."); } }
      placeHint.textContent = hint || placeHint.textContent;
      placeHint.style.opacity = hint ? "1" : "0";
    }

    // ---------- Animation loop ----------
    let lookSmX = 0, lookSmY = 0;
    let curSpeed = 0; // 0..1 velocita' corrente (accelerazione morbida)
    const lastMoveDir = new THREE.Vector3();
    let stepAcc = 0;
    let landSquash = 0;
    let wasGrounded = true;
    const clock = new THREE.Clock();
    const dayColorTmp = new THREE.Color();
    const duskColorTmp = new THREE.Color();
    let walkPhase = 0;
    let walkAmp = 0;
    let raf;
    function animateLimbs(moving, dt) {
      walkAmp += ((moving && grounded ? 1 : 0) - walkAmp) * Math.min(1, dt * 6);
      if (moving) walkPhase += dt * 6.5;
      const swing = Math.sin(walkPhase) * 0.4 * walkAmp;
      const counterSwing = Math.sin(walkPhase + Math.PI) * 0.4 * walkAmp;
      hipLeft.rotation.x = swing;
      hipRight.rotation.x = counterSwing;
      shoulderLeft.rotation.x = counterSwing * 0.85;
      shoulderRight.rotation.x = swing * 0.85;
      if (!grounded) {
        const vNorm = Math.max(-1, Math.min(1, jumpVel / JUMP_SPEED));
        const apex = 1 - Math.abs(vNorm);
        const tuck = 0.1 + 0.28 * apex;
        hipLeft.rotation.x = tuck;
        hipRight.rotation.x = tuck;
        shoulderLeft.rotation.x = -0.5 - 0.4 * apex;
        shoulderRight.rotation.x = -0.5 - 0.4 * apex;
      }
    }

    function enterBuilding(b) {
      const room = rooms[b.roomKey];
      const centerDir = b.pos.clone().normalize();
      const out = b.exitDir.clone().sub(centerDir);
      out.addScaledVector(b.exitDir, -out.dot(b.exitDir)).normalize();
      inside = { room, returnDir: b.exitDir.clone(), returnFacing: out, bIdx: buildings.indexOf(b) };
      audio.enter();
      inPos.set(0, 0, -room.D / 2 + 1.4);
      inHeading.set(0, 0, 1);
      jumpHeight = 0;
      jumpVel = 0;
      grounded = true;
      Object.values(rooms).forEach((r) => (r.group.visible = r === room));
      stage.visible = true;
      roomLight.position.set(0, room.H - 0.6, 0);
      roomLight.intensity = 1.1;
      camera.up.set(0, 1, 0);
      snapCam = true;
      setAction(null);
      flash();
    }
    function exitBuilding() {
      charDir = inside.returnDir.clone();
      facing.copy(inside.returnFacing);
      charFacing.copy(inside.returnFacing);
      Object.values(rooms).forEach((r) => (r.group.visible = false));
      stage.visible = false;
      roomLight.intensity = 0;
      inside = null;
      audio.exit();
      jumpHeight = 0;
      jumpVel = 0;
      grounded = true;
      camera.up.copy(charDir);
      snapOutCam = true;
      setAction(null);
      flash();
    }

    function animate() {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      quality.sample(dt, t);
      if (mixer) mixer.update(dt);

      // Il sole gira attorno al pianeta: giorno e notte dipendono da DOVE ti trovi (terminatore reale).
      const DAY_CYCLE_SECONDS = 2400; // un giro completo del sole: 40 minuti
      const sunAngle = SUN_A0 - 0.7 + ((t % DAY_CYCLE_SECONDS) / DAY_CYCLE_SECONDS) * Math.PI * 2;
      sunDirVec.copy(SUN_U).multiplyScalar(Math.cos(sunAngle)).addScaledVector(SUN_V, Math.sin(sunAngle));
      const sunHeight = alwaysDay ? 1 : charDir.dot(sunDirVec); // 1 = sole allo zenit, -1 = mezzanotte
      // transizione molto graduale (camminando non passi da giorno a buio in pochi secondi) e notte chiara
      const dayFactor = smoothstep(-0.7, 0.45, sunHeight);
      const duskFactor = alwaysDay ? 0 : Math.max(0, 1 - Math.abs(sunHeight - 0.05) * 3) * 0.8;
      sun.intensity = 0.4 + dayFactor * 0.8;
      sun.color.set("#a9b8e0").lerp(dayColorTmp.set("#fff3da"), dayFactor).lerp(duskColorTmp.set("#ff9a5c"), duskFactor * 0.55);
      hemi.intensity = 1.0 + dayFactor * 0.1;
      hemi.color.set("#98a6d6").lerp(dayColorTmp.set("#dfe8e6"), dayFactor);
      skyMat.color.set("#6f80ae").lerp(dayColorTmp.set("#ffffff"), dayFactor).lerp(duskColorTmp.set("#ffb27a"), duskFactor * 0.45);
      scene.fog.color.copy(skyMat.color);

      // ---------- Clouds: orbit slowly around their own random axis ----------
      clouds.forEach((c) => {
        const d = c.startDir.clone().applyAxisAngle(c.axis, t * c.speed);
        c.group.position.copy(d).multiplyScalar(PLANET_R + c.altitude);
        orientToSurface(c.group, d, t * 0.05);
      });

      // ---------- Birds: orbit at altitude around a fixed random axis ----------
      birds.forEach((b) => {
        const d = b.startDir.clone().applyAxisAngle(b.axis, t * b.speed);
        b.g.position.copy(d).multiplyScalar(PLANET_R + b.altitude);
        const tangent = new THREE.Vector3().crossVectors(b.axis, d).normalize();
        orientToSurface(b.g, d, 0);
        b.g.lookAt(b.g.position.clone().add(tangent));
        const flap = Math.sin(t * 10 + b.flapPhase) * 0.6;
        b.wingL.rotation.z = flap;
        b.wingR.rotation.z = -flap;
      });

      // ---------- Fish: small circular swim around a confirmed-underwater point ----------
      fish.forEach((f) => {
        f.angle += f.speed * dt;
        const wobble = new THREE.Vector3(Math.cos(f.angle), 0, Math.sin(f.angle)).multiplyScalar(f.radius);
        const d = f.center.clone().add(wobble).normalize();
        f.g.position.copy(d).multiplyScalar(PLANET_R + SEA_LEVEL - 0.15);
        orientToSurface(f.g, d, f.angle + Math.PI / 2);
      });

      // ---------- Crabs: scuttle to nearby points on the beach, tangent-walk between them ----------
      crabs.forEach((c) => {
        if (t > c.pauseUntil) {
          if (c.dir.angleTo(c.targetDir) < 0.01) {
            const a = rand() * Math.PI * 2;
            const dist = 0.02 + rand() * 0.03;
            const off = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(dist);
            c.targetDir = c.homeDir.clone().add(off).normalize();
            c.pauseUntil = t + 0.6 + rand() * 1.8;
          } else {
            c.dir.lerp(c.targetDir, Math.min(1, dt * 2)).normalize();
          }
        }
        c.g.position.copy(c.dir).multiplyScalar(PLANET_R + terrainHeight(c.dir) + 0.06);
        orientToSurface(c.g, c.dir, t * 2 + c.phase);
      });



      if (inside) {
        const room = inside.room;
        let mx = moveJoy.dx;
        let my = moveJoy.dy;
        if (keys.w) my -= 1;
        if (keys.s) my += 1;
        if (keys.a) mx -= 1;
        if (keys.d) mx += 1;
        const mlen = Math.hypot(mx, my);
        let moving = false;
        if (mlen > 0.08) {
          const mag = Math.min(1, mlen);
          const nx = mx / Math.max(mlen, 1);
          const nz = my / Math.max(mlen, 1); // the room camera looks toward -Z, so stick up = -Z
          const step = 4.2 * dt * mag;
          const px = inPos.x + nx * step;
          const pz = inPos.z + nz * step;
          if (roomFree(room, px, pz)) {
            inPos.set(px, 0, pz);
            moving = true;
          } else if (roomFree(room, px, inPos.z)) {
            inPos.x = px;
            moving = true;
          } else if (roomFree(room, inPos.x, pz)) {
            inPos.z = pz;
            moving = true;
          }
          const want = new THREE.Vector3(nx, 0, nz).normalize();
          inHeading.lerp(want, Math.min(1, dt * 8 * mag)).normalize();
        }
        if (jumpRequested && grounded) {
          jumpVel = JUMP_SPEED;
          grounded = false;
        }
        jumpRequested = false;
        jumpVel -= GRAVITY * dt;
        jumpHeight += jumpVel * dt;
        if (jumpHeight <= 0) {
          jumpHeight = 0;
          jumpVel = 0;
          grounded = true;
        }
        const ipos = new THREE.Vector3(inPos.x, jumpHeight, inPos.z);
        character.position.copy(ipos);
        character.up.set(0, 1, 0);
        character.lookAt(ipos.clone().add(inHeading));
        blob.position.set(inPos.x, 0.03, inPos.z);
        blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
        blob.scale.setScalar(Math.max(0.4, 1 - jumpHeight * 0.25));
        animateLimbs(moving, dt);
        audio.update(dt, 0, dayFactor, true);
        mapCanvas.style.display = "none";
        lastMoving = moving;
        updateRemotes(dt);
        sendNet(dt);
        character.scale.set(1, 1, 1);

        // fixed cutaway camera, distance adapted to the screen shape so the whole room always fits
        const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const tanH = tanV * camera.aspect;
        const dist = Math.min(34, Math.max(6, Math.max((room.W / 2 + 0.8) / tanH, (room.D / 2 + room.H * 0.5 + 1.0) / tanV)));
        const ang = THREE.MathUtils.degToRad(48);
        const target = new THREE.Vector3(0, 0.7, -room.D * 0.05);
        const camPos = target.clone().add(new THREE.Vector3(0, Math.sin(ang) * dist, Math.cos(ang) * dist));
        if (snapCam) {
          camera.position.copy(camPos);
          snapCam = false;
        } else {
          camera.position.lerp(camPos, Math.min(1, dt * 10));
        }
        camera.up.set(0, 1, 0);
        camera.lookAt(target);

        const nearExit = Math.abs(inPos.x) < 1.4 && inPos.z < -room.D / 2 + 1.9;
        setAction(nearExit ? "ESCI" : null);
        if (actionRequested && nearExit) exitBuilding();
        actionRequested = false;
        syncRealAnim(moving);
      renderer.render(scene, camera);
        return;
      }

      facing.addScaledVector(charDir, -facing.dot(charDir)).normalize();
      let lookX = lookJoy.dx;
      let lookY = lookJoy.dy;
      if (keys.left) lookX -= 1;
      if (keys.right) lookX += 1;
      if (keys.up) lookY -= 1;
      if (keys.down) lookY += 1;
      // risposta curva + smorzata: piccoli movimenti = rotazione lenta, niente giramenti di testa
      const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
      lookSmX += (curve(lookX) - lookSmX) * Math.min(1, dt * 7);
      lookSmY += (curve(lookY) - lookSmY) * Math.min(1, dt * 7);
      if (Math.abs(lookSmX) > 0.02) facing.applyAxisAngle(charDir, -lookSmX * 1.4 * dt);
      camPitch = Math.max(0.15, Math.min(1.2, camPitch + lookSmY * 0.9 * dt));
      const right = new THREE.Vector3().crossVectors(facing, charDir).normalize();

      let mx = moveJoy.dx;
      let my = moveJoy.dy;
      if (keys.w) my -= 1;
      if (keys.s) my += 1;
      if (keys.a) mx -= 1;
      if (keys.d) mx += 1;
      const mlen = Math.hypot(mx, my);
      const DEAD_ZONE = 0.08;

      let moving = false;
      let inputMag = 0;
      if (mlen > DEAD_ZONE) {
        const nx = mx / Math.max(mlen, 1);
        const ny = my / Math.max(mlen, 1);
        inputMag = Math.min(1, mlen);
        lastMoveDir.set(0, 0, 0).addScaledVector(facing, -ny).addScaledVector(right, nx);
        if (lastMoveDir.lengthSq() > 0.0001) {
          lastMoveDir.normalize();
          charFacing.lerp(lastMoveDir, Math.min(1, dt * 6 * inputMag)).addScaledVector(charDir, -charFacing.dot(charDir)).normalize();
        } else inputMag = 0;
      }
      // accelerazione/frenata morbide
      curSpeed += (inputMag - curSpeed) * Math.min(1, dt * (inputMag > curSpeed ? 9 : 12));
      if (curSpeed < 0.02 && inputMag === 0) curSpeed = 0;
      if (curSpeed > 0 && lastMoveDir.lengthSq() > 0.0001) {
        const mv = lastMoveDir;
        const base = charDir.clone().multiplyScalar(groundRadiusAt(charDir) + jumpHeight);
        const fwd = mv.dot(facing), rgt = mv.dot(right);
        const attempts = [mv, new THREE.Vector3().addScaledVector(facing, fwd).normalize(), new THREE.Vector3().addScaledVector(right, rgt).normalize()];
        for (const attempt of attempts) {
          if (attempt.lengthSq() < 0.0001) continue;
          const candidateDir = base.clone().addScaledVector(attempt, MOVE_SPEED * dt * curSpeed).normalize();
          if (!isBlocked(candidateDir) && terrainHeight(candidateDir) > SEA_LEVEL - 0.35) {
            charDir = candidateDir;
            moving = true;
            break;
          }
        }
      }
      charFacing.addScaledVector(charDir, -charFacing.dot(charDir)).normalize();

      if (jumpRequested && grounded) {
        jumpVel = JUMP_SPEED;
        grounded = false;
        audio.jump();
      }
      jumpRequested = false;
      const impactVel = jumpVel;
      jumpVel -= GRAVITY * dt;
      jumpHeight += jumpVel * dt;
      if (jumpHeight <= 0) {
        jumpHeight = 0;
        jumpVel = 0;
        grounded = true;
      }
      const justLanded = grounded && !wasGrounded;
      wasGrounded = grounded;

      const groundR = groundRadiusAt(charDir);
      const charPos = charDir.clone().multiplyScalar(groundR + jumpHeight);
      character.position.copy(charPos);
      character.up.copy(charDir);
      character.lookAt(charPos.clone().add(charFacing));
      sun.target.position.copy(charPos);
      sun.position.copy(charPos).addScaledVector(sunDirVec, 70);
      sun.target.updateMatrixWorld();
      blob.position.copy(charDir.clone().multiplyScalar(groundR + 0.02));
      blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), charDir);
      blob.scale.setScalar(Math.max(0.4, 1 - jumpHeight * 0.25));

      animateLimbs(moving, dt);

      // passi + polvere, atterraggio morbido (squash)
      // un passo a ogni appoggio del piede: sincronizzato con la fase della camminata
      const stepIdx = Math.floor(walkPhase / Math.PI);
      if (moving && grounded && walkAmp > 0.5) {
        if (stepIdx !== stepAcc) {
          stepAcc = stepIdx;
          audio.step(0.5 + 0.5 * curSpeed);
          puff(blob.position, charDir, 1, 0.4);
        }
      } else stepAcc = stepIdx;
      if (justLanded) {
        const power = Math.min(1, Math.abs(impactVel) / JUMP_SPEED);
        landSquash = power;
        audio.land(power);
        puff(blob.position, charDir, 6, 1.4);
      }
      landSquash = Math.max(0, landSquash - dt * 5);
      character.scale.set(1 + 0.12 * landSquash, 1 - 0.2 * landSquash, 1 + 0.12 * landSquash);
      updateDust(dt);
      mapCanvas.style.display = "block";
      updateMinimap(dt);
      lastMoving = moving;
      updateRemotes(dt);
      updatePlaces(dt, t);
      sendNet(dt);
      {
        const h = terrainHeight(charDir);
        audio.update(dt, Math.max(0.05, Math.min(1, 1 - (h - SEA_LEVEL) / 2.5)), dayFactor, false);
      }

      let nearBuilding = null;
      let nearDist = 3.4;
      for (let i = 0; i < buildings.length; i++) {
        const dd = charPos.distanceTo(buildings[i].doorWorld);
        if (dd < nearDist) {
          nearDist = dd;
          nearBuilding = buildings[i];
        }
      }
      setAction(nearBuilding ? "ENTRA" : null);
      if (actionRequested && nearBuilding) enterBuilding(nearBuilding);
      actionRequested = false;

      const camDist = 6.5;
      const behind = facing.clone().multiplyScalar(-Math.cos(camPitch) * camDist);
      const above = charDir.clone().multiplyScalar(Math.sin(camPitch) * camDist + 1.4);
      const desiredCamPos = charPos.clone().add(behind).add(above);
      if (snapOutCam) {
        camera.position.copy(desiredCamPos);
        camera.up.copy(charDir);
        snapOutCam = false;
      } else {
        camera.position.lerp(desiredCamPos, Math.min(1, dt * 8));
        camera.up.lerp(charDir, Math.min(1, dt * 8)).normalize();
      }
      camera.lookAt(charPos.clone().addScaledVector(charDir, 1.0));

      syncRealAnim(moving);
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
      mount.removeChild(moveVisual.base);
      mount.removeChild(moveVisual.nub);
      mount.removeChild(lookVisual.base);
      mount.removeChild(lookVisual.nub);
      mount.removeEventListener("contextmenu", noCtx);
      window.removeEventListener("blur", resetInput);
      document.removeEventListener("visibilitychange", onVis);
      mount.removeChild(jumpBtn);
      mount.removeChild(actionBtn);
      mount.removeChild(muteBtn);
      mount.removeChild(audioPanel);
      mount.removeChild(mapCanvas);
      mount.removeChild(netLabel);
      [placeHint, nearLabel, toastEl, menuBtn, menuPanel, helpEl, mapBackdrop, mapCtl, shareEl, missionsEl].forEach((el) => el.parentNode && el.parentNode.removeChild(el));
      mount.removeChild(greetBtn);
      window.removeEventListener("keydown", onGreetKey);
      disposed = true;
      net.close();
      clearInterval(splashTimer);
      if (splash.parentNode) splash.parentNode.removeChild(splash);
      window.removeEventListener("pointerdown", startAudio);
      window.removeEventListener("keydown", startAudio);
      mount.removeChild(fadeEl);
      renderer.dispose();
      if (mount.contains(dom)) mount.removeChild(dom);
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", position: "relative", background: "#bcd6d8", overflow: "hidden" }}>
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
            zIndex: 30,
            pointerEvents: "none",
          }}
        >
          Sinistra: muoviti · Destra: guarda attorno
        </div>
      )}
    </div>
  );
}
