// Luoghi speciali costruiti con modelli veri (Pirate Kit, Fantasy Props, Stylized Nature, Ultimate Space Kit, Kenney).
// Ogni luogo: [nome, build(g) => update(act, t)]. act va da 0 (spento) a 1 (attivato da due giocatori).
// I modelli arrivano in modo asincrono: build() li aggiunge appena caricati, update() li anima quando ci sono.

export function makePlaceBuilders({ THREE, loadToon, biome }) {
  const P = "/models/places/";
  const SPC = "/models/space/";
  const glow = (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthWrite: o >= 1 });

  // aggiunge un modello al gruppo; ritorna un "segnaposto" Group subito disponibile (il modello entra dentro quando carica)
  function M(g, path, x, z, rot = 0, s = 1, y = 0) {
    const holder = new THREE.Group();
    holder.position.set(x, y, z);
    holder.rotation.y = rot;
    holder.scale.setScalar(s);
    g.add(holder);
    loadToon(path).then((src) => { if (src) holder.add(src.clone()); });
    return holder;
  }
  // luce puntiforme finta: sfera luminosa + alone
  function lightBall(g, color, r, x, y, z) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), glow(color));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(r * 2.6, 12, 10), glow(color, 0.25));
    core.position.set(x, y, z); halo.position.copy(core.position);
    g.add(core, halo);
    return { core, halo, set(k) { core.scale.setScalar(Math.max(0.001, k)); halo.scale.setScalar(Math.max(0.001, k)); core.visible = halo.visible = k > 0.02; } };
  }
  // particelle che salgono (scintille, petali, bolle)
  function rising(g, n, color, size, area, height, speed) {
    const ps = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5), glow(color));
      m.visible = false; g.add(m);
      ps.push({ m, a: Math.random() * 6.283, r: Math.random() * area.r, ph: Math.random(), x0: area.x || 0, z0: area.z || 0, y0: area.y || 0 });
    }
    return (act, t) => ps.forEach((p) => {
      const u = (t * speed + p.ph) % 1;
      p.m.visible = act > 0.05;
      p.m.position.set(p.x0 + Math.cos(p.a + u * 2) * p.r, p.y0 + u * height, p.z0 + Math.sin(p.a + u * 2) * p.r);
      p.m.scale.setScalar(act * (1 - u) + 0.001);
    });
  }
  const ease = (k) => k * k * (3 - 2 * k);

  const temperate = [
    ["Tesoro del capitano", (g) => {
      M(g, P + "RockPath_Round_Wide.gltf", 0, 0, 0, 1.6);
      const closed = M(g, P + "Prop_Chest_Closed.gltf", 0, 0, 0, 1.2);
      const open = M(g, P + "Prop_Chest_Gold.gltf", 0, 0, 0, 1.0);
      open.visible = false;
      M(g, P + "Prop_Coins.gltf", 1.0, 0.6, 0.6); M(g, P + "Prop_GoldBag.gltf", -1.1, 0.5, -0.4);
      M(g, P + "Prop_Cannon.gltf", -1.9, -1.2, Math.PI * 0.8, 1, 0.47); M(g, P + "Prop_Cannon.gltf", 1.9, -1.2, -Math.PI * 0.8, 1, 0.47);
      M(g, P + "Prop_Skull.gltf", 0.9, -1.1, 0.4, 0.8, 0.2); M(g, P + "Prop_Anchor.gltf", -0.8, 1.5, 0.7, 1.3);
      const shine = lightBall(g, "#ffe27a", 0.25, 0, 1.2, 0);
      const sparks = rising(g, 14, "#ffe9a0", 0.06, { r: 0.6, y: 0.9 }, 2.4, 0.5);
      return (act, t) => {
        closed.visible = act < 0.5; open.visible = act >= 0.5;
        shine.set(act * (0.8 + 0.2 * Math.sin(t * 4)));
        sparks(act, t);
      };
    }],
    ["Fucina", (g) => {
      g = (() => { const s = new THREE.Group(); s.scale.setScalar(1.25); g.add(s); return s; })();
      M(g, P + "Anvil.gltf", 0, 0.2, 0, 1.2, 0.0);
      M(g, P + "Workbench.gltf", 0, -1.5, 0, 1);
      M(g, P + "WeaponStand.gltf", 1.8, -0.3, -Math.PI / 2, 1);
      M(g, P + "Sword_Bronze.gltf", 1.8, -0.1, -Math.PI / 2, 1, 0.75);
      M(g, P + "Shield_Wooden.gltf", -1.7, -0.9, 1.1, 1, 0.0);
      M(g, P + "Prop_Barrel.gltf", -1.8, 0.6, 0, 1.1); M(g, P + "Bucket_Wooden_1.gltf", 0.9, 1.1, 0.4);
      M(g, P + "Pickaxe_Bronze.gltf", -0.4, -1.5, 0.3, 1, 0.9); M(g, P + "Axe_Bronze.gltf", 0.5, -1.5, -0.2, 1, 0.9);
      const torches = [[-1.4, 1.5], [1.4, 1.5]].map(([x, z]) => {
        M(g, P + "Environment_Dock_Pole.gltf", x, z, 0, 0.7, 1.4);
        M(g, P + "Torch_Metal.gltf", x, z + 0.18, 0, 1.2, 1.8);
        return lightBall(g, "#ff9a3c", 0.12, x, 2.25, z + 0.3);
      });
      const sparks = rising(g, 16, "#ffb347", 0.04, { r: 0.35, y: 0.75 }, 1.4, 1.4);
      return (act, t) => {
        torches.forEach((tb, i) => tb.set(act * (0.85 + 0.15 * Math.sin(t * 13 + i * 2))));
        sparks(act, t);
      };
    }],
    ["Mercato", (g) => {
      M(g, P + "Stall_Empty.gltf", -1.2, -0.9, 0.35, 1);
      M(g, P + "Stall_Cart_Empty.gltf", 1.3, -0.8, -0.35, 0.9);
      const empties = [], fulls = [];
      [[-1.6, 0.6, "FarmCrate_Apple"], [-0.6, 0.9, "FarmCrate_Carrot"], [0.6, 0.9, "FarmCrate_Apple"], [1.6, 0.6, "FarmCrate_Carrot"]].forEach(([x, z, full], i) => {
        empties.push(M(g, P + "FarmCrate_Empty.gltf", x, z, i * 0.3, 1.4));
        const f = M(g, P + full + ".gltf", x, z, i * 0.3, 1.4); f.visible = false; fulls.push(f);
      });
      M(g, P + "Prop_Barrel.gltf", -2.4, -0.2, 0, 1); M(g, P + "Prop_Bucket_Fishes.gltf", 2.4, 0.1, 0.6, 0.9);
      const banner = M(g, P + "Banner_2.gltf", 0, -2.0, 0, 1, 2.4);
      M(g, P + "Environment_Dock_Pole.gltf", 0.75, -2.05, 0, 0.9, 1.8);
      const lamp = lightBall(g, "#ffd98a", 0.14, 0.1, 2.0, -1.6);
      return (act, t) => {
        const on = act > 0.4;
        empties.forEach((e) => (e.visible = !on)); fulls.forEach((f) => (f.visible = on));
        banner.rotation.z = Math.sin(t * 1.6) * 0.04 * act;
        lamp.set(act);
      };
    }],
    ["Giardino fiorito", (g) => {
      M(g, P + "RockPath_Round_Wide.gltf", 0, 0, 0.5, 1.5);
      M(g, P + "Bush_Common_Flowers.gltf", -1.9, -1.0, 0, 0.9); M(g, P + "Bush_Common_Flowers.gltf", 1.9, -1.1, 2, 0.8);
      M(g, P + "Mushroom_Laetiporus.gltf", 1.6, 1.4, 1, 0.7); M(g, P + "Mushroom_Common.gltf", -1.5, 1.5, 0, 1.1);
      M(g, P + "Fern_1.gltf", -2.3, 0.6, 0, 1); M(g, P + "Clover_1.gltf", 0.4, 2.0, 0, 1.2);
      const blooms = [[0, -1.6, "Flower_4_Group"], [-0.9, 1.1, "Flower_3_Group"], [0.9, 1.0, "Flower_3_Group"], [1.2, -0.3, "Flower_4_Group"], [-1.3, -0.2, "Flower_3_Group"]]
        .map(([x, z, n], i) => M(g, P + n + ".gltf", x, z, i, 0.6));
      const petals = rising(g, 18, "#ffc0e0", 0.05, { r: 1.8, y: 0.4 }, 2.2, 0.25);
      return (act, t) => {
        blooms.forEach((b, i) => b.scale.setScalar(0.25 + 0.6 * ease(act) + Math.sin(t * 1.5 + i) * 0.02 * act));
        petals(act, t);
      };
    }],
    ["Laboratorio delle pozioni", (g) => {
      M(g, "/models/props/Cauldron.gltf", 0, 0, 0, 1.2);
      M(g, P + "Shelf_Arch.gltf", 0, -1.8, 0, 1.2, 0.73);
      [[-0.4, "Potion_1"], [0, "Potion_2"], [0.4, "Potion_4"]].forEach(([x, n]) => M(g, P + n + ".gltf", x, -1.75, 0, 2.2, 1.12));
      M(g, P + "CandleStick_Stand.gltf", -1.6, -1.0, 0, 1); M(g, P + "CandleStick_Stand.gltf", 1.6, -1.0, 0, 1);
      M(g, P + "BookGroup_Medium_1.gltf", 1.5, 0.9, 0.7, 1.4); M(g, P + "Vase_4.gltf", -1.6, 0.9, 0, 1.2);
      const brew = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 18), glow("#6b4a8f"));
      brew.position.y = 0.72; g.add(brew);
      const flames = [[-1.6, -1.0], [1.6, -1.0]].map(([x, z]) => lightBall(g, "#ffd27a", 0.07, x, 1.38, z));
      const bubbles = rising(g, 14, "#9dff9a", 0.07, { r: 0.3, y: 0.75 }, 1.6, 0.6);
      return (act, t) => {
        brew.material.color.set("#4a3a5a").lerp(new THREE.Color("#7dff8a"), act);
        flames.forEach((f, i) => f.set(act * (0.8 + 0.2 * Math.sin(t * 9 + i))));
        bubbles(act, t);
      };
    }],
    ["Cantiere navale", (g) => {
      // lo scafo in costruzione: lo scheletro della barca con le assi che arrivano quando si attiva
      const ribs = M(g, P + "Environment_LargeBones.gltf", 0, 0, Math.PI / 2, 0.55, 0.15);
      loadToon(P + "Environment_LargeBones.gltf").then((s) => s && s.traverse((o) => { if (o.isMesh && !o.userData.wood) { o.userData.wood = true; o.material = o.material.clone(); o.material.color.set("#9a6b43"); o.material.map = null; } }));
      M(g, P + "Environment_Sawmill.gltf", -2.3, 1.2, 0.4, 1);
      M(g, P + "Workbench.gltf", 2.2, 1.3, -0.3, 0.9);
      M(g, P + "Axe_Bronze.gltf", 2.0, 1.3, 0.5, 1, 0.8); M(g, P + "Prop_Bucket.gltf", 2.6, -1.4, 0, 1);
      const plankMat = new THREE.MeshToonMaterial({ color: "#b07a48" });
      const planks = [];
      for (let i = 0; i < 9; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.08, 0.28), plankMat);
        const a = -1.15 + (i / 8) * 2.3; // giro lungo la sezione dello scafo
        p.position.set(0, 0.35 + Math.cos(a) * 0.95 * 0.0 + (1 - Math.cos(a)) * 0.9, Math.sin(a) * 1.2);
        p.rotation.x = a;
        p.visible = false; g.add(p); planks.push(p);
      }
      const dust = rising(g, 10, "#e8d3a8", 0.05, { r: 0.4, x: -2.3, z: 1.2, y: 0.4 }, 1.2, 0.7);
      // a lavoro finito, al posto dello scheletro compare la barca vera
      const boat = new THREE.Group(); g.add(boat);
      loadToon(P + "Ship_Small.gltf").then((src) => {
        if (!src) return;
        const m = src.clone();
        const bb = new THREE.Box3().setFromObject(m);
        const k = 3.6 / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
        m.scale.setScalar(k);
        m.position.set(-(bb.min.x + bb.max.x) / 2 * k, -bb.min.y * k + 0.25, -(bb.min.z + bb.max.z) / 2 * k);
        boat.add(m);
      });
      return (act, t) => {
        const k = ease(Math.max(0, Math.min(1, (act - 0.45) / 0.55)));
        ribs.visible = k < 0.5;
        boat.visible = k > 0.02;
        boat.scale.setScalar(Math.max(0.001, k));
        planks.forEach((p) => (p.visible = false));
        dust(act, t);
      };
    }],
  ];

  const alien = [
    ["Navicella", (g) => {
      const ship = M(g, SPC + "Spaceship_FinnTheFrog.gltf", 0, 0, 0.4, 0.55, 0.0);
      M(g, SPC + "Pickup_Crate.gltf", 2.0, 1.2, 0.3, 1); M(g, SPC + "Pickup_Crate.gltf", 2.4, 0.4, 1.1, 0.8);
      const engine = lightBall(g, "#7fe0ff", 0.25, 0, 0.6, -1.6);
      return (act, t) => {
        ship.position.y = ease(act) * (1.2 + Math.sin(t * 1.4) * 0.15);
        engine.core.position.y = engine.halo.position.y = ship.position.y + 0.5;
        engine.set(act * (0.8 + 0.2 * Math.sin(t * 20)));
      };
    }],
    ["Radar", (g) => {
      const dish = M(g, SPC + "satelliteDish_large.glb", 0, 0, 0, 1.6);
      M(g, SPC + "Roof_Radar.gltf", -1.8, 1.0, 0.5, 1); M(g, SPC + "Roof_Antenna.gltf", 1.8, 1.0, 0, 1);
      const rings = [0, 1, 2].map(() => { const r = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 6, 40), glow("#7fe0ff", 0.6)); r.rotation.x = Math.PI / 2; r.visible = false; g.add(r); return r; });
      return (act, t) => {
        dish.rotation.y = t * 0.6 * act;
        rings.forEach((r, i) => { const u = (t * 0.5 + i / 3) % 1; r.visible = act > 0.05; r.position.y = 2.6; r.scale.setScalar(0.2 + u * 3); r.material.opacity = (1 - u) * 0.6 * act; });
      };
    }],
    ["Pannelli solari", (g) => {
      const panels = [[-1.6, 0], [0, -0.4], [1.6, 0]].map(([x, z], i) => M(g, SPC + "SolarPanel_Ground.gltf", x, z, 0, 1));
      M(g, SPC + "MetalSupport.gltf", 0, 1.6, 0, 1);
      const cells = panels.map((p, i) => lightBall(g, "#8affc1", 0.08, [-1.6, 0, 1.6][i], 1.4, [0, -0.4, 0][i] + 0.6));
      return (act, t) => {
        panels.forEach((p, i) => (p.rotation.x = -0.4 * ease(act) + Math.sin(t + i) * 0.03 * act));
        cells.forEach((c, i) => c.set(act * (0.7 + 0.3 * Math.sin(t * 3 + i))));
      };
    }],
    ["Rover", (g) => {
      const rover = M(g, SPC + "Rover_Round.gltf", 0, 0, 0, 1);
      M(g, SPC + "Rover_1.gltf", -2.1, -1.2, 0.7, 0.8); M(g, SPC + "Pickup_Crate.gltf", 2.0, -1.4, 0.2, 1);
      const lamp = lightBall(g, "#fff3b0", 0.1, 0, 0.8, 0.9);
      return (act, t) => {
        const a = t * 0.5 * act;
        rover.position.set(Math.sin(a) * 1.2 * act, 0, Math.cos(a) * 1.2 * act - 0.0);
        rover.rotation.y = a + Math.PI / 2;
        lamp.core.position.set(rover.position.x + Math.cos(a) * 0.9, 0.8, rover.position.z - Math.sin(a) * 0.9);
        lamp.halo.position.copy(lamp.core.position);
        lamp.set(act);
      };
    }],
    ["Giardino di cristalli", (g) => {
      const crys = [[0, 0, "rock_crystalsLargeA.glb", 1.8], [-1.6, 0.9, "rock_crystals.glb", 1.6], [1.5, 1.0, "rock_crystals.glb", 1.4], [1.2, -1.4, "rock_crystalsLargeA.glb", 1.1]]
        .map(([x, z, n, s], i) => M(g, SPC + n, x, z, i, s));
      M(g, SPC + "Tree_Light_2.gltf", -1.9, -1.3, 0, 0.6); M(g, SPC + "Plant_3.gltf", 0.2, 1.9, 0, 1);
      const motes = rising(g, 16, "#ff9ad5", 0.06, { r: 1.8, y: 0.3 }, 2.6, 0.3);
      return (act, t) => {
        crys.forEach((c, i) => c.scale.setScalar([1.8, 1.6, 1.4, 1.1][i] * (0.6 + 0.4 * ease(act))));
        motes(act, t);
      };
    }],
    ["Portale", (g) => {
      M(g, SPC + "gate_complex.glb", 0, 0, 0, 2.2);
      M(g, SPC + "machine_generatorLarge.glb", 1.9, 0.9, -0.6, 1.2);
      const field = new THREE.Mesh(new THREE.CircleGeometry(0.9, 32), glow("#b58cff", 0.0));
      field.material.side = THREE.DoubleSide;
      field.position.y = 1.25; g.add(field);
      const motes = rising(g, 12, "#d9c2ff", 0.05, { r: 0.6, y: 0.5 }, 1.6, 0.6);
      return (act, t) => {
        field.material.opacity = 0.75 * ease(act) * (0.85 + 0.15 * Math.sin(t * 5));
        field.scale.setScalar(0.3 + 0.7 * ease(act));
        field.rotation.z = t;
        motes(act, t);
      };
    }],
  ];
  return biome === "alien" ? alien : temperate;
}
