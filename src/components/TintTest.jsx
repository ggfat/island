import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadModel } from "../lib/assetLoader.js";
import { PLAYER_TINTS, applyPlayerTint } from "../lib/characterTint.js";

// Cambia questo per testare la tinta su un altro personaggio del roster.
const TEST_MODEL = "/models/characters/Characters_Anne.gltf";

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

export default function TintTest() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#cfe0dd");

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 3.2, 10);
    camera.lookAt(0, 1, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x556055, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(5, 8, 6);
    sun.castShadow = true;
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 6),
      new THREE.MeshToonMaterial({ color: "#8ea37c", gradientMap: makeToonGradient() })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const gradientMap = makeToonGradient();

    loadModel(TEST_MODEL).then((gltf) => {
      if (!gltf) {
        console.warn(`Modello non trovato: ${TEST_MODEL}. Controlla il percorso in public/models/characters/.`);
        return;
      }
      const spacing = 1.7;
      const startX = -((PLAYER_TINTS.length - 1) * spacing) / 2;
      PLAYER_TINTS.forEach((tint, i) => {
        const model = SkeletonUtils.clone(gltf.scene);
        applyPlayerTint(model, tint, gradientMap);
        model.traverse((o) => {
          if (o.isMesh) o.castShadow = true;
        });
        model.position.set(startX + i * spacing, 0, 0);
        scene.add(model);
      });
    });

    let raf;
    function animate() {
      raf = requestAnimationFrame(animate);
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
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100vh", background: "#cfe0dd" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          background: "rgba(0,0,0,0.5)",
          color: "#fff",
          padding: "6px 10px",
          borderRadius: 6,
        }}
      >
        Test tinta colore — {PLAYER_TINTS.length} varianti dello stesso personaggio
      </div>
    </div>
  );
}
