/**
 * merge-static.js - collapse a rigged model's static meshes.
 *
 * The rider is assembled from ~170 small meshes (frame tubes, hub parts,
 * bakery, bolts) and the island's landmarks from ~110; every one of them is
 * drawn again in the shadow pass. This pass merges the direct child meshes of
 * each parent that are not animated into one mesh per (parent, material), so a
 * character costs 87 draw calls instead of 172 and the landmarks lose about
 * half of theirs.
 *
 * Merging per parent is what makes it safe: a merged mesh keeps the parent's
 * transform, so whatever animates the parent (a wheel group, the steering
 * pivot, the pelican's hip) still moves the merged geometry with it. Meshes
 * that are themselves animated - rotations, scales, vertex animation - must be
 * listed in `keep` and stay separate.
 *
 * Returns the number of meshes that disappeared.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const KEEP_ATTRS = ['position', 'normal', 'uv'];

function flattenKeep(keep, set) {
  for (const item of keep) {
    if (!item) continue;
    if (item.isObject3D) set.add(item);
    else if (Array.isArray(item)) flattenKeep(item, set);
    else if (typeof item === 'object') flattenKeep(Object.values(item), set);
  }
}

export function mergeStaticChildren(root, keep) {
  const keepSet = new Set();
  flattenKeep(keep || [], keepSet);

  // collect: parent -> material -> meshes
  const buckets = new Map();
  root.traverse((parent) => {
    for (const child of parent.children) {
      if (!child.isMesh || child.isInstancedMesh || child.isSkinnedMesh) continue;
      if (keepSet.has(child)) continue;
      if (child.visible === false || child.renderOrder !== 0) continue;
      const material = child.material;
      if (!material || Array.isArray(material) || material.transparent) continue;
      const geometry = child.geometry;
      if (!geometry || !geometry.attributes || !geometry.attributes.position) continue;
      let byMaterial = buckets.get(parent);
      if (!byMaterial) {
        byMaterial = new Map();
        buckets.set(parent, byMaterial);
      }
      const list = byMaterial.get(material);
      if (list) list.push(child);
      else byMaterial.set(material, [child]);
    }
  });

  let removed = 0;
  for (const [parent, byMaterial] of buckets) {
    for (const [material, list] of byMaterial) {
      if (list.length < 2) continue;
      // mergeGeometries needs a uniform index story: primitives are indexed,
      // the hand-built tube/ribbon geometries are not. Mixing them (or mixing
      // Uint16 and Uint32 indices) makes the merge fail, so those buckets are
      // flattened to non-indexed first.
      const indexTypes = new Set(list.map((mesh) => (mesh.geometry.index ? mesh.geometry.index.array.constructor : null)));
      const flattenIndex = indexTypes.size > 1;
      const geometries = [];
      let castShadow = false;
      let receiveShadow = false;
      for (const mesh of list) {
        mesh.updateMatrix();
        let geometry = mesh.geometry.clone();
        if (flattenIndex && geometry.index) {
          const flat = geometry.toNonIndexed();
          geometry.dispose();
          geometry = flat;
        }
        geometry.applyMatrix4(mesh.matrix);
        for (const name of Object.keys(geometry.attributes)) {
          if (!KEEP_ATTRS.includes(name)) geometry.deleteAttribute(name);
        }
        if (!geometry.attributes.normal) geometry.computeVertexNormals();
        if (!geometry.attributes.uv) {
          const count = geometry.attributes.position.count;
          geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
        }
        geometries.push(geometry);
        castShadow = castShadow || mesh.castShadow;
        receiveShadow = receiveShadow || mesh.receiveShadow;
      }
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${list[0].name || 'static'}+${list.length - 1}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      parent.add(mesh);
      for (const old of list) parent.remove(old);
      removed += list.length - 1;
    }
  }
  return removed;
}

/**
 * Merge every mesh that is static *in world space* into one mesh per material,
 * regardless of which set piece it came from.
 *
 * This is the landmark case: each piece is already batched per material, so
 * there is nothing to gain inside a piece, but the 20 pieces together still
 * cost ~115 draw calls (and again in the shadow pass). A mesh is static when
 * neither it nor any ancestor is in `keep`, so the lighthouse beam, the
 * balloons, the flags and every other animated part stay exactly where they
 * are. The merged meshes live in one container under `root` with an identity
 * transform; their geometry is baked into root-local space.
 *
 * Returns { meshes, materials } - how many meshes disappeared into how many
 * merged meshes.
 */
export function mergeStaticAcross(root, keep) {
  const keepSet = new Set();
  flattenKeep(keep || [], keepSet);
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4();
  const local = new THREE.Matrix4();

  const buckets = new Map();
  root.traverse((node) => {
    if (!node.isMesh || node.isInstancedMesh || node.isSkinnedMesh) return;
    if (node.visible === false || node.renderOrder !== 0) return;
    const material = node.material;
    if (!material || Array.isArray(material) || material.transparent) return;
    const geometry = node.geometry;
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
    for (let p = node; p && p !== root; p = p.parent) {
      if (keepSet.has(p)) return;   // animated or addressed by name: leave it
    }
    const list = buckets.get(material);
    if (list) list.push(node);
    else buckets.set(material, [node]);
  });
  if (!buckets.size) return { meshes: 0, materials: 0 };

  toRoot.copy(root.matrixWorld).invert();
  const container = new THREE.Group();
  container.name = 'mergedStatic';
  root.add(container);

  let removed = 0;
  let merged = 0;
  for (const [material, list] of buckets) {
    const indexTypes = new Set(list.map((mesh) => (mesh.geometry.index ? mesh.geometry.index.array.constructor : null)));
    const flattenIndex = indexTypes.size > 1;
    const geometries = [];
    let castShadow = false;
    let receiveShadow = false;
    for (const mesh of list) {
      let geometry = mesh.geometry.clone();
      if (flattenIndex && geometry.index) {
        const flat = geometry.toNonIndexed();
        geometry.dispose();
        geometry = flat;
      }
      local.multiplyMatrices(toRoot, mesh.matrixWorld);
      geometry.applyMatrix4(local);
      for (const name of Object.keys(geometry.attributes)) {
        if (!KEEP_ATTRS.includes(name)) geometry.deleteAttribute(name);
      }
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      if (!geometry.attributes.uv) {
        const count = geometry.attributes.position.count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      }
      geometries.push(geometry);
      castShadow = castShadow || mesh.castShadow;
      receiveShadow = receiveShadow || mesh.receiveShadow;
    }
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (geometries.length > 1) for (const part of geometries) part.dispose();
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `mergedStatic:${material.name || merged}`;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    container.add(mesh);
    for (const old of list) {
      old.parent.remove(old);
      removed++;
    }
    merged++;
  }
  return { meshes: removed, materials: merged };
}
