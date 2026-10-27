import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { loadModel } from "../lib/assetLoader.js";

// Extracts the real meshes (geometry + material) from a loaded model so we can draw
// N copies with ONE draw call (InstancedMesh) instead of N separate clones.
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
function terrainHeight(dir) {
  const noise = noiseAt(dir);
  const mask = seaMask(dir);
  const landH = noise * 0.7 + 1.0; // real hills/mountains, always comfortably above sea level
  const seaH = noise * 0.3 - 2.2; // genuinely deep water inside the two sea regions
  return landH * (1 - mask) + seaH * mask;
}

const PLANET_R = 68;
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
    sun.shadow.camera.far = 60;
    scene.add(sun);

    // ---------- Planet: an icosahedron displaced by seamless noise, so it reads ----------
    // as a small rocky/grassy world you can walk all the way around
    const PALETTE = { sand: "#c9b98f", grass: "#7c8b6f", rock: "#8c8880", snow: "#eef1ee", trunk: "#5c4b3a", foliage: "#4f6b52" };
    const sandC = new THREE.Color(PALETTE.sand);
    const grassC = new THREE.Color(PALETTE.grass);
    const rockC = new THREE.Color(PALETTE.rock);
    const snowC = new THREE.Color(PALETTE.snow);

    const planetGeo = new THREE.IcosahedronGeometry(PLANET_R, 6);
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
      else if (h < 1.7) tmpColor.copy(grassC).lerp(rockC, smoothstep(1.1, 1.7, h));
      else tmpColor.copy(rockC).lerp(snowC, smoothstep(1.7, 2.0, h));
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

    // Finds the EXACT point on the real rendered mesh in a given direction,
    // instead of trusting the analytic noise formula — with a low-poly mesh,
    // those two can disagree slightly between vertices, which is what was
    // making trees/rocks look like they float or sink a little.
    const raycaster = new THREE.Raycaster();
    function getSurfacePoint(d) {
      raycaster.set(d.clone().multiplyScalar(PLANET_R * 3), d.clone().negate());
      raycaster.far = PLANET_R * 6;
      const hits = raycaster.intersectObject(planet, false);
      if (hits.length > 0) {
        return { point: hits[0].point.clone(), normal: hits[0].face.normal.clone().transformDirection(planet.matrixWorld).normalize() };
      }
      const h = terrainHeight(d); // fallback, shouldn't normally trigger
      return { point: d.clone().multiplyScalar(PLANET_R + h), normal: d.clone() };
    }

    // ---------- Sea: a translucent sphere at sea level — land pokes above it, low areas sit under it ----------
    const seaMat = new THREE.MeshToonMaterial({ color: "#4f86a0", gradientMap, transparent: true, opacity: 0.82 });
    const sea = new THREE.Mesh(new THREE.SphereGeometry(PLANET_R + SEA_LEVEL, 48, 32), seaMat);
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
    const decor = { tree: [], bush: [], rock: [] }; // { obj (procedural stand-in), pos, quat, scale }
    for (let i = 0; i < 380; i++) {
      const d = randomDir();
      const h = terrainHeight(d);
      if (h < SEA_LEVEL + 0.05) continue; // keep the beaches clear
      const surf = getSurfacePoint(d);
      if (h < 1.4) {
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
      } else if (h < 1.5) {
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

    // ---------- Quality fallback: if the real models make it too slow, go back to the light procedural ones ----------
    const quality = {
      downgraded: false,
      frameTimes: [],
      groups: [], // { proc: Object3D[], real: Object3D[] }
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

    // ---------- Real models (trees, rocks, bushes): swapped in once loaded, procedural stays as fallback ----------
    function swapInReal(kind, paths) {
      Promise.all(paths.map((pth) => loadModel(pth))).then((models) => {
        const variants = models.filter(Boolean);
        if (variants.length === 0 || decor[kind].length === 0) return; // keep procedural
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
    const villageCenter = findVillageSpot();
    const hutWallMats = [
      new THREE.MeshToonMaterial({ color: "#c9b08a", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#b8a48f", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#a99478", gradientMap }),
    ];
    const hutRoofMats = [
      new THREE.MeshToonMaterial({ color: "#8a4f3a", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#6b5a42", gradientMap }),
      new THREE.MeshToonMaterial({ color: "#7a3f38", gradientMap }),
    ];
    const hutDoorMat = new THREE.MeshToonMaterial({ color: "#3a2a1e", gradientMap });
    const HUT_SIZES = {
      small: { w: 3.2, h: 2.6, roofH: 1.5, doorH: 1.5 },
      medium: { w: 4.4, h: 3.3, roofH: 1.9, doorH: 1.7 },
      large: { w: 6.2, h: 4.2, roofH: 2.5, doorH: 1.9 },
    };
    function buildHut(d, facingTangent, sizeKey) {
      const s = HUT_SIZES[sizeKey] ?? HUT_SIZES.medium;
      const wallMat = hutWallMats[Math.floor(rand() * hutWallMats.length)];
      const roofMat = hutRoofMats[Math.floor(rand() * hutRoofMats.length)];
      const surf = getSurfacePoint(d);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.w), wallMat);
      body.position.y = s.h / 2;
      body.castShadow = true;
      g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(s.w * 0.82, s.roofH, 4), roofMat);
      roof.position.y = s.h + s.roofH / 2;
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      g.add(roof);
      const door = new THREE.Mesh(new THREE.BoxGeometry(s.w * 0.22, s.doorH, 0.06), hutDoorMat);
      door.position.set(0, s.doorH / 2, s.w / 2 + 0.03);
      g.add(door);
      g.position.copy(surf.point);
      g.up.copy(surf.normal);
      g.lookAt(surf.point.clone().add(facingTangent));
      scene.add(g);
      obstacles.push({ dir: d.clone(), r: (s.w * 0.62) / PLANET_R });
      return g;
    }
    const HUT_COUNT = 5;
    const villageSizeOrder = ["large", "small", "medium", "small", "medium"];
    for (let i = 0; i < HUT_COUNT; i++) {
      const angle = (i / HUT_COUNT) * Math.PI * 2;
      const offsetDist = 7.5 / PLANET_R;
      const tangentA = new THREE.Vector3(1, 0, 0).addScaledVector(villageCenter, -villageCenter.x).normalize();
      const tangentB = new THREE.Vector3().crossVectors(villageCenter, tangentA).normalize();
      const hutDir = villageCenter
        .clone()
        .addScaledVector(tangentA, Math.cos(angle) * offsetDist)
        .addScaledVector(tangentB, Math.sin(angle) * offsetDist)
        .normalize();
      const surfHut = getSurfacePoint(hutDir);
      const towardCenterRaw = villageCenter.clone().sub(hutDir);
      const towardCenter = towardCenterRaw.addScaledVector(surfHut.normal, -towardCenterRaw.dot(surfHut.normal)).normalize();
      buildHut(hutDir, towardCenter, villageSizeOrder[i]);
    }

    const SCATTERED_BUILDING_COUNT = 45;
    const sizeKeys = ["small", "small", "small", "medium", "medium", "large"];
    let scatteredBuilt = 0;
    let scatterAttempts = 0;
    while (scatteredBuilt < SCATTERED_BUILDING_COUNT && scatterAttempts < 4000) {
      scatterAttempts++;
      const d = randomDir();
      const h = terrainHeight(d);
      if (h < SEA_LEVEL + 0.4 || h > 1.5) continue;
      let tooClose = false;
      for (let i = 0; i < obstacles.length; i++) {
        if (d.angleTo(obstacles[i].dir) < obstacles[i].r + 5 / PLANET_R) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      const facingTangent = randomDir();
      const surfB = getSurfacePoint(d);
      const projTangent = facingTangent.addScaledVector(surfB.normal, -facingTangent.dot(surfB.normal)).normalize();
      buildHut(d, projTangent, sizeKeys[Math.floor(rand() * sizeKeys.length)]);
      scatteredBuilt++;
    }

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
    buildRoad(findLandSpawn(), villageCenter, 28);

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

    // Real character (Anne). Native height ~1.81m, feet 0.18 below her origin; the group is
    // scaled 1.15, so this scale brings her to ~1.7m in the world. Procedural rig stays as fallback.
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
    loadModel("/models/characters/Characters_Anne.gltf").then((gltf) => {
      if (!gltf) return; // keep the procedural character
      const model = gltf.scene;
      const s = 1.7 / (1.81 * 1.15);
      model.scale.setScalar(s);
      model.position.y = 0.18 * s;
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
        setAction(idleAction, 0);
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
    let charDir = findLandSpawn();
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

    const pointers = new Map();
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
      const max = 55;
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

    // ---------- Animation loop ----------
    const clock = new THREE.Clock();
    const dayColorTmp = new THREE.Color();
    const duskColorTmp = new THREE.Color();
    let walkPhase = 0;
    let walkAmp = 0;
    let raf;
    function animate() {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());
      const t = clock.elapsedTime;
      quality.sample(dt, t);
      if (mixer) mixer.update(dt);

      const DAY_CYCLE_SECONDS = 900;
      const dayPhase = (t % DAY_CYCLE_SECONDS) / DAY_CYCLE_SECONDS;
      const sunAngle = dayPhase * Math.PI * 2;
      const sunHeight = Math.sin(sunAngle);
      sun.position.set(Math.cos(sunAngle) * PLANET_R * 3, Math.max(sunHeight, -0.15) * PLANET_R * 2.2 + PLANET_R * 0.4, Math.sin(sunAngle) * PLANET_R * 1.3);
      const dayFactor = smoothstep(-0.22, 0.3, sunHeight);
      const duskFactor = Math.max(0, 1 - Math.abs(sunHeight) * 2.6);
      sun.intensity = 0.4 + dayFactor * 0.8;
      sun.color.set("#7a8ab0").lerp(dayColorTmp.set("#fff3da"), dayFactor).lerp(duskColorTmp.set("#ff9a5c"), duskFactor * 0.55);
      hemi.intensity = 0.55 + dayFactor * 0.55;
      hemi.color.set("#4a5578").lerp(dayColorTmp.set("#dfe8e6"), dayFactor);
      skyMat.color.set("#3a4568").lerp(dayColorTmp.set("#ffffff"), dayFactor).lerp(duskColorTmp.set("#ffb27a"), duskFactor * 0.45);
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



      facing.addScaledVector(charDir, -facing.dot(charDir)).normalize();
      let lookX = lookJoy.dx;
      let lookY = lookJoy.dy;
      if (keys.left) lookX -= 1;
      if (keys.right) lookX += 1;
      if (keys.up) lookY -= 1;
      if (keys.down) lookY += 1;
      if (Math.abs(lookX) > 0.03) facing.applyAxisAngle(charDir, -lookX * 2.2 * dt);
      camPitch = Math.max(0.15, Math.min(1.2, camPitch + lookY * 1.6 * dt));
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
      if (mlen > DEAD_ZONE) {
        const nx = mx / Math.max(mlen, 1);
        const ny = my / Math.max(mlen, 1);
        const inputMag = Math.min(1, mlen);
        const moveDir = new THREE.Vector3().addScaledVector(facing, -ny).addScaledVector(right, nx);
        if (moveDir.lengthSq() > 0.0001) {
          moveDir.normalize();
          charFacing.lerp(moveDir, Math.min(1, dt * 6 * inputMag)).addScaledVector(charDir, -charFacing.dot(charDir)).normalize();
          const base = charDir.clone().multiplyScalar(groundRadiusAt(charDir) + jumpHeight);
          const attempts = [moveDir, new THREE.Vector3().addScaledVector(facing, -ny).normalize(), new THREE.Vector3().addScaledVector(right, nx).normalize()];
          for (const attempt of attempts) {
            if (attempt.lengthSq() < 0.0001) continue;
            const candidateDir = base.clone().addScaledVector(attempt, MOVE_SPEED * dt * inputMag).normalize();
            if (!isBlocked(candidateDir) && terrainHeight(candidateDir) > SEA_LEVEL - 0.35) {
              charDir = candidateDir;
              moving = true;
              break;
            }
          }
        }
      }
      charFacing.addScaledVector(charDir, -charFacing.dot(charDir)).normalize();

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

      const groundR = groundRadiusAt(charDir);
      const charPos = charDir.clone().multiplyScalar(groundR + jumpHeight);
      character.position.copy(charPos);
      character.up.copy(charDir);
      character.lookAt(charPos.clone().add(charFacing));
      blob.position.copy(charDir.clone().multiplyScalar(groundR + 0.02));
      blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), charDir);
      blob.scale.setScalar(Math.max(0.4, 1 - jumpHeight * 0.25));

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

      const camDist = 6.5;
      const behind = facing.clone().multiplyScalar(-Math.cos(camPitch) * camDist);
      const above = charDir.clone().multiplyScalar(Math.sin(camPitch) * camDist + 1.4);
      const desiredCamPos = charPos.clone().add(behind).add(above);
      camera.position.lerp(desiredCamPos, Math.min(1, dt * 8));
      camera.up.lerp(charDir, Math.min(1, dt * 8)).normalize();
      camera.lookAt(charPos.clone().addScaledVector(charDir, 1.0));

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
      mount.removeChild(moveVisual.base);
      mount.removeChild(moveVisual.nub);
      mount.removeChild(lookVisual.base);
      mount.removeChild(lookVisual.nub);
      mount.removeChild(jumpBtn);
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
          Trascina a sinistra per muoverti — la telecamera segue da sola
        </div>
      )}
    </div>
  );
}
