// Emits SVG fragments in the template's conventions, so every snapshot's
// diagram is generated from one layout and differs only in roles and presence.
//
//   import { diagram, node, frame, edge, label, dot } from './svg-kit.mjs';
//   const svg = diagram({ width: 930, height: 600, ariaLabel: '…' }, [
//     frame({ x: 45, y: 118, w: 820, h: 280, role: 'goal', label: '@metamask/ocap-kernel' }),
//     node({ x: 60, y: 136, w: 180, name: 'RemoteManager', body: '…', note: '…', role: 'goal', isNew: true }),
//     edge([[240, 166], [298, 166]]),
//     label({ x: 270, y: 158, text: 'init', anchor: 'middle' }),
//   ]);
//
// Roles: 'hazard' | 'goal' | 'alt' | 'none'. Coordinates are viewBox units.

const esc = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const fills = {
  hazard: 'fill:var(--hazard-fill);stroke:var(--hazard)',
  goal: 'fill:var(--goal-fill);stroke:var(--goal)',
  alt: 'fill:var(--alt-fill);stroke:var(--alt)',
  none: 'fill:var(--none-fill);stroke:var(--muted)',
};
const strokes = {
  hazard: 'var(--hazard)',
  goal: 'var(--goal)',
  alt: 'var(--alt)',
  none: 'var(--muted)',
};

/**
 * A node: name in mono, then up to two smaller lines. Height grows with the lines.
 *
 * @param {object} options - Node options.
 * @returns {string} SVG.
 */
export function node({
  x,
  y,
  w,
  h,
  name,
  body,
  note,
  role = 'none',
  isNew = false,
}) {
  const height = h ?? (note ? 64 : body ? 50 : 42);
  const cx = x + w / 2;
  const dash = isNew ? ' stroke-dasharray="5 3"' : '';
  const nameY = body || note ? y + 22 : y + height / 2 + 4.5;
  const parts = [
    `<rect style="${fills[role]}" x="${x}" y="${y}" width="${w}" height="${height}" rx="6" stroke-width="1.5"${dash}/>`,
    `<text style="font-family:var(--font-mono)" x="${cx}" y="${nameY}" text-anchor="middle" font-size="13" fill="currentColor">${esc(name)}</text>`,
  ];
  if (body) {
    parts.push(
      `<text style="font-family:var(--font-body);fill:var(--fg-2)" x="${cx}" y="${y + 39}" text-anchor="middle" font-size="11.5">${esc(body)}</text>`,
    );
  }
  if (note) {
    parts.push(
      `<text style="font-family:var(--font-body);fill:var(--muted)" x="${cx}" y="${y + 54}" text-anchor="middle" font-size="11" font-style="italic">${esc(note)}</text>`,
    );
  }
  return parts.join('\n');
}

/**
 * A dashed grouping frame (package, process, transaction) labelled bottom-left.
 *
 * @param {object} options - Frame options.
 * @returns {string} SVG.
 */
export function frame({ x, y, w, h, label: text, role = 'none' }) {
  const color = strokes[role];
  return [
    `<rect style="stroke:${color}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke-width="1.5" stroke-dasharray="6 5"/>`,
    `<text style="font-family:var(--font-mono);fill:${color}" x="${x + 14}" y="${y + h - 8}" font-size="11.5">${esc(text)}</text>`,
  ].join('\n');
}

/**
 * An orthogonal edge. End it 2px short of the target; `arrow: false` for a
 * line that joins another edge.
 *
 * @param {number[][]} points - Polyline points.
 * @param {object} [options] - Edge options.
 * @returns {string} SVG.
 */
export function edge(points, { arrow = true, dashed = false } = {}) {
  const marker = arrow ? ' marker-end="url(#arw)"' : '';
  const dash = dashed ? ' stroke-dasharray="4 3"' : '';
  return `<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.4"${marker}${dash}/>`;
}

/** @returns {string} A junction dot where edges merge. */
export const dot = ([x, y]) =>
  `<circle cx="${x}" cy="${y}" r="2.5" fill="currentColor"/>`;

/**
 * An edge label, beside a line rather than on it.
 *
 * @param {object} options - Label options.
 * @returns {string} SVG.
 */
export function label({ x, y, text, anchor = 'start', rotate }) {
  const transform = rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : '';
  return `<text style="font-family:var(--font-body);fill:var(--fg-2)" x="${x}" y="${y}" text-anchor="${anchor}" font-size="12"${transform}>${esc(text)}</text>`;
}

/**
 * The whole SVG, with the arrow marker defined once per diagram.
 *
 * @param {object} options - Diagram options.
 * @param {string[]} parts - Fragments from the functions above; falsy entries are skipped.
 * @returns {string} SVG.
 */
export function diagram({ width, height, ariaLabel }, parts) {
  return [
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel).replaceAll('"', '&quot;')}">`,
    '<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>',
    ...parts.filter(Boolean),
    '</svg>',
  ].join('\n');
}
