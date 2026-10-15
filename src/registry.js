/**
 * registry.js - the module manifest. main.js walks this list to build the
 * world in a deterministic order and to drive per-frame updates.
 *
 * Each entry: { id, factory, needs: [ctx keys], kind }
 *   kind 'world'  -> instance.group is added to engine.world
 *   kind 'sky'    -> instance.group is added to engine.skyGroup
 *   kind 'feature'-> managed explicitly by main.js
 */

import { createSky } from './world/sky.js';
import { createTerrain } from './world/terrain.js';
import { createOcean } from './world/ocean.js';
import { createEnvironment } from './world/environment.js';
import { createVegetation } from './world/vegetation.js';
import { createLandmarks } from './world/landmarks.js';
import { createWeather } from './fx/weather.js';
import { createCollectibles } from './gameplay/collectibles.js';
import { createEvents } from './gameplay/events.js';
import { createCameraController } from './gameplay/camera.js';
import { createControls } from './gameplay/controls.js';
import { createAudio } from './core/audio.js';

import { createProps } from './world/props.js';
import { createRider } from './character/rider.js';
import { createAnimals } from './world/animals.js';
import { createParticles } from './world/particles.js';

export function worldModuleList() {
  return [
    // --- foundation (no dependencies) ---
    { id: 'sky', factory: createSky, kind: 'sky' },
    { id: 'terrain', factory: createTerrain, kind: 'world' },
    // --- lighting needs the sky palette + terrain height texture ---
    { id: 'environment', factory: createEnvironment, kind: 'feature' },
    { id: 'ocean', factory: createOcean, kind: 'world' },
    // --- dressing ---
    { id: 'vegetation', factory: createVegetation, kind: 'world' },
    { id: 'props', factory: createProps, kind: 'world' },
    { id: 'landmarks', factory: createLandmarks, kind: 'world' },
    { id: 'animals', factory: createAnimals, kind: 'world' },
    { id: 'particles', factory: createParticles, kind: 'world' },
    { id: 'weather', factory: createWeather, kind: 'world' },
    // --- gameplay ---
    { id: 'camera', factory: createCameraController, kind: 'feature' },
    { id: 'controls', factory: createControls, kind: 'feature' },
    { id: 'rider', factory: createRider, kind: 'world' },
    { id: 'collectibles', factory: createCollectibles, kind: 'world' },
    { id: 'events', factory: createEvents, kind: 'feature' },
    // --- audio ---
    { id: 'audio', factory: createAudio, kind: 'feature' },
  ];
}
