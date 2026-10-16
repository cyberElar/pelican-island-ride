/**
 * merge-static.js - collapse a rigged model's static meshes.
 *
 * The rider is assembled from ~170 small meshes (frame tubes, hub parts,
 * bakery, bolts). Every one of them is drawn twice per frame - once in the
 * main pass and once in the shadow pass - which is ~340 draw calls for
 * 0.03 M triangles. This pass merges the direct child meshes of each parent
 * that are not animated into one mesh per (parent, material).
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
      const geometries = [];
      let castShadow = false;
      let receiveShadow = false;
      for (const mesh of list) {
        mesh.updateMatrix();
        const geometry = mesh.geometry.clone();
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
