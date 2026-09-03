// Adapted from OpenMausBot (3a84701), Apache-2.0. See THIRD_PARTY_NOTICES.md.
import type { CursorSilhouette } from './cursor-engine'
type MascotShape = 'circle' | 'oval' | 'square' | 'capsule' | 'triangle' | 'hexagon' | 'cloud' | 'droplet'
const SOFT_TRIANGLE_PATH = "M86.3935 61.1307 Q114.2705 8 142.1475 61.1307 L192.664 157.4103 Q220.541 210.541 160.541 210.541 H68 Q8 210.541 35.877 157.4103 Z";
const SOFT_HEXAGON_PATH = "M126.2705 15 Q114.2705 8 102.2705 15 L32 55 Q20 62 20 76 V152 Q20 166 32 173 L102.2705 213 Q114.2705 220 126.2705 213 L196.541 173 Q208.541 166 208.541 152 V76 Q208.541 62 196.541 55 Z";
const CLOUD_PATH = "M55 193 C6 193 -2 136 28 113 C7 62 61 30 96 54 C122 12 184 30 183 78 C230 83 239 137 208 159 C214 194 174 216 145 196 C116 221 76 216 55 193 Z";
const DROPLET_PATH = "M104.2705 17 Q114.2705 5 124.2705 17 C148 46 207 97 207 136 C207 185 169 220 114.2705 220 C59 220 21 185 21 136 C21 97 80 46 104.2705 17 Z";
const pathSilhouette = (name: string, path: string, y: number, scale: number): CursorSilhouette => ({
  name, fit: "", body: `<path d="${path}" fill="{{GRADIENT}}"/>`, clip: `<path d="${path}"/>`,
  anchor: { x: 114.2705, y, scale },
});
export const MASCOT_SILHOUETTES: Record<MascotShape, CursorSilhouette> = {
  circle: { name: "circle", fit: "", body: '<circle cx="114.2705" cy="114.2705" r="108" fill="{{GRADIENT}}"/>', clip: '<circle cx="114.2705" cy="114.2705" r="108"/>', anchor: { x: 114.2705, y: 114.2705, scale: 1 } },
  oval: { name: "oval", fit: "", body: '<ellipse cx="114.2705" cy="114.2705" rx="108" ry="88" fill="{{GRADIENT}}"/>', clip: '<ellipse cx="114.2705" cy="114.2705" rx="108" ry="88"/>', anchor: { x: 114.2705, y: 114.2705, scale: 0.82 } },
  square: { name: "square", fit: "", body: '<rect x="8" y="8" width="212.541" height="212.541" rx="44" fill="{{GRADIENT}}"/>', clip: '<rect x="8" y="8" width="212.541" height="212.541" rx="44"/>', anchor: { x: 114.2705, y: 114.2705, scale: 1 } },
  capsule: { name: "capsule", fit: "", body: '<rect x="8" y="48" width="212.541" height="132.541" rx="66.2705" fill="{{GRADIENT}}"/>', clip: '<rect x="8" y="48" width="212.541" height="132.541" rx="66.2705"/>', anchor: { x: 114.2705, y: 114.2705, scale: 0.65 } },
  triangle: { name: "triangle", fit: "", body: `<path d="${SOFT_TRIANGLE_PATH}" fill="{{GRADIENT}}"/>`, clip: `<path d="${SOFT_TRIANGLE_PATH}"/>`, anchor: { x: 114.2705, y: 125, scale: 0.88 } },
  hexagon: pathSilhouette("hexagon", SOFT_HEXAGON_PATH, 114.2705, 0.88),
  cloud: pathSilhouette("cloud", CLOUD_PATH, 131, 0.78),
  droplet: pathSilhouette("droplet", DROPLET_PATH, 140, 0.78),
};

