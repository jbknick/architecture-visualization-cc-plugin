// Life in the landscape: traffic on the roads and the streets, people on the plazas and pavements, a windmill in
// every village, smoke from chimneys, cranes over the cities, blinking lights on the metropolis towers. All of it is
// instanced and driven by one clock `t`, so a paused scene is simply a scene at a fixed time.
import * as THREE from "three";
import type { BuiltBuildings } from "./buildings3d.ts";
import { Y } from "./ground.ts";
import {
  carGeometry,
  carLightsGeometry,
  craneJib,
  craneMast,
  truckGeometry,
  windmillSails,
  windmillTower,
} from "./kit.ts";
import { color, type Look, mix, wsColor } from "./look.ts";
import type { Landscape } from "./model.ts";
import { makePath, type Path, type Pt, sampleAt } from "./path.ts";
import { hash01, rngFor } from "./rng.ts";
import type { Tier } from "./tiers.ts";
import { planTraffic, type Vehicle } from "./traffic.ts";

/** Street traffic per world unit of street, per direction, by tier. */
const STREET_DENSITY: Record<Tier, number> = { village: 0, town: 0.03, city: 0.045, metropolis: 0.07 };
const PEOPLE: Record<Tier, number> = { village: 5, town: 12, city: 18, metropolis: 26 };

interface Mover {
  path: Path;
  phase: number;
  speed: number;
  offset: number;
  y: number;
  scale: number;
}

export interface LifeCounts {
  roadVehicles: number;
  streetVehicles: number;
  people: number;
  windmills: number;
  cranes: number;
  smoke: number;
  beacons: number;
}

export interface Life {
  group: THREE.Group;
  counts: LifeCounts;
  /** Road vehicles (for tests and the perf probe). */
  vehicles: Vehicle[];
  update(t: number): void;
  dispose(): void;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, n: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  m.count = n;
  // These instances move every frame: a bounding sphere computed once would cull them wrongly.
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}

export function buildLife(land: Landscape, look: Look, built: BuiltBuildings): Life {
  const group = new THREE.Group();
  const m4Static = new THREE.Matrix4();
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const lambert = () => keep(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const paints = look.paints.map(color);

  // --- Vehicles: roads between settlements, then streets inside them. -----------------------------------------------
  const vehicles = planTraffic(land.roads);
  const roadClassScale = { lane: 0.55, road: 0.72, highway: 0.8 } as const;
  const cars: Mover[] = [];
  const trucks: Mover[] = [];
  const carPaint: THREE.Color[] = [];
  const truckPaint: THREE.Color[] = [];
  for (const v of vehicles) {
    const road = land.roads[v.road];
    if (!road) continue;
    const m: Mover = {
      path: v.path,
      phase: v.phase,
      speed: v.speed,
      offset: v.offset,
      y: Y.mark,
      scale: roadClassScale[road.cls],
    };
    const paint = paints[Math.floor(v.paint * paints.length) % paints.length] as THREE.Color;
    if (v.kind === "truck") {
      trucks.push(m);
      truckPaint.push(paint);
    } else {
      cars.push(m);
      carPaint.push(v.kind === "van" ? color(look.night ? "#dee2e6" : "#f1f3f5") : paint);
    }
  }
  let streetVehicles = 0;
  const people: Mover[] = [];
  const peopleCol: THREE.Color[] = [];
  const peoplePal = look.people.map(color);
  for (const s of land.settlements) {
    const rnd = rngFor(`life:${s.id}`);
    const dens = STREET_DENSITY[s.tier];
    for (const st of s.plan.streets) {
      const pts = st.pts.map((q) => [s.x + q[0], s.z + q[1]] as Pt);
      const closed = st.kind === "ring";
      const fwd = makePath(pts, closed);
      const back = makePath([...pts].reverse(), closed);
      // Village lanes get the odd cart; streets get traffic both ways.
      const n =
        s.tier === "village" ? (rnd() < 0.5 ? 1 : 0) : Math.round(fwd.length * dens * (closed ? 1 : 0.7));
      for (const [dir, path] of [
        [0, fwd],
        [1, back],
      ] as const) {
        for (let k = 0; k < n; k++) {
          if (s.tier === "village" && dir === 1) continue;
          cars.push({
            path,
            phase: ((k + rnd() * 0.5) / Math.max(1, n)) * path.length,
            speed: (s.tier === "metropolis" ? 1.5 : 1.2) * (0.8 + rnd() * 0.4),
            offset: st.width * 0.24,
            y: Y.street + 0.02,
            scale: s.tier === "village" ? 0.42 : 0.52,
          });
          carPaint.push(paints[Math.floor(rnd() * paints.length)] as THREE.Color);
          streetVehicles++;
        }
      }
      // People on the pavements.
      if (rnd() < 0.7) {
        const walkers = Math.max(1, Math.round((PEOPLE[s.tier] * fwd.length) / Math.max(30, s.clear * 6)));
        for (let k = 0; k < walkers; k++) {
          const path = rnd() < 0.5 ? fwd : back;
          people.push({
            path,
            phase: rnd() * path.length,
            speed: 0.25 + rnd() * 0.2,
            offset: st.width / 2 + 0.16,
            y: Y.street,
            scale: 1,
          });
          peopleCol.push(peoplePal[Math.floor(rnd() * peoplePal.length)] as THREE.Color);
        }
      }
    }
    // People strolling round the plaza.
    const plaza = makePath(
      Array.from({ length: 25 }, (_, i) => {
        const a = (i / 24) * Math.PI * 2;
        const r = s.plan.plaza * 0.78;
        return [s.x + Math.cos(a) * r, s.z + Math.sin(a) * r] as Pt;
      }),
      true,
    );
    for (let k = 0; k < Math.ceil(PEOPLE[s.tier] / 3); k++) {
      people.push({
        path: plaza,
        phase: rnd() * plaza.length,
        speed: (rnd() < 0.5 ? 1 : -1) * (0.15 + rnd() * 0.15),
        offset: (rnd() - 0.5) * 0.8,
        y: Y.plaza,
        scale: 1,
      });
      peopleCol.push(peoplePal[Math.floor(rnd() * peoplePal.length)] as THREE.Color);
    }
  }
  const carMesh = instanced(keep(carGeometry()), lambert(), cars.length);
  const truckMesh = instanced(keep(truckGeometry()), lambert(), trucks.length);
  carPaint.forEach((c, i) => {
    carMesh.setColorAt(i, c);
  });
  truckPaint.forEach((c, i) => {
    truckMesh.setColorAt(i, c);
  });
  for (const m of [carMesh, truckMesh]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  const lightGeo = keep(carLightsGeometry());
  const lightMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const carLights = instanced(lightGeo, lightMat, cars.length);
  const truckLights = instanced(lightGeo, lightMat, trucks.length);
  carLights.visible = truckLights.visible = look.night;
  const personGeo = keep(new THREE.CylinderGeometry(0.07, 0.07, 0.32, 5));
  personGeo.translate(0, 0.16, 0);
  const personMesh = instanced(personGeo, lambert(), people.length);
  peopleCol.forEach((c, i) => {
    personMesh.setColorAt(i, c);
  });
  if (personMesh.instanceColor) personMesh.instanceColor.needsUpdate = true;
  group.add(carMesh, truckMesh, carLights, truckLights, personMesh);
  carMesh.castShadow = truckMesh.castShadow = false;

  // --- Windmills on the village greens. --------------------------------------------------------------------------------
  const villages = land.settlements.filter((s) => s.tier === "village");
  const millTower = new THREE.InstancedMesh(keep(windmillTower()), lambert(), Math.max(1, villages.length));
  millTower.count = villages.length;
  const sails = instanced(keep(windmillSails()), lambert(), villages.length);
  const millFrames: THREE.Matrix4[] = [];
  villages.forEach((s, i) => {
    const k = Math.min(1, Math.max(0.65, s.plan.plaza / 2.2)) * 0.9;
    const yaw = hash01(`mill:${s.id}`) * Math.PI * 2;
    const at = new THREE.Vector3(s.x - s.plan.plaza * 0.35, 0, s.z + s.plan.plaza * 0.3);
    const m = new THREE.Matrix4()
      .makeRotationY(yaw)
      .scale(new THREE.Vector3(k, k, k))
      .setPosition(at);
    millTower.setMatrixAt(i, m);
    millTower.setColorAt(i, color(look.walls.village));
    // Sails turn on the front of the cap.
    millFrames.push(m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 2.3, 0.5)));
    sails.setColorAt(i, mix(wsColor(s.colorIndex, look), "#ffffff", 0.55));
  });
  millTower.instanceMatrix.needsUpdate = true;
  if (millTower.instanceColor) millTower.instanceColor.needsUpdate = true;
  if (sails.instanceColor) sails.instanceColor.needsUpdate = true;
  millTower.computeBoundingSphere();
  millTower.castShadow = true;
  group.add(millTower, sails);

  // --- Cranes over the cities and the metropolis. ------------------------------------------------------------------------
  const craneSpots: { m: THREE.Matrix4; phase: number; speed: number }[] = [];
  for (const s of land.settlements) {
    if (s.tier !== "city" && s.tier !== "metropolis") continue;
    const n = s.tier === "metropolis" ? 3 : 2;
    const outer = s.buildings
      .map((bi) => land.buildings[bi])
      .filter((b): b is NonNullable<typeof b> => !!b && (b.arch === "block" || b.arch === "house"));
    for (let k = 0; k < n && outer.length > 0; k++) {
      const b = outer[Math.floor(hash01(`crane:${s.id}:${k}`) * outer.length)];
      if (!b) continue;
      // Behind the building (rows stand back to back), on its own small yard.
      const back = new THREE.Vector3(0, 0, -(b.d / 2 + 0.25)).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        b.rot,
      );
      const sc = s.tier === "metropolis" ? 1.5 : 1.05;
      craneSpots.push({
        m: new THREE.Matrix4().makeScale(sc, sc, sc).setPosition(b.x + back.x, 0, b.z + back.z),
        phase: hash01(`crane-p:${s.id}:${k}`) * Math.PI * 2,
        speed: 0.12 + hash01(`crane-s:${s.id}:${k}`) * 0.12,
      });
    }
  }
  const craneCol = color(look.night ? "#e8b730" : "#f2b705");
  const mast = new THREE.InstancedMesh(keep(craneMast()), lambert(), Math.max(1, craneSpots.length));
  mast.count = craneSpots.length;
  const jib = instanced(keep(craneJib()), lambert(), craneSpots.length);
  craneSpots.forEach((c, i) => {
    mast.setMatrixAt(i, c.m);
    mast.setColorAt(i, craneCol);
    jib.setColorAt(i, craneCol);
  });
  mast.instanceMatrix.needsUpdate = true;
  for (const m of [mast, jib]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  mast.computeBoundingSphere();
  mast.castShadow = jib.castShadow = true;
  group.add(mast, jib);

  // --- Smoke from chimneys. --------------------------------------------------------------------------------------------
  const chimneys = built.chimneys.slice(0, 90);
  const PUFFS = 4;
  const smoke = instanced(
    keep(new THREE.IcosahedronGeometry(0.16, 0)),
    keep(
      new THREE.MeshLambertMaterial({
        color: look.night ? 0x5c6370 : 0xf1f3f5,
        transparent: true,
        opacity: 0.8,
      }),
    ),
    chimneys.length * PUFFS,
  );

  // --- Aviation lights on the tallest towers. --------------------------------------------------------------------------
  const beacons = built.beacons;
  const beaconMesh = instanced(
    keep(new THREE.SphereGeometry(0.16, 8, 6)),
    keep(new THREE.MeshBasicMaterial({ color: 0xff3b30 })),
    beacons.length,
  );
  group.add(smoke, beaconMesh);

  // --- Street lights (night only): they draw the roads and streets as lines of lamps. -----------------------------------
  if (look.night) {
    const lamps: THREE.Vector3[] = [];
    const along = (pts: Pt[], step: number, offsets: number[], closed: boolean) => {
      const path = makePath(pts, closed);
      for (let s = step / 2; s < path.length && lamps.length < 3000; s += step)
        for (const o of offsets) {
          const p = sampleAt(path, s, o);
          lamps.push(new THREE.Vector3(p.x, 0.9, p.z));
        }
    };
    for (const r of land.roads)
      if (!r.declaredOnly && r.cls !== "lane")
        along(r.pts, r.cls === "highway" ? 2.6 : 3.2, [r.width / 2 + 0.2, -(r.width / 2 + 0.2)], false);
    for (const s of land.settlements) {
      if (s.tier === "village") continue;
      for (const st of s.plan.streets)
        along(
          st.pts.map((q) => [s.x + q[0], s.z + q[1]] as Pt),
          s.tier === "town" ? 2.4 : 3.2,
          [st.width / 2 + 0.12],
          st.kind === "ring",
        );
    }
    const lampMesh = new THREE.InstancedMesh(
      keep(new THREE.SphereGeometry(0.085, 6, 4)),
      keep(new THREE.MeshBasicMaterial({ color: 0xffd58a })),
      Math.max(1, lamps.length),
    );
    lampMesh.count = lamps.length;
    lamps.forEach((p, i) => {
      lampMesh.setMatrixAt(i, m4Static.makeTranslation(p.x, p.y, p.z));
    });
    lampMesh.instanceMatrix.needsUpdate = true;
    lampMesh.computeBoundingSphere();
    group.add(lampMesh);
    disposables.push(lampMesh);
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const place = (mesh: THREE.InstancedMesh, lights: THREE.InstancedMesh | null, list: Mover[], t: number) => {
    list.forEach((v, i) => {
      const smp = sampleAt(v.path, v.phase + v.speed * t, v.offset);
      const dirSign = v.speed < 0 ? -1 : 1;
      q.setFromAxisAngle(up, Math.atan2(smp.dx * dirSign, smp.dz * dirSign));
      pos.set(smp.x, v.y, smp.z);
      scl.setScalar(v.scale);
      m4.compose(pos, q, scl);
      mesh.setMatrixAt(i, m4);
      lights?.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (lights) lights.instanceMatrix.needsUpdate = true;
  };

  const update = (t: number) => {
    place(carMesh, carLights, cars, t);
    place(truckMesh, truckLights, trucks, t);
    place(personMesh, null, people, t);
    millFrames.forEach((f, i) => {
      q.setFromAxisAngle(zAxis, t * 0.9 + i);
      m4.compose(pos.set(0, 0, 0), q, scl.setScalar(1));
      sails.setMatrixAt(i, f.clone().multiply(m4));
    });
    sails.instanceMatrix.needsUpdate = true;
    craneSpots.forEach((c, i) => {
      q.setFromAxisAngle(up, c.phase + Math.sin(t * c.speed) * 1.6);
      const local = new THREE.Matrix4().compose(pos.set(0, 6.9, 0), q, scl.setScalar(1));
      jib.setMatrixAt(i, c.m.clone().multiply(local));
    });
    jib.instanceMatrix.needsUpdate = true;
    chimneys.forEach((c, i) => {
      for (let k = 0; k < PUFFS; k++) {
        const age = (t * 0.35 + k / PUFFS + hash01(`puff:${i}`)) % 1;
        pos.set(c.x + age * 0.5, c.y + age * 1.6, c.z + age * 0.25);
        scl.setScalar(0.5 + age * 1.6 * (1 - age * 0.6));
        m4.compose(pos, q.identity(), scl);
        smoke.setMatrixAt(i * PUFFS + k, m4);
      }
    });
    smoke.instanceMatrix.needsUpdate = true;
    beacons.forEach((b, i) => {
      const on = Math.sin(t * 3.2 + i * 0.7) > 0.2 ? 1 : 0.001;
      m4.compose(pos.set(b.x, b.y + 0.15, b.z), q.identity(), scl.setScalar(on));
      beaconMesh.setMatrixAt(i, m4);
    });
    beaconMesh.instanceMatrix.needsUpdate = true;
  };
  update(0);

  return {
    group,
    vehicles,
    counts: {
      roadVehicles: vehicles.length,
      streetVehicles,
      people: people.length,
      windmills: villages.length,
      cranes: craneSpots.length,
      smoke: chimneys.length,
      beacons: beacons.length,
    },
    update,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const m of [
        carMesh,
        truckMesh,
        carLights,
        truckLights,
        personMesh,
        millTower,
        sails,
        mast,
        jib,
        smoke,
        beaconMesh,
      ])
        m.dispose();
    },
  };
}
