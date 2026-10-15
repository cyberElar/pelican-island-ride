/**
 * bicycle.js - the vintage cruiser the pelican rides in "Pelican Island Ride".
 *
 * Local space: origin = ground contact midway between the wheels, +Z forward,
 * +Y up, +X = the rider's left. Every part is authored in bicycle-local
 * coordinates and the moving assemblies (steering pivot, wheels, crank) sit on
 * their real pivots so the game can drive them independently.
 *
 * createBicycle(ctx) -> { root, update(dt, state, anim), parts }
 *   parts: frameGroup frontWheel frontWheelGroup rearWheel rearWheelGroup
 *          handlebar crank pedals chainring flagMesh flagPole headlamp bellMesh
 *          saddle basketFront basketRear rack streamers frontFender rearFender
 *
 *   frontWheelGroup = steering assembly about the head-tube axis
 *   rearWheelGroup  = rear spin pivot (also exposed as parts.rearWheel)
 *
 * This module also hosts BIKE_DIMS and `tubeFrom`, the small geometry helpers
 * shared with pelican.js and rider.js (the character modules deliberately have
 * no separate kit file).
 */

import * as THREE from 'three';
import { clamp01, lerp, damp, TAU } from '../core/utils.js';

// ---------------------------------------------------------------------------
// Dimensions (meters, bicycle-local)
// ---------------------------------------------------------------------------

export const BIKE_DIMS = {
  wheelRadius: 0.34,
  tireTube: 0.042,
  wheelZ: { front: 0.6, rear: -0.5 },
  crank: {
    x: 0,
    y: 0.3,
    z: -0.02,
    arm: 0.17,
    pedalHalfX: 0.115,
    pedalLift: 0.06,
    gearRatio: 0.55,
    chainring: 0.105,
    sprocket: 0.048,
  },
  saddle: { top: 0.964, z: -0.27 },
  handlebar: { y: 1.008, z: 0.395 },
  head: { angle: 0.28, top: [0, 0.88, 0.4], length: 0.36 },
  steerRatio: 0.45,
  length: 1.86,
  height: 1.09,
};

const HEAD_TOP = new THREE.Vector3().fromArray(BIKE_DIMS.head.top);
const HEAD_BOTTOM = new THREE.Vector3(
  0,
  HEAD_TOP.y - BIKE_DIMS.head.length * Math.cos(BIKE_DIMS.head.angle),
  HEAD_TOP.z + BIKE_DIMS.head.length * Math.sin(BIKE_DIMS.head.angle),
);

const COL = {
  frame: 0x1f6f78,
  cream: 0xf2e8d5,
  chrome: 0xdfe4ea,
  rubber: 0x24262b,
  darkMetal: 0x3c3f45,
  leather: 0x6b4a2f,
  baguette: 0xc98f4f,
  lamp: 0xffd9a0,
  poppy: 0xe0523f,
  cornflower: 0x5b7fd4,
  mustard: 0xe8b64c,
  leaf: 0x4c7a3c,
};

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

/**
 * Tube along a Catmull-Rom path with an optional radius profile and lateral
 * squash. Ring i of a TubeGeometry sits on getPointAt(i / tubular), so rings
 * can be deformed without touching the topology.
 */
export function tubeFrom(points, {
  radius = 0.08, radial = 10, tubular = 16, profile = null, squashX = 1, tension = 0.5,
} = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', tension);
  const geo = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  if (profile || squashX !== 1) {
    const pos = geo.attributes.position;
    const stride = radial + 1;
    const c = new THREE.Vector3();
    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      curve.getPointAt(t, c);
      const rs = profile ? profile(t) : 1;
      for (let j = 0; j <= radial; j++) {
        const k = i * stride + j;
        const ox = pos.getX(k) - c.x;
        const oy = pos.getY(k) - c.y;
        const oz = pos.getZ(k) - c.z;
        pos.setXYZ(k, c.x + ox * rs * squashX, c.y + oy * rs, c.z + oz * rs);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

/** Thin tube between two points, with an optional sag in the middle. */
function strut(a, b, radius, radial = 7, sag = 0) {
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  mid.y -= sag;
  return tubeFrom([a.clone(), mid, b.clone()], { radius, radial, tubular: 6 });
}

/** Translate a geometry in place - keeps authoring in bicycle-local numbers. */
function at(geo, x, y, z) {
  geo.translate(x, y, z);
  return geo;
}

/** Rounded slab: a box whose corners are pulled towards the inscribed sphere. */
function roundedBox(w, h, d, round = 0.5, seg = 6) {
  const g = new THREE.BoxGeometry(w, h, d, seg, Math.max(2, Math.round((seg * h) / w)), seg);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
    const ex = x / (w * 0.5); const ey = y / (h * 0.5); const ez = z / (d * 0.5);
    const m = Math.hypot(ex, ey, ez);
    if (m > 1) {
      const s = lerp(1, 1 / m, round);
      pos.setXYZ(i, x * s, y * s, z * s);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Wheel
// ---------------------------------------------------------------------------

/**
 * Spoked wheel. Returns the spin group; its local frame is bicycle-aligned
 * (wheel plane = YZ, axle = X) so rotation.x rolls it forwards.
 */
function buildWheel(name, mats, radius, tireTube) {
  const spin = new THREE.Group();
  spin.name = name;
  spin.userData.radius = radius;

  const tire = new THREE.Mesh(new THREE.TorusGeometry(radius - tireTube, tireTube, 12, 26), mats.rubber);
  tire.rotation.y = Math.PI / 2;
  spin.add(tire);

  const rimR = radius - tireTube * 2.1;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.015, 8, 26), mats.chrome);
  rim.rotation.y = Math.PI / 2;
  spin.add(rim);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.08, 12), mats.chrome);
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.115, 8), mats.darkMetal);
  axle.rotation.z = Math.PI / 2;
  spin.add(axle);
  for (const sx of [1, -1]) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 12), mats.chrome);
    flange.rotation.z = Math.PI / 2;
    flange.position.x = sx * 0.032;
    spin.add(flange);
  }

  // 32 cross-laced spokes as one InstancedMesh.
  const SPOKES = 32;
  const spokeGeo = new THREE.CylinderGeometry(0.0034, 0.0034, 1, 6, 1, true);
  const spokes = new THREE.InstancedMesh(spokeGeo, mats.chrome, SPOKES);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const hubR = 0.028;
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * TAU;
    const side = i % 2 === 0 ? 1 : -1;
    const hubY = Math.cos(a) * hubR;
    const hubZ = Math.sin(a) * hubR;
    const rimA = a + side * 0.22;
    const rimY = Math.cos(rimA) * rimR;
    const rimZ = Math.sin(rimA) * rimR;
    const x0 = side * 0.032;
    const x1 = side * 0.006;
    dir.set(x1 - x0, rimY - hubY, rimZ - hubZ);
    const len = dir.length();
    dir.multiplyScalar(1 / len);
    q.setFromUnitVectors(up, dir);
    mid.set((x0 + x1) * 0.5, (hubY + rimY) * 0.5, (hubZ + rimZ) * 0.5);
    scale.set(1, len, 1);
    m4.compose(mid, q, scale);
    spokes.setMatrixAt(i, m4);
  }
  spokes.instanceMatrix.needsUpdate = true;
  spin.add(spokes);

  return spin;
}

/** Partial fender: a torus arc squashed into a curved strip. */
function fenderGeometry(arc, startAngle) {
  const g = new THREE.TorusGeometry(0.398, 0.013, 8, 22, arc);
  g.rotateZ(startAngle);
  // Widen the tube along its own axis first, then lay the ring into the wheel
  // plane: the strip ends up wide across the axle and thin radially.
  g.scale(1, 1, 2.3);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Open wicker basket: base, four walls, rim. */
function buildBasket(parent, mats, w, h, d, t) {
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, t * 1.4, d), mats.wicker);
  base.position.y = t * 0.7;
  parent.add(base);
  for (const sx of [1, -1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(t, h, d), mats.wicker);
    wall.position.set(sx * (w * 0.5 - t * 0.5), h * 0.5, 0);
    parent.add(wall);
  }
  for (const sz of [1, -1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), mats.wicker);
    wall.position.set(0, h * 0.5, sz * (d * 0.5 - t * 0.5));
    parent.add(wall);
  }
  const rim = new THREE.Mesh(new THREE.BoxGeometry(w + t * 1.6, t * 1.3, d + t * 1.6), mats.wicker);
  rim.position.y = h;
  parent.add(rim);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBicycle(ctx) {
  const TEX = (ctx && ctx.textures) || {};
  const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : null);
  const painted = call(TEX.paintedMetal, '#1f6f78');
  const paintedCream = call(TEX.paintedMetal, '#f2e8d5');
  const metal = call(TEX.metal, { color: '#dfe4ea', rough: 0.18 });
  const leather = call(TEX.leather);
  const wicker = call(TEX.wicker);
  const fabric = call(TEX.fabric, { color: '#e0523f', stripeColor: '#f2e8d5' });

  const mats = {
    paint: new THREE.MeshStandardMaterial({
      color: COL.frame, roughness: 0.42, metalness: 0.35, envMapIntensity: 0.9,
      ...(painted ? { color: 0xffffff, map: painted.map, normalMap: painted.normalMap, roughnessMap: painted.roughnessMap } : {}),
    }),
    cream: new THREE.MeshStandardMaterial({
      color: COL.cream, roughness: 0.5, metalness: 0.15, envMapIntensity: 0.7,
      ...(paintedCream ? { color: 0xffffff, map: paintedCream.map, normalMap: paintedCream.normalMap, roughnessMap: paintedCream.roughnessMap } : {}),
    }),
    chrome: new THREE.MeshStandardMaterial({
      color: COL.chrome, roughness: 0.25, metalness: 0.9, envMapIntensity: 1.2,
      ...(metal ? { color: 0xffffff, map: metal.map, normalMap: metal.normalMap, roughnessMap: metal.roughnessMap } : {}),
    }),
    rubber: new THREE.MeshStandardMaterial({ color: COL.rubber, roughness: 0.92, metalness: 0 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: COL.darkMetal, roughness: 0.42, metalness: 0.72, envMapIntensity: 0.8 }),
    leather: new THREE.MeshStandardMaterial({
      color: COL.leather, roughness: 0.7, metalness: 0,
      ...(leather ? { color: 0xffffff, map: leather.map, normalMap: leather.normalMap, roughnessMap: leather.roughnessMap } : {}),
    }),
    wicker: new THREE.MeshStandardMaterial({
      color: 0xb98e52, roughness: 0.88, metalness: 0,
      ...(wicker ? { color: 0xffffff, map: wicker.map, normalMap: wicker.normalMap, roughnessMap: wicker.roughnessMap } : {}),
    }),
    fabric: new THREE.MeshStandardMaterial({
      color: COL.poppy, roughness: 0.78, metalness: 0, side: THREE.DoubleSide,
      ...(fabric ? { color: 0xffffff, map: fabric.map, normalMap: fabric.normalMap, roughnessMap: fabric.roughnessMap } : {}),
    }),
    baguette: new THREE.MeshStandardMaterial({
      color: COL.baguette, roughness: 0.85, metalness: 0,
      ...(leather ? { normalMap: leather.normalMap } : {}),
    }),
    lamp: new THREE.MeshStandardMaterial({
      color: COL.lamp, emissive: COL.lamp, emissiveIntensity: 0.55, roughness: 0.18, metalness: 0,
    }),
    poppy: new THREE.MeshStandardMaterial({ color: COL.poppy, roughness: 0.7, metalness: 0 }),
    cornflower: new THREE.MeshStandardMaterial({ color: COL.cornflower, roughness: 0.7, metalness: 0 }),
    mustard: new THREE.MeshStandardMaterial({ color: COL.mustard, roughness: 0.7, metalness: 0 }),
    leaf: new THREE.MeshStandardMaterial({ color: COL.leaf, roughness: 0.8, metalness: 0 }),
  };

  const root = new THREE.Group();
  root.name = 'bicycle';

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const addMesh = (parent, geo, mat, name) => {
    const mesh = new THREE.Mesh(geo, mat);
    if (name) mesh.name = name;
    parent.add(mesh);
    return mesh;
  };

  const frameGroup = new THREE.Group();
  frameGroup.name = 'bikeFrame';
  root.add(frameGroup);

  // ---------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------
  const bb = V(0, BIKE_DIMS.crank.y, BIKE_DIMS.crank.z);
  const seatTop = V(0, 0.868, -0.245);

  addMesh(frameGroup, tubeFrom([HEAD_BOTTOM.clone(), HEAD_TOP.clone()],
    { radius: 0.026, radial: 10, tubular: 4 }), mats.paint, 'headTube');
  addMesh(frameGroup, tubeFrom([V(0, 0.868, 0.385), V(0, 0.86, 0.06), seatTop.clone()],
    { radius: 0.02, radial: 9, tubular: 12 }), mats.paint, 'topTube');
  addMesh(frameGroup, tubeFrom([V(0, 0.6, 0.47), V(0, 0.45, 0.22), V(0, 0.315, 0.0)],
    { radius: 0.024, radial: 9, tubular: 12 }), mats.paint, 'downTube');
  addMesh(frameGroup, tubeFrom([V(0, 0.32, -0.02), V(0, 0.6, -0.13), seatTop.clone()],
    { radius: 0.022, radial: 9, tubular: 12 }), mats.paint, 'seatTube');
  addMesh(frameGroup, tubeFrom([V(0, 0.82, -0.238), V(0, 0.86, -0.243)],
    { radius: 0.028, radial: 10, tubular: 3 }), mats.cream, 'seatCollar');
  addMesh(frameGroup, tubeFrom([V(0, 0.85, -0.242), V(0, 0.93, -0.252)],
    { radius: 0.013, radial: 8, tubular: 4 }), mats.chrome, 'seatPost');

  for (const sx of [1, -1]) {
    addMesh(frameGroup, tubeFrom([
      V(sx * 0.048, 0.3, -0.035), V(sx * 0.055, 0.312, -0.28), V(sx * 0.05, BIKE_DIMS.wheelRadius, -0.49),
    ], { radius: 0.014, radial: 8, tubular: 10 }), mats.paint, 'chainStay');
    addMesh(frameGroup, tubeFrom([
      V(sx * 0.046, 0.845, -0.235), V(sx * 0.05, 0.5, -0.45), V(sx * 0.05, BIKE_DIMS.wheelRadius, -0.49),
    ], { radius: 0.013, radial: 8, tubular: 10 }), mats.paint, 'seatStay');
    addMesh(frameGroup, at(roundedBox(0.016, 0.05, 0.062, 0.6, 3), sx * 0.05, BIKE_DIMS.wheelRadius, -0.49),
      mats.darkMetal, 'dropout');
  }

  const bbShell = addMesh(frameGroup, new THREE.CylinderGeometry(0.034, 0.034, 0.095, 12), mats.chrome, 'bottomBracket');
  bbShell.rotation.z = Math.PI / 2;
  bbShell.position.copy(bb);
  // Lug sleeves at the classic joints.
  addMesh(frameGroup, tubeFrom([HEAD_TOP.clone(), V(0, 0.925, 0.397)],
    { radius: 0.024, radial: 8, tubular: 3 }), mats.cream, 'headLugTop');
  addMesh(frameGroup, tubeFrom([HEAD_BOTTOM.clone(), V(0, 0.578, 0.489)],
    { radius: 0.031, radial: 8, tubular: 3 }), mats.cream, 'headLugBottom');
  addMesh(frameGroup, at(roundedBox(0.05, 0.062, 0.062, 0.55, 4), 0, 0.858, -0.242), mats.cream, 'seatLug');
  addMesh(frameGroup, at(roundedBox(0.072, 0.06, 0.09, 0.6, 4), 0, 0.302, -0.02), mats.cream, 'bbLug');

  // ---------------------------------------------------------------------
  // Steering assembly: fork + front wheel + fender + lamp + basket
  // ---------------------------------------------------------------------
  const steerPivot = new THREE.Group();
  steerPivot.position.copy(HEAD_TOP);
  steerPivot.rotation.x = BIKE_DIMS.head.angle;
  frameGroup.add(steerPivot);

  const frontWheelGroup = new THREE.Group();
  frontWheelGroup.name = 'bikeFrontWheelGroup';
  steerPivot.add(frontWheelGroup);

  // Cancels the head-tube tilt so this subtree works in bicycle-local axes.
  const frontAlign = new THREE.Group();
  frontAlign.rotation.x = -BIKE_DIMS.head.angle;
  frontWheelGroup.add(frontAlign);
  const addFront = (geo, mat, name) => addMesh(frontAlign, at(geo, -HEAD_TOP.x, -HEAD_TOP.y, -HEAD_TOP.z), mat, name);
  const frontLocal = (obj, x, y, z) => {
    obj.position.set(x - HEAD_TOP.x, y - HEAD_TOP.y, z - HEAD_TOP.z);
    return obj;
  };

  addFront(at(roundedBox(0.09, 0.042, 0.052, 0.6, 4), 0, 0.535, 0.5), mats.paint, 'forkCrown');
  for (const sx of [1, -1]) {
    addFront(tubeFrom([
      V(sx * 0.045, 0.535, 0.5), V(sx * 0.045, 0.46, 0.568), V(sx * 0.045, 0.375, 0.6), V(sx * 0.045, 0.34, 0.6),
    ], { radius: 0.017, radial: 8, tubular: 10, profile: (t) => 1 - 0.22 * t }), mats.paint, 'forkBlade');
  }

  const frontWheel = buildWheel('bikeFrontWheel', mats, BIKE_DIMS.wheelRadius, BIKE_DIMS.tireTube);
  frontLocal(frontWheel, 0, BIKE_DIMS.wheelRadius, BIKE_DIMS.wheelZ.front);
  frontAlign.add(frontWheel);

  const frontFender = addMesh(frontAlign, fenderGeometry(Math.PI * 0.95, Math.PI * 0.02), mats.chrome, 'frontFender');
  frontLocal(frontFender, 0, BIKE_DIMS.wheelRadius, BIKE_DIMS.wheelZ.front);
  for (const sx of [1, -1]) {
    addFront(strut(V(sx * 0.048, 0.3, 0.68), V(sx * 0.048, 0.355, 0.83), 0.006, 6), mats.chrome);
  }

  const lampGroup = new THREE.Group();
  lampGroup.name = 'headlamp';
  frontLocal(lampGroup, 0, 0.735, 0.525);
  frontAlign.add(lampGroup);
  const lampHousing = addMesh(lampGroup, new THREE.CylinderGeometry(0.032, 0.038, 0.09, 14), mats.chrome, 'headlampHousing');
  lampHousing.rotation.x = Math.PI / 2 - 0.3;
  const lampLens = addMesh(lampGroup, new THREE.CylinderGeometry(0.031, 0.031, 0.012, 14), mats.lamp, 'headlampLens');
  lampLens.rotation.x = Math.PI / 2 - 0.3;
  lampLens.position.set(0, 0.014, 0.046);
  addMesh(lampGroup, strut(V(0, -0.03, -0.02), V(0, -0.09, -0.062), 0.005, 6), mats.chrome, 'headlampBracket');

  // ---------------------------------------------------------------------
  // Rear wheel, drivetrain
  // ---------------------------------------------------------------------
  const rearWheelGroup = buildWheel('bikeRearWheel', mats, BIKE_DIMS.wheelRadius, BIKE_DIMS.tireTube);
  rearWheelGroup.position.set(0, BIKE_DIMS.wheelRadius, BIKE_DIMS.wheelZ.rear);
  frameGroup.add(rearWheelGroup);

  const sprocket = addMesh(rearWheelGroup, new THREE.TorusGeometry(BIKE_DIMS.crank.sprocket, 0.009, 6, 16), mats.darkMetal, 'sprocket');
  sprocket.rotation.y = Math.PI / 2;
  sprocket.position.x = -0.055;

  const rearFender = addMesh(frameGroup, fenderGeometry(Math.PI * 0.92, Math.PI * 0.06), mats.chrome, 'rearFender');
  rearFender.position.set(0, BIKE_DIMS.wheelRadius, BIKE_DIMS.wheelZ.rear);
  for (const sx of [1, -1]) {
    addMesh(frameGroup, strut(V(sx * 0.05, 0.3, -0.36), V(sx * 0.05, 0.352, -0.2), 0.006, 6), mats.chrome);
    addMesh(frameGroup, strut(V(sx * 0.05, 0.3, -0.64), V(sx * 0.05, 0.352, -0.8), 0.006, 6), mats.chrome);
  }

  const crank = new THREE.Group();
  crank.name = 'bikeCrank';
  crank.position.copy(bb);
  frameGroup.add(crank);

  const ringR = BIKE_DIMS.crank.chainring;
  const chainring = addMesh(crank, new THREE.TorusGeometry(ringR, 0.011, 8, 22), mats.darkMetal, 'chainring');
  chainring.rotation.y = Math.PI / 2;
  // Drive side is the rider's right, i.e. -X in this rig's convention.
  chainring.position.x = -0.052;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    const bar = addMesh(crank, new THREE.BoxGeometry(0.005, ringR * 0.96, 0.014), mats.darkMetal, 'chainringSpoke');
    bar.position.set(-0.052, Math.cos(a) * ringR * 0.48, Math.sin(a) * ringR * 0.48);
    bar.rotation.x = a;
  }

  const pedals = [];
  for (const sx of [1, -1]) {
    const arm = addMesh(crank, new THREE.BoxGeometry(0.024, BIKE_DIMS.crank.arm, 0.05), mats.chrome, 'crankArm');
    arm.position.set(sx * 0.052, (sx * BIKE_DIMS.crank.arm) * 0.5, 0);

    const pedal = new THREE.Group();
    pedal.name = sx > 0 ? 'pedalL' : 'pedalR';
    pedal.position.set(sx * BIKE_DIMS.crank.pedalHalfX, sx * BIKE_DIMS.crank.arm, 0);
    crank.add(pedal);
    addMesh(pedal, roundedBox(0.085, 0.022, 0.062, 0.45, 4), mats.rubber, 'pedalBody');
    addMesh(pedal, at(new THREE.BoxGeometry(0.095, 0.008, 0.07), 0, 0.016, 0), mats.chrome, 'pedalCage');
    const spindle = addMesh(pedal, new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8), mats.chrome, 'pedalSpindle');
    spindle.rotation.z = Math.PI / 2;
    spindle.position.x = -sx * 0.05;
    pedals.push(pedal);
  }

  // Chain: two flattened runs, the bottom one sags a little.
  const ringTop = V(-0.052, bb.y + ringR, bb.z);
  const ringBottom = V(-0.052, bb.y - ringR, bb.z);
  const sprocketTop = V(-0.055, BIKE_DIMS.wheelRadius + BIKE_DIMS.crank.sprocket, BIKE_DIMS.wheelZ.rear);
  const sprocketBottom = V(-0.055, BIKE_DIMS.wheelRadius - BIKE_DIMS.crank.sprocket, BIKE_DIMS.wheelZ.rear);
  addMesh(frameGroup, tubeFrom([ringTop,
    V(-0.053, (ringTop.y + sprocketTop.y) * 0.5, (ringTop.z + sprocketTop.z) * 0.5), sprocketTop],
  { radius: 0.008, radial: 6, tubular: 8, squashX: 2.2 }), mats.darkMetal, 'chainTop');
  addMesh(frameGroup, tubeFrom([ringBottom,
    V(-0.053, (ringBottom.y + sprocketBottom.y) * 0.5 - 0.014, (ringBottom.z + sprocketBottom.z) * 0.5), sprocketBottom],
  { radius: 0.008, radial: 6, tubular: 8, squashX: 2.2 }), mats.darkMetal, 'chainBottom');

  // ---------------------------------------------------------------------
  // Saddle + springs
  // ---------------------------------------------------------------------
  const saddleGeo = new THREE.SphereGeometry(1, 18, 12);
  {
    const pos = saddleGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
      const nose = clamp01(z);
      const nx = x * 0.078 * (1 - 0.62 * nose * nose);
      const nz = z * 0.15 + Math.sign(z) * 0.012;
      pos.setXYZ(i, nx, y * 0.032 * (1 - 0.25 * nose), nz);
    }
    pos.needsUpdate = true;
    saddleGeo.computeVertexNormals();
  }
  const saddle = addMesh(frameGroup, saddleGeo, mats.leather, 'saddle');
  saddle.position.set(0, BIKE_DIMS.saddle.top - 0.032, BIKE_DIMS.saddle.z + 0.02);
  saddle.rotation.x = -0.05;
  for (const sx of [1, -1]) {
    addMesh(frameGroup, strut(V(sx * 0.035, 0.905, -0.16), V(sx * 0.036, 0.9, -0.33), 0.006, 6), mats.chrome);
    // Helical chrome spring under the back of the saddle.
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const a = t * TAU * 2.6;
      pts.push(V(sx * 0.05 + Math.cos(a) * 0.015, 0.9 - t * 0.075, -0.315 + Math.sin(a) * 0.015));
    }
    addMesh(frameGroup, tubeFrom(pts, { radius: 0.0045, radial: 6, tubular: 22 }), mats.chrome, 'saddleSpring');
  }

  // ---------------------------------------------------------------------
  // Handlebar (steerable): bars, grips, bell, streamers, front basket
  // ---------------------------------------------------------------------
  const handlebar = new THREE.Group();
  handlebar.name = 'bikeHandlebar';
  handlebar.position.copy(HEAD_TOP);
  frameGroup.add(handlebar);
  const barLocal = (obj, x, y, z) => {
    obj.position.set(x - HEAD_TOP.x, y - HEAD_TOP.y, z - HEAD_TOP.z);
    return obj;
  };

  addMesh(handlebar, at(tubeFrom([V(0, 0.88, 0.4), V(0, 0.955, 0.392), V(0, 1.0, 0.393)],
    { radius: 0.016, radial: 9, tubular: 8 }), 0, -HEAD_TOP.y, -HEAD_TOP.z), mats.chrome, 'stem');

  const barPoints = [
    V(0, 1.008, 0.395),
    V(0.1, 1.014, 0.383),
    V(0.22, 1.018, 0.31),
    V(0.285, 1.008, 0.19),
    V(0.298, 0.996, 0.115),
  ];
  for (const sx of [1, -1]) {
    addMesh(handlebar, at(tubeFrom(barPoints.map((p) => V(sx * p.x, p.y, p.z)),
      { radius: 0.014, radial: 9, tubular: 14 }), 0, -HEAD_TOP.y, -HEAD_TOP.z), mats.chrome, 'handlebar');
    addMesh(handlebar, at(tubeFrom([V(sx * 0.29, 0.999, 0.15), V(sx * 0.302, 0.994, 0.105)],
      { radius: 0.018, radial: 10, tubular: 4 }), 0, -HEAD_TOP.y, -HEAD_TOP.z), mats.cream, 'grip');
  }

  const bellMesh = addMesh(handlebar, new THREE.SphereGeometry(0.026, 12, 8, 0, TAU, 0, Math.PI * 0.55),
    mats.chrome, 'bell');
  barLocal(bellMesh, 0.1, 1.045, 0.345);
  barLocal(addMesh(handlebar, new THREE.BoxGeometry(0.03, 0.005, 0.009), mats.chrome, 'bellLever'), 0.1, 1.028, 0.378);

  const streamers = [];
  for (let i = 0; i < 2; i++) {
    const g = new THREE.PlaneGeometry(0.03, 0.3, 1, 8);
    g.translate(0, -0.15, 0);
    const mesh = new THREE.Mesh(g, mats.fabric);
    mesh.name = 'streamer' + i;
    if (i === 0) barLocal(mesh, 0.303, 0.99, 0.1);
    else barLocal(mesh, 0.286, 0.986, 0.118);
    mesh.rotation.y = Math.PI / 2 + (i === 0 ? 0.25 : -0.3);
    handlebar.add(mesh);
    streamers.push({ mesh, geo: g, base: Float32Array.from(g.attributes.position.array), phase: i * 1.7 });
  }

  const basketFront = new THREE.Group();
  basketFront.name = 'basketFront';
  barLocal(basketFront, 0, 0.9, 0.585);
  handlebar.add(basketFront);
  buildBasket(basketFront, mats, 0.2, 0.14, 0.16, 0.006);
  addMesh(handlebar, at(strut(V(0, 0.98, 0.42), V(0, 0.93, 0.575), 0.006, 6), 0, -HEAD_TOP.y, -HEAD_TOP.z),
    mats.chrome, 'basketBracket');

  // ---------------------------------------------------------------------
  // Rear rack: frame, wicker crate, baguette, flowers
  // ---------------------------------------------------------------------
  const rack = new THREE.Group();
  rack.name = 'bikeRack';
  frameGroup.add(rack);
  const rackY = 0.775;
  for (const sx of [1, -1]) {
    addMesh(rack, tubeFrom([V(sx * 0.105, rackY, -0.335), V(sx * 0.108, rackY, -0.6), V(sx * 0.1, rackY - 0.012, -0.79)],
      { radius: 0.008, radial: 6, tubular: 8 }), mats.chrome, 'rackRail');
    addMesh(rack, tubeFrom([V(sx * 0.105, rackY - 0.01, -0.35), V(sx * 0.062, 0.55, -0.45), V(sx * 0.05, BIKE_DIMS.wheelRadius + 0.012, -0.485)],
      { radius: 0.007, radial: 6, tubular: 8 }), mats.chrome, 'rackLeg');
    addMesh(rack, tubeFrom([V(sx * 0.1, rackY - 0.014, -0.775), V(sx * 0.056, 0.5, -0.72), V(sx * 0.05, BIKE_DIMS.wheelRadius + 0.012, -0.495)],
      { radius: 0.007, radial: 6, tubular: 8 }), mats.chrome, 'rackLeg');
  }
  for (const z of [-0.4, -0.58, -0.74]) {
    addMesh(rack, strut(V(-0.105, rackY, z), V(0.105, rackY, z), 0.007, 6), mats.chrome, 'rackBar');
  }

  const basketRear = new THREE.Group();
  basketRear.name = 'basketRear';
  basketRear.position.set(0, rackY + 0.075, -0.585);
  rack.add(basketRear);
  buildBasket(basketRear, mats, 0.195, 0.15, 0.25, 0.008);

  const baguette = addMesh(basketRear, new THREE.CapsuleGeometry(0.032, 0.3, 4, 10), mats.baguette, 'baguette');
  baguette.position.set(0.03, 0.168, 0.008);
  baguette.rotation.set(0.35, 0.1, 1.22);
  for (let i = 0; i < 4; i++) {
    const slash = addMesh(basketRear, new THREE.BoxGeometry(0.012, 0.032, 0.005), mats.leather, 'baguetteSlash');
    slash.position.set(-0.035 + i * 0.032, 0.13 + i * 0.016, -0.02 + i * 0.02);
    slash.rotation.set(0.35, 0.1, 1.22);
  }

  const flowerMats = [mats.poppy, mats.cornflower, mats.mustard];
  const flowerPos = [
    { x: -0.06, z: -0.055, h: 0.265 },
    { x: -0.015, z: -0.095, h: 0.305 },
    { x: 0.055, z: -0.075, h: 0.245 },
  ];
  for (let i = 0; i < 3; i++) {
    const f = flowerPos[i];
    const stem = addMesh(basketRear, new THREE.CylinderGeometry(0.004, 0.005, f.h, 6), mats.leaf, 'flowerStem');
    stem.position.set(f.x, f.h * 0.5, f.z);
    stem.rotation.z = f.x * 0.6;
    const bloom = addMesh(basketRear, new THREE.SphereGeometry(0.021, 10, 7), flowerMats[i], 'flowerBloom');
    bloom.position.set(f.x - f.x * 0.3, f.h, f.z);
    bloom.scale.set(1, 0.72, 1);
    const core = addMesh(basketRear, new THREE.SphereGeometry(0.008, 8, 6), mats.mustard, 'flowerCore');
    core.position.set(f.x - f.x * 0.3, f.h + 0.012, f.z);
    const leaf = addMesh(basketRear, new THREE.SphereGeometry(0.018, 8, 6), mats.leaf, 'flowerLeaf');
    leaf.scale.set(1, 0.35, 0.5);
    leaf.position.set(f.x + 0.022, f.h * 0.5, f.z);
  }

  // ---------------------------------------------------------------------
  // Pennant flag (vertex animated in update)
  // ---------------------------------------------------------------------
  addMesh(frameGroup, tubeFrom([
    V(0.095, rackY, -0.775), V(0.1, rackY + 0.26, -0.79), V(0.105, rackY + 0.5, -0.812),
  ], { radius: 0.0075, radial: 7, tubular: 8 }), mats.chrome, 'flagPole');
  const flagGeo = new THREE.PlaneGeometry(0.36, 0.2, 10, 6);
  flagGeo.translate(0.18, -0.012, 0);
  const flagMesh = new THREE.Mesh(flagGeo, mats.fabric);
  flagMesh.name = 'flag';
  flagMesh.rotation.y = Math.PI / 2;
  flagMesh.position.set(0.105, rackY + 0.472, -0.812);
  frameGroup.add(flagMesh);
  const flagBase = Float32Array.from(flagGeo.attributes.position.array);

  // ---------------------------------------------------------------------
  // Kickstand
  // ---------------------------------------------------------------------
  addMesh(frameGroup, tubeFrom([
    V(0.062, 0.28, -0.12), V(0.085, 0.15, -0.2), V(0.1, 0.02, -0.262),
  ], { radius: 0.008, radial: 6, tubular: 8 }), mats.darkMetal, 'kickstand');
  addMesh(frameGroup, at(new THREE.CylinderGeometry(0.016, 0.013, 0.012, 8), 0.1, 0.012, -0.266), mats.darkMetal, 'kickstandFoot');

  root.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  const parts = {
    frameGroup,
    frontWheel,
    frontWheelGroup,
    rearWheel: rearWheelGroup,
    rearWheelGroup,
    handlebar,
    crank,
    pedals,
    chainring,
    flagMesh,
    headlamp: lampLens,
    bellMesh,
    saddle,
    basketFront,
    basketRear,
    rack,
    streamers,
    frontFender,
    rearFender,
    frontAssembly: frontAlign,
  };
  parts.headlamp.userData.group = lampGroup;
  parts.headlamp.userData.housing = lampHousing;

  // ---------------------------------------------------------------------
  // Update - allocation free
  // ---------------------------------------------------------------------
  let spinFallback = 0;
  let time = 0;
  let bellWobble = 0;

  function update(dt, state, anim) {
    const player = state && state.player ? state.player : null;
    const speed = player && Number.isFinite(player.speed) ? player.speed : 0;
    const steer = player && Number.isFinite(player.steer) ? player.steer : 0;
    const crash = player ? clamp01(player.crash || 0) : 0;
    time = anim && Number.isFinite(anim.t) ? anim.t : time + dt;

    let wheelSpin;
    if (player && Number.isFinite(player.wheelSpin)) {
      wheelSpin = player.wheelSpin;
    } else {
      spinFallback += (speed / BIKE_DIMS.wheelRadius) * dt;
      wheelSpin = spinFallback;
    }
    const crankAngle = wheelSpin * BIKE_DIMS.crank.gearRatio;

    parts.rearWheelGroup.rotation.x = wheelSpin;
    parts.frontWheel.rotation.x = wheelSpin;
    parts.crank.rotation.x = crankAngle;
    // Pedal platforms stay level while the cranks turn under them.
    parts.pedals[0].rotation.x = -crankAngle;
    parts.pedals[1].rotation.x = -crankAngle;

    const steerAngle = steer * BIKE_DIMS.steerRatio;
    parts.frontWheelGroup.rotation.y = steerAngle;
    parts.handlebar.rotation.y = steerAngle;

    // Pennant: vertex animation from precomputed base positions.
    const wind = state && state.wind ? state.wind : null;
    const windStrength = wind && Number.isFinite(wind.strength) ? wind.strength : 0.4;
    const gust = wind && Number.isFinite(wind.gust) ? wind.gust : 0;
    const flow = 1.6 + Math.abs(speed) * 0.9 + windStrength * 2.2 + gust;

    {
      const pos = flagGeo.attributes.position;
      const arr = pos.array;
      const nrm = flagGeo.attributes.normal;
      const nArr = nrm.array;
      const amp = 0.028 + 0.05 * clamp01(Math.abs(speed) / 8) + 0.04 * windStrength + crash * 0.05;
      const k = 11 + flow * 1.4;
      const w = 1 - flow * 0.9;
      for (let i = 0; i < pos.count; i++) {
        const i3 = i * 3;
        const x = flagBase[i3];
        const y = flagBase[i3 + 1];
        const t = clamp01(x / 0.36);
        const wave = Math.sin(k * x - w * time) * amp * t
          + Math.sin(k * 0.55 * y + 2.1 * x - w * 1.6 * time) * amp * 0.35 * t * t;
        arr[i3] = x;
        arr[i3 + 1] = y + wave * 0.16 * t;
        arr[i3 + 2] = flagBase[i3 + 2] + wave;
        // Analytic slope, so we never re-run computeVertexNormals (allocates).
        const slope = Math.cos(k * x - w * time) * k * amp * t + Math.sin(k * x - w * time) * amp / 0.36;
        const inv = 1 / Math.sqrt(1 + slope * slope);
        nArr[i3] = -slope * inv;
        nArr[i3 + 1] = 0;
        nArr[i3 + 2] = inv;
      }
      pos.needsUpdate = true;
      nrm.needsUpdate = true;
    }

    // Streamers flutter from the grips.
    for (const s of parts.streamers) {
      const pos = s.geo.attributes.position;
      const arr = pos.array;
      const amp = 0.02 + 0.045 * clamp01(Math.abs(speed) / 8) + 0.03 * windStrength;
      const k = 13 + flow * 1.1;
      const w = 2.2 + flow * 1.2;
      for (let i = 0; i < pos.count; i++) {
        const i3 = i * 3;
        const x = s.base[i3];
        const y = s.base[i3 + 1];
        const t = clamp01(-y / 0.3);
        const wave = Math.sin(k * y + w * time + s.phase) * amp * t
          + Math.sin(k * 0.5 * y + w * 0.7 * time + s.phase * 1.3) * amp * 0.4 * t * t;
        arr[i3] = x + wave * 0.25 * t;
        arr[i3 + 1] = y;
        arr[i3 + 2] = s.base[i3 + 2] + wave;
      }
      pos.needsUpdate = true;
    }

    // Bell: a short double-tap wobble when the game rings it.
    const ring = anim && Number.isFinite(anim.bell) ? clamp01(anim.bell) : 0;
    bellWobble = ring > 0 ? Math.sin(time * 46) * ring * 0.09 : damp(bellWobble, 0, 8, dt);
    parts.bellMesh.rotation.z = bellWobble;
  }

  return { root, update, parts };
}
