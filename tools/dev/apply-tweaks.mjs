/**
 * apply-tweaks.mjs - small repeatable art-direction tweaks (kept as a script
 * so the changes are documented and can be re-applied or inspected).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const edit = (rel, pairs) => {
  const file = path.join(root, rel);
  let src = readFileSync(file, 'utf8');
  let changed = 0;
  for (const [from, to] of pairs) {
    if (src.includes(from)) {
      src = src.split(from).join(to);
      changed++;
    } else {
      console.log(`  ! not found in ${rel}: ${from.slice(0, 60)}`);
    }
  }
  writeFileSync(file, src);
  console.log(`  ${rel}: ${changed}/${pairs.length} edits`);
};

edit('src/world/terrain.js', [
  ['roughness: 0.95, metalness: 0.0, color: 0xa8a8a8,', 'roughness: 0.92, metalness: 0.0, color: 0xd2d2d2,'],
]);

edit('src/fx/post.js', [
  ['uSaturation: { value: 1.07 },', 'uSaturation: { value: 1.02 },'],
  ['gradePass.uniforms.uSaturation.value = photo.active ? 1.02 : 1.07;', 'gradePass.uniforms.uSaturation.value = photo.active ? 1.0 : 1.02;'],
]);

edit('src/world/environment.js', [
  ['sun.shadow.intensity = 0.82;', 'sun.shadow.intensity = 0.75;'],
]);

edit('src/core/textures.js', [
  ["fill(P, '#6f9e4a');", "fill(P, '#6b8f4c');"],
  ["tint(P, f1, '#8fb75a', 0.55);", "tint(P, f1, '#86a856', 0.55);"],
]);

// --- remove the separate road-marking meshes (now baked into TEX.roadSurface) ---
{
  const file = path.join(root, 'src/world/terrain.js');
  let src = readFileSync(file, 'utf8');
  const start = src.indexOf('  // centre dashes + edge lines.');
  const end = src.indexOf('  // Spur trails (gravel)');
  if (start >= 0 && end > start) {
    const replacement = `  // Road markings (centre dashes + edge lines) are baked into
  // TEX.roadSurface(); see core/textures.js. Thin standalone marking geometry
  // proved fragile and produced visible artifacts.
  const lineMesh = null;
  const dashMesh = null;

`;
    src = src.slice(0, start) + replacement + src.slice(end);
    writeFileSync(file, src);
    console.log('  src/world/terrain.js: marking meshes removed');
  } else {
    console.log('  src/world/terrain.js: marking block not found (already removed?)');
  }
}

// --- screenshot harness: make every ride-scenario start the game ------------
{
  const file = path.join(root, 'tools/screenshot.mjs');
  let src = readFileSync(file, 'utf8');
  const starters = [
    'P.layout.pois.harbor.position',
    'P.layout.pois.lighthouse.position',
    'P.layout.pois.bench.position',
    'P.layout.pois.peak.position',
    'P.layout.pois.bridge.position',
  ];
  let n = 0;
  for (const marker of starters) {
    const needle = `const P = window.__pelican;\n        const`;
    // insert a start call right after each "const P = window.__pelican;" whose
    // next statement references one of the POI markers
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("const P = window.__pelican;")) {
        const next = lines.slice(i + 1, i + 4).join('\n');
        if (next.includes(marker) && !next.includes("P.start('ride')")) {
          lines.splice(i + 1, 0, lines[i + 1].replace(/^(\s*)(.*)$/, "$1P.start('ride');"));
          n++;
        }
      }
    }
    src = lines.join('\n');
    void needle;
  }
  // photo-mode scenario: make sure the game is running before entering it
  if (!src.includes("P.start('ride');\n        P.enterPhoto(true);")) {
    src = src.replace("P.teleport(v.x + 26, v.z + 18, -2.1);\n        P.enterPhoto(true);", "P.teleport(v.x + 26, v.z + 18, -2.1);\n        P.enterPhoto(true);");
  }
  writeFileSync(file, src);
  console.log(`  tools/screenshot.mjs: ${n} scenario start() calls inserted`);
}
