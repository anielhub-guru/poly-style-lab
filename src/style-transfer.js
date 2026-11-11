import { suggestLook } from './style-analysis.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rgb = hex => hex.slice(1).match(/../g).map(part => parseInt(part, 16));
const mix = (a, b, weight) => '#' + rgb(a).map((v, i) =>
  Math.round(v + (rgb(b)[i] - v) * weight).toString(16).padStart(2, '0')).join('');

const roles = [
  ['ground', /\b(ground|grass|terrain|lawn)\b/i],
  ['path', /\b(path|road|walkway)\b/i],
  ['wall', /\b(wall|plaster|facade)\b/i],
  ['roof', /\b(roof|tile)\b/i],
  ['glass', /\b(window|glass|sensor)\b/i],
  ['foliage', /\b(shrub|scrub|leaf|foliage|canopy)\b/i],
  ['stone', /\b(rock|stone|base)\b/i],
  ['accent', /\b(beacon|lamp|light)\b/i],
  ['dark', /\b(door|mast|arm|metal)\b/i],
];

export function buildStudioStyle(look) {
  const colour = look.colour;
  const palette = colour.palette;
  if (!look.available || !palette?.length) throw new Error('A measured colour palette is required');
  const colors = palette.map(({ hex }) => hex);
  const ranked = [...colors].sort((a, b) => rgb(a).reduce((sum, v) => sum + v, 0) - rgb(b).reduce((sum, v) => sum + v, 0));
  const dark = ranked[0];
  const dominant = colors[0];
  const second = colors[1] || dominant;
  const warm = [...colors].sort((a, b) => (rgb(b)[0] - rgb(b)[1]) - (rgb(a)[0] - rgb(a)[1]))[0];
  const highlight = mix(ranked.at(-1), '#fff4cf', .32);
  return {
    materials: {
      ground: dominant, path: second, wall: highlight, roof: warm,
      glass: mix(dominant, '#365b79', .65), foliage: mix(dominant, dark, .42),
      stone: mix(second, dark, .24), accent: mix(warm, '#fff4cf', .38), dark,
    },
    look: {
      ...suggestLook({ palette, colour, softness: { backgroundSharpnessRatio: { median: look.softness?.backgroundSharpnessRatio } } }),
      sun: mix(highlight, '#fff4cf', .7), hemiSky: mix(second, '#fff4cf', .38), hemiGround: mix(second, dark, .28),
      sunIntensity: 2.2, hemiIntensity: 1.28, fillIntensity: .26,
      exposure: clamp(1.15 - colour.brightnessMean * .34, .85, 1.15),
    },
    focalLight: look.focalLight,
    shadow: { direction: [-.52, .85], lengthPerHeight: 1.35, source: 'art-direction-default' },
  };
}

function groundLightingLayer(project, style, casters) {
  const camera = project.cameras.find(camera => camera.id === project.shots[0]?.cameraId);
  const [cx, , cz] = camera?.target || [0, 0, 0];
  const span = 22;
  const center = span / 2;
  const focus = style.focalLight;
  const svgParts = [];
  const shadow = style.shadow;
  const angle = Math.atan2(shadow.direction[1], shadow.direction[0]) * 180 / Math.PI;
  if (focus) {
    const x = center + (focus.x - .5) * 7;
    const z = center + (focus.y - .55) * 9;
    const radius = clamp(focus.radiusOfWidth * 32, 2.1, 5.4);
    const opacity = clamp(focus.contrast * 4, .14, .52);
    svgParts.push(`<ellipse cx="${x}" cy="${z}" rx="${radius}" ry="${radius * 1.2}" fill="url(#pool)" opacity="${opacity}"/>`);
  }
  for (const { part, prop } of casters) {
    const [px, py, pz] = part.position || [0, 0, 0];
    const [ox, oy, oz] = prop.transform.position;
    const width = part.size?.[0] || (part.radius || part.radiusBottom || .25) * 2;
    const depth = part.size?.[2] || width;
    const length = Math.max(width * .5, (py + oy) * shadow.lengthPerHeight);
    const x = center + px + ox - cx + shadow.direction[0] * length * .6;
    const z = center + pz + oz - cz + shadow.direction[1] * length * .6;
    svgParts.push(`<ellipse cx="${x}" cy="${z}" rx="${length + width * .35}" ry="${depth * .46}" transform="rotate(${angle} ${x} ${z})" fill="url(#shade)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}">
    <defs>
      <radialGradient id="pool"><stop stop-color="#fff0a9"/><stop offset=".42" stop-color="#f1db79" stop-opacity=".85"/><stop offset="1" stop-color="#efcc69" stop-opacity="0"/></radialGradient>
      <radialGradient id="shade"><stop stop-color="#302c16" stop-opacity=".52"/><stop offset=".65" stop-color="#302c16" stop-opacity=".31"/><stop offset="1" stop-color="#302c16" stop-opacity="0"/></radialGradient>
    </defs>${svgParts.join('')}</svg>`;
  return {
    id: 'style-lab-ground-lighting', name: 'Style Lab ground light and shadows', role: 'lighting',
    svg, size: [span, span], thickness: .001, backingColor: '#ffffff', backingMode: 'none',
    transform: { position: [cx, .027, cz], rotation: [-Math.PI / 2, 0, 0], scale: [1, 1, 1] },
    visible: true, locked: false, keyframes: [],
  };
}

export function applyStudioStyle(project, style) {
  const next = structuredClone(project);
  next.brief.look = { ...next.brief.look, ...style.look };
  const casters = [];
  for (const prop of next.props) {
    for (const part of prop.recipe?.parts || []) {
      const role = roles.find(([, match]) => match.test(part.name || ''))?.[0];
      if (role) part.color = style.materials[role];
      if (prop.visible && (role === 'foliage' || role === 'wall' || role === 'stone' && part.shape === 'sphere')) {
        casters.push({ part, prop });
      }
    }
  }
  next.sceneryLayers = (next.sceneryLayers || []).filter(layer => layer.id !== 'style-lab-ground-lighting');
  if (style.focalLight || casters.length) next.sceneryLayers.push(groundLightingLayer(next, style, casters));
  return next;
}
