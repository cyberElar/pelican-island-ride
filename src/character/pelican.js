/**
 * pelican.js - the pelican hero of "Pelican Island Ride".
 *
 * Local space: origin = the hip (where the legs meet the body), +Y up,
 * +Z forward, +X = the bird's left. The bird is authored directly in its riding
 * pose: its belly hangs ~0.15 m below the hip so it rests on the saddle, and the
 * legs are two-bone IK chains long enough (0.47 + 0.46 m) to keep the webbed
 * feet on the pedals through the whole crank revolution.
 *
 * createPelican(ctx, opts) -> { root, update(dt, state, anim), parts }
 *
 *   opts.mount  { y, z }  hip position inside the bicycle frame (default
 *                         PELICAN_MOUNT). Only used to self-derive pedal
 *                         targets when the rider passes none.
 *
 *   anim (optional, produced by rider.js; every field optional)
 *     t        seconds, shared clock (falls back to an internal clock)
 *     pulse    0..1 pedalling intensity
 *     blink    0..1 blink override (1 = fully closed)
 *     wing     0..1 extra wing flutter (crash / boost)
 *     lean     body roll in radians (counter-rolled so the head stays level)
 *     pedalL / pedalR   { x, y, z } ankle targets in PELICAN LOCAL space
 *
 *   parts: root hip spine torso chest tail neck head beak upperBeak lowerBeak
 *          pouch crest browL browR eyeL eyeR lids lidUpperL lidLowerL lidUpperR
 *          lidLowerR wingL wingR wingFeathersL wingFeathersR legL legR thighL
 *          thighR kneeL kneeR shinL shinR ankleL ankleR footL footR
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, smoothstep, TAU } from '../core/utils.js';
import { BIKE_DIMS, tubeFrom } from './bicycle.js';

// ---------------------------------------------------------------------------
// Palette + proportions
// ---------------------------------------------------------------------------

const COL = {
  body: 0xf5f1e8,
  bodyShade: 0xece5d6,
  wing: 0xefe9dc,
  wingInner: 0xdfd8c7,
  tip: 0x4a4d52,
  beak: 0xf2a33c,
  beakShade: 0xd98a24,
  pouch: 0xe8845f,
  leg: 0xc9a24a,
  foot: 0xe08a3c,
  eyeWhite: 0xf7edd6,
  iris: 0xd9a63c,
  pupil: 0x1b1712,
  highlight: 0xffffff,
  lid: 0xded4bd,
  brow: 0xdcd4c0,
  nostril: 0x8a5a1a,
};

/** Hip position inside the bicycle frame (bicycle-local, y = 0 at the ground). */
export const PELICAN_MOUNT = { x: 0, y: 1.09, z: -0.245 };

const DIM = {
  thigh: 0.47,
  shin: 0.46,
  legRootX: 0, // filled from BIKE_DIMS below
  legRootZ: 0.02,
  torso: { y: 0.17, z: -0.06, rx: 0.255, ry: 0.275, rz: 0.51 },
  chest: { y: 0.01, z: 0.28, rx: 0.22, ry: 0.21, rz: 0.235 },
  neckBase: { y: 0.3, z: 0.24 },
  head: { y: 0.63, z: 0.245, rx: 0.104, ry: 0.112, rz: 0.138 },
  eye: { x: 0.072, y: 0.662, z: 0.3, r: 0.033 },
  wingPivot: { y: 0.33, z: -0.02 },
};
DIM.legRootX = BIKE_DIMS.crank.pedalHalfX;

// ---------------------------------------------------------------------------
// Small geometry helpers (construction only)
// ---------------------------------------------------------------------------

/** Tapered cylinder with its pivot at the top: the bone extends along local -Y. */
function boneGeometry(len, rTop, rBottom, radial = 9, segs = 2) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, radial, segs, false);
  g.translate(0, -len / 2, 0);
  return g;
}

const _colA = new THREE.Color();
const _colB = new THREE.Color();
const _colMix = new THREE.Color();

/**
 * Flat feather card in the local XY plane, base at the origin, tip at +Y,
 * carrying a per-vertex colour ramp from base to tip. Cards get merged, so all
 * of them must share the exact attribute set (position/normal/uv/color).
 */
function featherCard({
  width = 0.05, length = 0.17, base = COL.wing, tip = COL.tip, taper = 0.5, curl = 0, tipStart = 0.15,
}) {
  const g = new THREE.PlaneGeometry(width, length, 2, 3);
  g.translate(0, length / 2, 0);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  _colA.setHex(base);
  _colB.setHex(tip);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = clamp01(y / length);
    pos.setX(i, x * lerp(1, taper, t));
    pos.setZ(i, curl * t * t);
    _colMix.copy(_colA).lerp(_colB, smoothstep(tipStart, 1.0, t));
    colors[i * 3] = _colMix.r;
    colors[i * 3 + 1] = _colMix.g;
    colors[i * 3 + 2] = _colMix.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function mergeCards(cards) {
  const merged = mergeGeometries(cards, false);
  for (const c of cards) c.dispose();
  return merged;
}

/**
 * Two-bone IK in the sagittal plane. Bones point down their local -Y, so a
 * group rotation.x = a aims a bone along (0, -cos a, -sin a). A positive bend
 * puts the joint behind the hip->target line, which reads as a bird's hock.
 * No allocation.
 */
function solveLeg(thigh, knee, ankle, hipY, hipZ, tgtY, tgtZ, l1, l2, footPitch) {
  const dy = tgtY - hipY;
  const dz = tgtZ - hipZ;
  let d = Math.hypot(dy, dz);
  const uy = d > 1e-6 ? dy / d : -1;
  const uz = d > 1e-6 ? dz / d : 0;
  const dMin = Math.abs(l1 - l2) + 1e-3;
  const dMax = l1 + l2 - 1e-3;
  if (d < dMin) d = dMin;
  else if (d > dMax) d = dMax;

  const base = Math.atan2(-uz, -uy);
  const cosPhi = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const phi = Math.acos(cosPhi);
  const thighAngle = base + phi;
  const kneeY = hipY - l1 * Math.cos(thighAngle);
  const kneeZ = hipZ - l1 * Math.sin(thighAngle);
  const shinAngle = Math.atan2(-(tgtZ - kneeZ), -(tgtY - kneeY));

  thigh.rotation.x = thighAngle;
  knee.rotation.x = shinAngle - thighAngle;
  ankle.rotation.x = -shinAngle + footPitch;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPelican(ctx, opts = {}) {
  const TEX = (ctx && ctx.textures) || {};
  const rng = (ctx && ctx.rng) || null;
  const mount = opts.mount || PELICAN_MOUNT;

  // -- shared materials -----------------------------------------------------
  const featherSurface = typeof TEX.leather === 'function' ? TEX.leather() : null;
  const grainNormal = featherSurface ? featherSurface.normalMap : null;
  const grainRough = featherSurface ? featherSurface.roughnessMap : null;

  const matBody = new THREE.MeshStandardMaterial({
    color: COL.body, roughness: 0.84, metalness: 0,
    normalMap: grainNormal, roughnessMap: grainRough,
    normalScale: new THREE.Vector2(0.4, 0.4), envMapIntensity: 0.45,
  });
  const matBodyShade = new THREE.MeshStandardMaterial({
    color: COL.bodyShade, roughness: 0.9, metalness: 0,
    normalMap: grainNormal, normalScale: new THREE.Vector2(0.3, 0.3), envMapIntensity: 0.35,
  });
  const matWingInner = new THREE.MeshStandardMaterial({ color: COL.wingInner, roughness: 0.86, metalness: 0, envMapIntensity: 0.35 });
  const matFeathers = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
  });
  const matBeak = new THREE.MeshStandardMaterial({ color: COL.beak, roughness: 0.34, metalness: 0.02, envMapIntensity: 0.9 });
  const matPouch = new THREE.MeshStandardMaterial({ color: COL.pouch, roughness: 0.62, metalness: 0 });
  const matLeg = new THREE.MeshStandardMaterial({ color: COL.leg, roughness: 0.55, metalness: 0 });
  const matFoot = new THREE.MeshStandardMaterial({ color: COL.foot, roughness: 0.6, metalness: 0 });
  const matEyeWhite = new THREE.MeshStandardMaterial({ color: COL.eyeWhite, roughness: 0.25, metalness: 0 });
  const matIris = new THREE.MeshStandardMaterial({ color: COL.iris, roughness: 0.22, metalness: 0 });
  const matPupil = new THREE.MeshStandardMaterial({ color: COL.pupil, roughness: 0.16, metalness: 0 });
  const matHighlight = new THREE.MeshStandardMaterial({
    color: COL.highlight, roughness: 0.05, metalness: 0, emissive: 0x4a4a44, emissiveIntensity: 0.35,
  });
  const matLid = new THREE.MeshStandardMaterial({ color: COL.lid, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  const matBrow = new THREE.MeshStandardMaterial({
    color: COL.brow, roughness: 0.9, metalness: 0,
  });
  const matNostril = new THREE.MeshStandardMaterial({ color: COL.nostril, roughness: 0.6, metalness: 0 });

  const root = new THREE.Group();
  root.name = 'pelican';
  const hip = new THREE.Group();
  hip.name = 'pelicanHip';
  root.add(hip);
  const spine = new THREE.Group();
  spine.name = 'pelicanSpine';
  hip.add(spine);

  // -- torso ----------------------------------------------------------------
  // Pear profile: full over the belly and rump, tapering into the shoulders.
  function shapeTorso(geo) {
    const pos = geo.attributes.position;
    let x, y, z, s, lower;
    for (let i = 0; i < pos.count; i++) {
      x = pos.getX(i); y = pos.getY(i); z = pos.getZ(i);
      s = 1 - 0.13 * z - 0.2 * z * z;
      lower = y < 0 ? 1.06 : 0.95;
      // Rump rides a touch higher than the breast, like a settled bird.
      const lift = z < 0 ? -0.022 * z : 0;
      pos.setXYZ(i, x * DIM.torso.rx * s * lower, y * DIM.torso.ry * s * lower + lift, z * DIM.torso.rz);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  const torso = new THREE.Mesh(shapeTorso(new THREE.SphereGeometry(1, 30, 22)), matBody);
  torso.name = 'pelicanTorso';
  torso.position.set(0, DIM.torso.y, DIM.torso.z);
  spine.add(torso);

  /**
   * Half width of the torso surface at a body-space (y, z) point. The wings and
   * their feathers use it to hug the barrel instead of floating off the flank.
   * Mirrors the deformation in shapeTorso().
   */
  function bodyHalfWidth(y, z) {
    const zn = clamp((z - DIM.torso.z) / DIM.torso.rz, -1, 1);
    const s = 1 - 0.13 * zn - 0.2 * zn * zn;
    const lift = zn < 0 ? -0.022 * zn : 0;
    const yn = (y - DIM.torso.y - lift) / DIM.torso.ry;
    const lower = yn < 0 ? 1.06 : 0.95;
    const ay = s * lower;
    const k = Math.hypot(yn / ay, zn);
    return DIM.torso.rx * ay * Math.sqrt(Math.max(0, 1 - k * k));
  }

  // Slightly darker lower shell: the soft shading break on the belly.
  const bellyRim = new THREE.Mesh(
    shapeTorso(new THREE.SphereGeometry(1.012, 26, 10, 0, TAU, Math.PI * 0.52, Math.PI * 0.48)),
    matBodyShade,
  );
  bellyRim.position.set(0, DIM.torso.y, DIM.torso.z);
  spine.add(bellyRim);

  // Distinct breast mass.
  const chestGeo = new THREE.SphereGeometry(1, 20, 14);
  chestGeo.scale(DIM.chest.rx, DIM.chest.ry, DIM.chest.rz);
  const chest = new THREE.Mesh(chestGeo, matBody);
  chest.name = 'pelicanChest';
  chest.position.set(0, DIM.chest.y, DIM.chest.z - 0.02);
  spine.add(chest);

  // Shoulder collar hides the neck join.
  const collarGeo = new THREE.SphereGeometry(1, 16, 12);
  collarGeo.scale(0.104, 0.086, 0.098);
  const collar = new THREE.Mesh(collarGeo, matBody);
  collar.position.set(0, DIM.neckBase.y - 0.02, DIM.neckBase.z + 0.02);
  spine.add(collar);

  // -- neck + head ----------------------------------------------------------
  const neckPts = [
    new THREE.Vector3(0, 0.275, 0.225),
    new THREE.Vector3(0, 0.395, 0.318),
    new THREE.Vector3(0, 0.505, 0.318),
    new THREE.Vector3(0, 0.578, 0.268),
    new THREE.Vector3(0, 0.615, 0.243),
  ];
  const neckGeo = tubeFrom(neckPts, {
    radius: 0.086, radial: 14, tubular: 20, squashX: 1.04,
    profile: (t) => 1.0 - 0.16 * t - 0.06 * t * t,
  });
  const neck = new THREE.Mesh(neckGeo, matBody);
  neck.name = 'pelicanNeck';
  spine.add(neck);

  const head = new THREE.Group();
  head.name = 'pelicanHead';
  head.position.set(0, DIM.head.y, DIM.head.z);
  spine.add(head);

  const skullGeo = new THREE.SphereGeometry(1, 22, 16);
  skullGeo.scale(DIM.head.rx, DIM.head.ry, DIM.head.rz);
  const skull = new THREE.Mesh(skullGeo, matBody);
  head.add(skull);

  // Low swept tuft at the nape: a flattened ridge rather than a spike.
  const crestGeo = new THREE.SphereGeometry(1, 12, 9);
  crestGeo.scale(0.028, 0.016, 0.058);
  const crest = new THREE.Mesh(crestGeo, matBodyShade);
  crest.position.set(0, 0.094, -0.072);
  crest.rotation.x = 0.42;
  head.add(crest);

  // -- beak + pouch ---------------------------------------------------------
  const beak = new THREE.Group();
  beak.name = 'pelicanBeak';
  beak.position.set(0, DIM.head.y, DIM.head.z);
  spine.add(beak);
  const addBeakPart = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    beak.add(mesh);
    return mesh;
  };

  // Upper mandible: broad at the base, tapering to a down-hooked tip.
  // Spans z 0.09 -> 0.725 in head space, i.e. ~0.62 m of bill.
  const upperGeo = tubeFrom([
    new THREE.Vector3(0, 0.022, 0.09),
    new THREE.Vector3(0, 0.014, 0.3),
    new THREE.Vector3(0, -0.008, 0.5),
    new THREE.Vector3(0, -0.042, 0.665),
    new THREE.Vector3(0, -0.066, 0.72),
  ], {
    radius: 0.061, radial: 12, tubular: 18, squashX: 0.9,
    profile: (t) => 1 - 0.3 * t - 0.28 * t * t,
  });
  const upperBeak = new THREE.Mesh(upperGeo, matBeak);
  upperBeak.name = 'pelicanUpperBeak';
  beak.add(upperBeak);
  // Hooked "nail" at the tip.
  const nailGeo = new THREE.SphereGeometry(1, 10, 8);
  nailGeo.scale(0.017, 0.019, 0.026);
  addBeakPart(nailGeo, matBeak, 0, -0.075, 0.708);

  // Lower mandible: slim bar whose edge is the pouch's top rim.
  const lowerGeo = tubeFrom([
    new THREE.Vector3(0, -0.02, 0.1),
    new THREE.Vector3(0, -0.032, 0.32),
    new THREE.Vector3(0, -0.05, 0.52),
    new THREE.Vector3(0, -0.062, 0.675),
  ], {
    radius: 0.03, radial: 10, tubular: 14, squashX: 0.84,
    profile: (t) => 1 - 0.45 * t,
  });
  const lowerBeak = new THREE.Mesh(lowerGeo, matBeak);
  lowerBeak.name = 'pelicanLowerBeak';
  beak.add(lowerBeak);

  // Stretchy gular pouch: a bag slung under the bill, its rim meeting the
  // lower mandible and its throat end blending into the neck.
  const pouchGeo = tubeFrom([
    new THREE.Vector3(0, -0.052, 0.085),
    new THREE.Vector3(0, -0.098, 0.27),
    new THREE.Vector3(0, -0.12, 0.45),
    new THREE.Vector3(0, -0.102, 0.58),
    new THREE.Vector3(0, -0.076, 0.655),
  ], {
    radius: 0.076, radial: 14, tubular: 20, squashX: 1.14,
    profile: (t) => 0.58 + 0.46 * Math.sin(Math.PI * Math.min(1, t * 0.96)) - 0.42 * t,
  });
  const pouch = new THREE.Mesh(pouchGeo, matPouch);
  pouch.name = 'pelicanPouch';
  beak.add(pouch);

  // Nostril grooves: shallow dark slivers along the upper mandible.
  const nostrilGeo = new THREE.SphereGeometry(1, 8, 6);
  nostrilGeo.scale(0.007, 0.005, 0.03);
  for (const sx of [1, -1]) {
    addBeakPart(nostrilGeo, matNostril, sx * 0.035, 0.008, 0.235);
  }

  // -- eyes -----------------------------------------------------------------
  const lids = new THREE.Group();
  lids.name = 'pelicanLids';
  head.add(lids);

  const eyeGeo = new THREE.SphereGeometry(DIM.eye.r, 16, 12);
  const irisGeo = new THREE.SphereGeometry(0.021, 12, 9);
  irisGeo.scale(1, 1, 0.42);
  const pupilGeo = new THREE.SphereGeometry(0.0105, 10, 7);
  pupilGeo.scale(1, 1, 0.5);
  const sparkGeo = new THREE.SphereGeometry(0.005, 8, 6);
  sparkGeo.scale(1, 1, 0.6);
  // Socket ring + lids read as eyelids thanks to the darker lid material.
  const eyeRingGeo = new THREE.TorusGeometry(0.0305, 0.0055, 6, 16);
  const lidUpperGeo = new THREE.SphereGeometry(0.0358, 16, 8, 0, TAU, 0, Math.PI * 0.6);
  const lidLowerGeo = new THREE.SphereGeometry(0.0358, 16, 6, 0, TAU, Math.PI * 0.6, Math.PI * 0.4);
  const browGeo = new THREE.SphereGeometry(1, 10, 7);
  browGeo.scale(0.036, 0.012, 0.052);

  const eyes = {};
  const lidParts = {};
  for (const side of [1, -1]) {
    const key = side > 0 ? 'L' : 'R';
    const eye = new THREE.Group();
    eye.name = 'pelicanEye' + key;
    // Splayed outwards and slightly down so both eyes read in a chase view.
    eye.position.set(side * DIM.eye.x, DIM.eye.y - DIM.head.y, DIM.eye.z - DIM.head.z);
    eye.rotation.set(-0.12, side * 0.9, 0);
    head.add(eye);

    const white = new THREE.Mesh(eyeGeo, matEyeWhite);
    eye.add(white);
    const iris = new THREE.Mesh(irisGeo, matIris);
    iris.position.z = DIM.eye.r * 0.71;
    eye.add(iris);
    const pupil = new THREE.Mesh(pupilGeo, matPupil);
    pupil.position.z = DIM.eye.r * 0.88;
    eye.add(pupil);
    const spark = new THREE.Mesh(sparkGeo, matHighlight);
    spark.position.set(side * 0.0075, 0.009, DIM.eye.r * 0.95);
    eye.add(spark);
    const ring = new THREE.Mesh(eyeRingGeo, matLid);
    ring.position.z = DIM.eye.r * 0.52;
    eye.add(ring);

    // Lids live in the head-space "lids" group at the eyeball centre: the domes
    // are rotationally symmetric about Y, so they do not need the eye splay.
    const lidU = new THREE.Mesh(lidUpperGeo, matLid);
    lidU.position.set(side * DIM.eye.x, DIM.eye.y - DIM.head.y + 0.004, DIM.eye.z - DIM.head.z + 0.002);
    lidU.scale.y = 0.5;
    lids.add(lidU);
    const lidD = new THREE.Mesh(lidLowerGeo, matLid);
    lidD.position.set(side * DIM.eye.x, DIM.eye.y - DIM.head.y - 0.004, DIM.eye.z - DIM.head.z + 0.002);
    lidD.scale.y = 0.55;
    lids.add(lidD);

    const brow = new THREE.Mesh(browGeo, matBrow);
    brow.position.set(side * 0.006, 0.036, -0.004);
    brow.rotation.set(-0.25, 0, -side * 0.18);
    eye.add(brow);

    eyes['eye' + key] = eye;
    eyes['brow' + key] = brow;
    lidParts['lidUpper' + key] = lidU;
    lidParts['lidLower' + key] = lidD;
  }

  // -- folded wings ---------------------------------------------------------
  const WING_PIVOT_Y = DIM.wingPivot.y;
  const WING_PIVOT_Z = DIM.wingPivot.z;
  /**
   * One folded-wing segment: a lens glued to the flank. The unit sphere's x
   * axis becomes thickness (0 at the body surface, `th` at the outer face), its
   * y/z axes become the segment's silhouette, and a rear taper narrows the mass
   * towards the wing tip. The outer face carries a vertex-colour ramp so the
   * tip goes charcoal. Authored in pelican-local space, then moved to the pivot.
   */
  function wingSegment(side, { y, z, ry, rz, th, tipMix }) {
    const g = new THREE.SphereGeometry(1, 14, 9);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    _colA.setHex(COL.wing);
    _colB.setHex(COL.tip);
    for (let i = 0; i < pos.count; i++) {
      const ux = pos.getX(i);
      const uy = pos.getY(i);
      const uz = pos.getZ(i);
      const rearT = clamp01((uz + 1) * 0.5);
      const taper = 1 - 0.34 * rearT * rearT;
      const vy = y + uy * ry * taper;
      const vz = z + uz * rz;
      const surf = bodyHalfWidth(vy, vz) + 0.01;
      pos.setXYZ(i, side * (surf + th * (0.5 + 0.5 * ux)), vy, vz);
      _colMix.copy(_colA).lerp(_colB, smoothstep(0.4, 1, rearT * tipMix));
      colors[i * 3] = _colMix.r;
      colors[i * 3 + 1] = _colMix.g;
      colors[i * 3 + 2] = _colMix.b;
    }
    pos.needsUpdate = true;
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    g.translate(0, -WING_PIVOT_Y, -WING_PIVOT_Z);
    return g;
  }

  const wings = {};
  for (const side of [1, -1]) {
    const key = side > 0 ? 'L' : 'R';
    const wing = new THREE.Group();
    wing.name = 'pelicanWing' + key;
    wing.position.set(0, WING_PIVOT_Y, WING_PIVOT_Z);
    // Three overlapping segments: shoulder covert, mid wing, tapered tip.
    wing.add(new THREE.Mesh(wingSegment(side, { y: 0.3, z: 0.03, ry: 0.115, rz: 0.2, th: 0.055, tipMix: 0.18 }), matFeathers));
    wing.add(new THREE.Mesh(wingSegment(side, { y: 0.245, z: -0.15, ry: 0.1, rz: 0.21, th: 0.048, tipMix: 0.5 }), matFeathers));
    wing.add(new THREE.Mesh(wingSegment(side, { y: 0.185, z: -0.34, ry: 0.074, rz: 0.185, th: 0.038, tipMix: 1 }), matFeathers));
    // A covert ridge along the leading edge reads as the folded wing's shoulder.
    wing.add(new THREE.Mesh(
      wingSegment(side, { y: 0.325, z: 0.055, ry: 0.058, rz: 0.125, th: 0.07, tipMix: 1 }),
      matWingInner,
    ));

    // 6 tip feathers shingled along the plate's trailing edge. They overlap the
    // plate instead of flaring off it, so the wing reads as one folded mass.
    const cards = [];
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const g = featherCard({
        width: 0.07 - 0.012 * t,
        length: 0.095 - 0.015 * t,
        base: COL.wing,
        tip: COL.tip,
        taper: 0.55,
        curl: 0.006,
        // Keep most of each card feathered; only the very tip goes charcoal.
        tipStart: 0.6,
      });
      // Card starts tip-up with its normal on +Z: rotate it onto the flank so
      // the normal is +/-X, then lay it back along the body.
      g.rotateY(side * Math.PI / 2);
      g.rotateX(-1.28 - 0.14 * t);
      g.rotateZ(-side * (0.02 + 0.08 * t));
      const by = 0.196 - 0.016 * i;
      const bz = -0.335 - 0.009 * i;
      g.translate(side * (bodyHalfWidth(by, bz) + 0.026), by, bz);
      cards.push(g);
    }
    const featherGeo = mergeCards(cards);
    featherGeo.translate(0, -WING_PIVOT_Y, -WING_PIVOT_Z);
    const feathers = new THREE.Mesh(featherGeo, matFeathers);
    wing.add(feathers);
    wings['wingFeathers' + key] = feathers;
    wings['wing' + key] = wing;
    spine.add(wing);
  }

  // -- tail -----------------------------------------------------------------
  const tail = new THREE.Group();
  tail.name = 'pelicanTail';
  tail.position.set(0, 0.245, -0.46);
  spine.add(tail);
  const tailCards = [];
  for (let i = 0; i < 6; i++) {
    const t = i / 5 - 0.5;
    const g = featherCard({
      width: 0.105,
      length: 0.24 - Math.abs(t) * 0.05,
      base: COL.wing,
      tip: 0xcfc9ba,
      taper: 0.55,
      curl: -0.012,
    });
    g.rotateX(-Math.PI / 2 + 0.2);
    g.rotateY(-t * 1.7);
    tailCards.push(g);
  }
  const tailMesh = new THREE.Mesh(mergeCards(tailCards), matFeathers);
  tail.add(tailMesh);
  const tailBaseGeo = new THREE.SphereGeometry(1, 12, 9);
  tailBaseGeo.scale(0.115, 0.07, 0.1);
  tail.add(new THREE.Mesh(tailBaseGeo, matBody));

  // -- legs -----------------------------------------------------------------
  // The femur is buried in feathers; only the drumstick + tarsus read as "leg".
  const thighGeo = boneGeometry(0.2, 0.05, 0.042, 10, 1);
  const shankGeo = boneGeometry(0.27, 0.04, 0.031, 9, 2);
  shankGeo.translate(0, -0.2, 0);
  const shinGeo = boneGeometry(DIM.shin, 0.029, 0.021, 9, 2);
  const trouserGeo = new THREE.SphereGeometry(1, 12, 9);
  trouserGeo.scale(0.072, 0.095, 0.078);
  const hockGeo = new THREE.SphereGeometry(0.028, 10, 8);
  const footShape = new THREE.Shape();
  footShape.moveTo(-0.052, -0.03);
  footShape.lineTo(-0.056, 0.028);
  footShape.quadraticCurveTo(-0.05, 0.062, -0.036, 0.102);
  footShape.quadraticCurveTo(-0.03, 0.116, -0.014, 0.104);
  footShape.quadraticCurveTo(-0.012, 0.075, 0.0, 0.062);
  footShape.quadraticCurveTo(0.012, 0.075, 0.014, 0.104);
  footShape.quadraticCurveTo(0.03, 0.116, 0.036, 0.102);
  footShape.quadraticCurveTo(0.05, 0.062, 0.056, 0.028);
  footShape.lineTo(0.052, -0.03);
  footShape.quadraticCurveTo(0, -0.052, -0.052, -0.03);
  const footGeo = new THREE.ExtrudeGeometry(footShape, { depth: 0.019, bevelEnabled: false, curveSegments: 3 });
  footGeo.rotateX(-Math.PI / 2);
  footGeo.translate(0, 0.009, 0.012);

  const legs = {};
  for (const side of [1, -1]) {
    const key = side > 0 ? 'L' : 'R';
    const thigh = new THREE.Group();
    thigh.name = 'pelicanThigh' + key;
    thigh.position.set(side * DIM.legRootX, 0, DIM.legRootZ);
    root.add(thigh);
    thigh.add(new THREE.Mesh(thighGeo, matBody));
    thigh.add(new THREE.Mesh(shankGeo, matLeg));
    const trouser = new THREE.Mesh(trouserGeo, matBody);
    trouser.position.set(side * 0.006, -0.055, 0);
    thigh.add(trouser);

    const knee = new THREE.Group();
    knee.name = 'pelicanKnee' + key;
    knee.position.set(0, -DIM.thigh, 0);
    thigh.add(knee);
    const shin = new THREE.Mesh(shinGeo, matLeg);
    knee.add(shin);
    knee.add(new THREE.Mesh(hockGeo, matLeg));

    const ankle = new THREE.Group();
    ankle.name = 'pelicanAnkle' + key;
    ankle.position.set(0, -DIM.shin, 0);
    knee.add(ankle);
    const foot = new THREE.Mesh(footGeo, matFoot);
    foot.name = 'pelicanFoot' + key;
    ankle.add(foot);

    legs['thigh' + key] = thigh;
    legs['knee' + key] = knee;
    legs['ankle' + key] = ankle;
    legs['shin' + key] = shin;
    legs['foot' + key] = foot;
    legs['leg' + key] = thigh;
  }

  // -- shadows --------------------------------------------------------------
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  // -- animation state (all preallocated) -----------------------------------
  const blinkGaps = new Float32Array(24);
  for (let i = 0; i < blinkGaps.length; i++) blinkGaps[i] = rng ? rng.range(1.7, 5.4) : 3;
  let blinkIdx = 0;
  let blinkTimer = blinkGaps[0];
  let blinkPhase = -1;
  let time = 0;
  let lastCrank = 0;

  // Pedal constants mirrored from the bicycle so the bird can self-drive.
  const crankY = BIKE_DIMS.crank.y;
  const crankZ = BIKE_DIMS.crank.z;
  const crankArm = BIKE_DIMS.crank.arm;
  const pedalHalfX = BIKE_DIMS.crank.pedalHalfX;
  const pedalLift = BIKE_DIMS.crank.pedalLift;
  const gearRatio = BIKE_DIMS.crank.gearRatio;

  const parts = {
    root, hip, spine, torso, chest, neck, head, beak, upperBeak, lowerBeak,
    pouch, crest, tail, tailMesh, bellyRim, lids,
    ...eyes, ...lidParts, ...wings, ...legs,
  };

  function update(dt, state, anim) {
    const player = state && state.player ? state.player : null;
    const speed = player && Number.isFinite(player.speed) ? player.speed : 0;
    const steer = player && Number.isFinite(player.steer) ? player.steer : 0;
    const lean = player && Number.isFinite(player.lean) ? player.lean : 0;
    const wheelSpin = player && Number.isFinite(player.wheelSpin) ? player.wheelSpin : 0;
    const crash = player ? clamp01(player.crash || 0) : 0;
    const boost = player ? clamp01(player.boost || 0) : 0;
    const airborne = player ? player.grounded === false : false;

    time = anim && Number.isFinite(anim.t) ? anim.t : time + dt;
    const speedNorm = clamp01(Math.abs(speed) / 7);
    const pedalPulse = anim && Number.isFinite(anim.pulse) ? clamp01(anim.pulse) : speedNorm;
    const crankAngle = wheelSpin * gearRatio;
    const crankDelta = crankAngle - lastCrank;
    lastCrank = crankAngle;

    // --- pedalling: ankles ride the pedal axle ---
    let tlY, tlZ, trY, trZ;
    if (anim && anim.pedalL && anim.pedalR) {
      tlY = anim.pedalL.y; tlZ = anim.pedalL.z;
      trY = anim.pedalR.y; trZ = anim.pedalR.z;
    } else {
      const ca = Math.cos(crankAngle);
      const sa = Math.sin(crankAngle);
      tlY = crankY + crankArm * ca + pedalLift - mount.y;
      tlZ = crankZ + crankArm * sa - mount.z;
      trY = crankY - crankArm * ca + pedalLift - mount.y;
      trZ = crankZ - crankArm * sa - mount.z;
    }

    // A little toe-down reads as pushing; it fades out when coasting.
    const toePitch = 0.06 + 0.05 * Math.sin(crankAngle + 1.1) * pedalPulse;
    solveLeg(legs.legL, legs.kneeL, legs.ankleL, 0, DIM.legRootZ, tlY, tlZ, DIM.thigh, DIM.shin, toePitch);
    solveLeg(legs.legR, legs.kneeR, legs.ankleR, 0, DIM.legRootZ, trY, trZ, DIM.thigh, DIM.shin, toePitch);

    // --- body: breathing, pedal pump, lean counter-roll ---
    const breath = Math.sin(time * 2.15) * 0.5 + 0.5;
    const pump = Math.sin(crankAngle * 2) * pedalPulse;
    hip.position.y = pump * 0.008 + breath * 0.004 - crash * 0.02;
    hip.rotation.x = -0.06 - 0.09 * speedNorm + 0.02 * Math.sin(time * 2.15) + crash * 0.16;
    hip.rotation.z = clamp(-lean * 0.35, -0.3, 0.3);
    hip.scale.set(1, 1 + breath * 0.008, 1 + breath * 0.006);

    // --- neck + head: bob with the pedal stroke, look into the turn ---
    const bob = Math.sin(crankAngle * 2 + 0.6) * pedalPulse * 0.018;
    neck.rotation.x = Math.sin(time * 1.6) * 0.02 - pump * 0.03 - (airborne ? 0.05 : 0);
    neck.rotation.y = -steer * 0.2;
    neck.scale.y = 1 + 0.02 * Math.sin(time * 1.35) - 0.05 * Math.max(crash, boost * 0.5);
    head.position.y = DIM.head.y + bob + breath * 0.004;
    head.rotation.x = 0.04 + Math.sin(time * 2.6) * 0.012 + speedNorm * 0.05;
    head.rotation.y = -steer * 0.16 + Math.sin(time * 0.7) * 0.03;
    head.rotation.z = clamp(lean * 0.22, -0.22, 0.22);
    beak.rotation.x = -crankDelta * 0.02 + Math.sin(time * 1.2) * 0.01;
    beak.rotation.y = Math.sin(time * 0.5) * 0.02 + steer * 0.05;

    // --- pouch jiggle: squashes with speed and every pedal stroke ---
    const pouchTarget = 1
      + (0.05 * Math.sin(time * 13.2) + 0.035 * Math.sin(time * 8.1)) * speedNorm
      + 0.03 * pump
      - 0.05 * crash;
    pouch.scale.set(1 - (pouchTarget - 1) * 0.4, pouchTarget, 1 + (pouchTarget - 1) * 0.5);
    pouch.position.y = Math.sin(time * 11.5) * 0.006 * speedNorm - 0.02 * crash;

    // --- eyes: blink on a seeded schedule ---
    let lidT = 0;
    if (anim && Number.isFinite(anim.blink)) {
      lidT = clamp01(anim.blink);
    } else {
      blinkTimer -= dt;
      if (blinkTimer <= 0 && blinkPhase < 0) {
        blinkPhase = 0;
        blinkIdx = (blinkIdx + 1) % blinkGaps.length;
        blinkTimer = blinkGaps[blinkIdx];
      }
      if (blinkPhase >= 0) {
        blinkPhase += dt / 0.15;
        if (blinkPhase >= 1) {
          blinkPhase = -1;
          lidT = 0;
        } else {
          lidT = Math.sin(blinkPhase * Math.PI);
        }
      }
    }
    lidParts.lidUpperL.scale.y = lerp(0.5, 1.4, lidT);
    lidParts.lidUpperR.scale.y = lerp(0.5, 1.4, lidT);
    lidParts.lidLowerL.scale.y = lerp(0.55, 1.25, lidT);
    lidParts.lidLowerR.scale.y = lerp(0.55, 1.25, lidT);

    // --- wings: tucked, opening into a flutter on boost or crash ---
    const wingExtra = anim && Number.isFinite(anim.wing) ? clamp01(anim.wing) : 0;
    const open = clamp01(Math.max(crash, boost * 0.85, airborne ? 0.3 : 0, wingExtra));
    const flap = Math.sin(time * (18 + 8 * boost)) * open;
    wings.wingL.rotation.z = open * 0.6 + flap * 0.24;
    wings.wingR.rotation.z = -(open * 0.6 + flap * 0.24);
    wings.wingL.rotation.x = -0.05 + flap * 0.2;
    wings.wingR.rotation.x = -0.05 + flap * 0.2;
    wings.wingL.rotation.y = -0.03 - open * 0.08;
    wings.wingR.rotation.y = 0.03 + open * 0.08;
    wings.wingFeathersL.rotation.x = flap * 0.1;
    wings.wingFeathersR.rotation.x = flap * 0.1;

    // --- tail fan trails the steering ---
    tail.rotation.y = -steer * 0.12;
    tail.rotation.x = -0.04 + Math.sin(time * 3.1) * 0.02 + crash * 0.1;
  }

  return { root, update, parts };
}
