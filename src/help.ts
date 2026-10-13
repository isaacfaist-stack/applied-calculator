// Plain-language explanations behind the ⓘ buttons. Diagrams are small inline
// SVGs using currentColor plus the coverage colors, so they read in day and
// night themes.

export interface HelpEntry {
  title: string;
  body: string; // HTML, trusted (written here)
  diagram?: string; // inline SVG
}

const GREEN = 'rgb(34 197 94)';
const YELLOW = 'rgb(250 204 21)';
const RED = 'rgb(220 38 38)';

/** One pass ending at an angled headland line, for each shutoff mode. */
function shutoffPanel(label: string, mode: 'noskip' | 'center' | 'nooverlap', x: number): string {
  // The pass runs up; the headland edge is a slanted line. The boom is 60 wide.
  const left = x + 10;
  const right = x + 70;
  // Headland line from (x, 40) to (x+80, 70): y = 40 + (px - x) * 30/80
  const lineY = (px: number) => 40 + ((px - x) * 30) / 80;
  const yL = lineY(left);
  const yR = lineY(right);
  const yC = lineY((left + right) / 2);
  // Where product turns off (top of the swath).
  const stop = mode === 'noskip' ? yL : mode === 'center' ? yC : yR;
  // Point where the headland line crosses the stop height.
  const cross = Math.min(right, Math.max(left, x + ((stop - 40) * 80) / 30));
  // Right of the crossing the line is below the stop: product lands on headland.
  const overlap = yR > stop ? `<polygon points="${cross},${stop} ${right},${stop} ${right},${yR}" fill="${YELLOW}"/>` : '';
  // Left of it the line is above the stop: a strip nobody covers.
  const skip = yL < stop ? `<polygon points="${left},${yL} ${cross},${stop} ${left},${stop}" fill="${RED}" opacity=".9"/>` : '';
  return `
    <g>
      <polygon points="${x},0 ${x + 80},0 ${x + 80},${lineY(x + 80)} ${x},${lineY(x)}" fill="${GREEN}" opacity=".35"/>
      <rect x="${left}" y="${stop}" width="60" height="${130 - stop}" fill="${GREEN}" opacity=".9"/>
      ${overlap}
      ${skip}
      <line x1="${x}" y1="${lineY(x)}" x2="${x + 80}" y2="${lineY(x + 80)}" stroke="currentColor" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${x + 40}" y="150" text-anchor="middle" font-size="12" fill="currentColor">${label}</text>
    </g>`;
}

const SHUTOFF_DIAGRAM = `<svg viewBox="0 0 280 160" role="img" aria-label="Shutoff at an angled headland: no skips, center, least overlap">
  ${shutoffPanel('No skips', 'noskip', 5)}
  ${shutoffPanel('Center', 'center', 100)}
  ${shutoffPanel('Least overlap', 'nooverlap', 195)}
</svg>`;

const CORNER_DIAGRAM = `<svg viewBox="0 0 280 150" role="img" aria-label="Headland corners: run into corner versus pivot on line">
  <g>
    <rect x="20" y="20" width="40" height="110" fill="${GREEN}" opacity=".85"/>
    <rect x="20" y="20" width="110" height="40" fill="${GREEN}" opacity=".85"/>
    <rect x="20" y="20" width="40" height="40" fill="${YELLOW}"/>
    <path d="M10 10 H130 M10 10 V130" stroke="currentColor" stroke-width="2"/>
    <text x="70" y="146" text-anchor="middle" font-size="12" fill="currentColor">Run into corner</text>
  </g>
  <g transform="translate(140 0)">
    <rect x="20" y="40" width="40" height="90" fill="${GREEN}" opacity=".85"/>
    <rect x="40" y="20" width="90" height="40" fill="${GREEN}" opacity=".85"/>
    <rect x="40" y="40" width="20" height="20" fill="${YELLOW}"/>
    <rect x="20" y="20" width="20" height="20" fill="${RED}" opacity=".85"/>
    <path d="M10 10 H130 M10 10 V130" stroke="currentColor" stroke-width="2"/>
    <text x="70" y="146" text-anchor="middle" font-size="12" fill="currentColor">Pivot on line</text>
  </g>
</svg>`;

const LEGEND = `<p class="help-legend"><span><i style="background:${GREEN}"></i>applied once</span><span><i style="background:${YELLOW}"></i>applied twice</span><span><i style="background:${RED}"></i>missed</span></p>`;

export const HELP: Record<string, HelpEntry> = {
  answer: {
    title: 'The answer',
    body: `<p><b>Surface acres</b> is the real size of the field. <b>Applied acres</b> is what your rate controller will count: every foot of overlap at headlands, corners and the last pass is counted again, and product goes out on it.</p>
      <p>The big number is what to put into the controller so the product you have comes out even. If you entered how much product you were given, it spreads exactly that; otherwise it lays the target rate on the real surface acres.</p>`,
  },
  rate: {
    title: 'Target rate',
    body: `<p>The rate on the ticket or prescription, per acre. The app assumes the product was figured on the field's surface acres.</p>`,
  },
  given: {
    title: 'Product given for this job',
    body: `<p>How much product you have for this field (or for every field you're planning together). Enter it in pounds, or as <b>acres' worth</b> if the plant loaded "67 acres' worth".</p>
      <p>With this filled in, the answer is the setting that puts out exactly what you have. Leave it blank to just lay the target rate on the surface acres.</p>`,
  },
  adjust: {
    title: 'Adjust with rate or density',
    body: `<p><b>Rate:</b> change the rate on the controller.</p>
      <p><b>Density:</b> leave the rate at the prescription and change the product density programmed in the controller instead. Dry controllers meter by volume and use the density to turn it into pounds, so programming a <i>higher</i> density puts out <i>less</i> product. Your as-applied records keep showing the prescribed rate.</p>
      <p>Density only applies to dry product sold by weight.</p>`,
  },
  density: {
    title: 'Product density',
    body: `<p>What the product really weighs per cubic foot. Use a density cup on the actual load if you can. Densities on blend tickets are often calculated from the ingredients and can be several pounds off, which throws every density setting off by the same amount.</p>`,
  },
  laps: {
    title: 'Headland laps',
    body: `<p>How many times you go around the outside of the field before doing the middle. Each lap is one working width. Passes in the middle shut off where they reach these laps.</p>`,
  },
  heading: {
    title: 'Pass direction',
    body: `<p><b>Longest side:</b> passes run parallel to the longest straight edge, the way most people set an AB line.</p>
      <p><b>Least overlap:</b> the app tries every direction and picks the one that wastes the least product.</p>
      <p><b>Manual:</b> set the angle yourself with the slider (0° = north–south).</p>`,
  },
  shutoff: {
    title: 'Shut off at headland',
    body: `<p>When a pass meets the headland at an angle, part of the spread crosses onto ground that's already done. This is when product turns off:</p>
      <ul><li><b>No skips:</b> stays on until the whole width is over the headland. Most overlap, nothing missed. Typical for manual on/off.</li>
      <li><b>Center:</b> turns off when the middle of the machine reaches it. Half overlaps, half skips. Like section control set to 50%.</li>
      <li><b>Least overlap:</b> turns off as soon as any part reaches it. Small skips, least product.</li></ul>
      <p>With more than one section, each section does this on its own.</p>`,
    diagram: SHUTOFF_DIAGRAM + LEGEND,
  },
  corners: {
    title: 'Headland corners',
    body: `<p><b>Run into corner:</b> keep driving until the spread reaches the field edge, then turn. Nothing is missed in the corner but it gets product twice.</p>
      <p><b>Pivot on line:</b> turn on the lap line. Less doubled up, but leaves a small unapplied patch in each corner.</p>`,
    diagram: CORNER_DIAGRAM + LEGEND,
  },
  exclusions: {
    title: 'Exclusions',
    body: `<p>Areas inside the field that don't get product. Each one is one of two kinds:</p>
      <ul><li><b>Drive through:</b> you cross it with product off, like a grass waterway. Passes run straight across and shut off at its edge.</li>
      <li><b>Go around:</b> you can't drive on it, like trees, a pond or buildings. Headland laps go around it just like the field edge, and passes stop at that headland.</li></ul>
      <p>Neither kind counts toward surface acres.</p>`,
  },
  width: {
    title: 'Working width',
    body: `<p>The width programmed in the controller, which is also your pass spacing (e.g. 70 ft for a spinner spread at 70 ft). The controller counts acres with this width, so use the same number here.</p>`,
  },
  sections: {
    title: 'Sections',
    body: `<p>How many parts of the boom or spread can shut off on their own. A single spinner with one gate is <b>1</b>. More sections means less overlap where passes meet the headland at an angle.</p>`,
  },
  bias: {
    title: 'Machine bias',
    body: `<p>How far off this machine runs compared to what the monitor says went out, by weight. If the monitor says 10,000 lb but 10,300 lb left the bin, it puts out 3% <b>more</b>.</p>
      <p>Only set this after the product density is right, and confirm it over a few loads. A wrong density looks exactly like bias. <b>Calibrate</b> works it out for you.</p>`,
  },
  decrease: {
    title: 'Average rate decrease',
    body: `<p>Belts can't always keep up when ground speed changes, so the job average on the monitor comes in under the rate you asked for. Requested 250, job average 240: enter <b>4</b>.</p>`,
  },
  calibrate: {
    title: 'Check a finished job',
    body: `<p>After a field, enter what really happened: product loaded, what's left, and the monitor's applied acres and average rate. The app splits the difference into the belt not keeping up (rate decrease) and whatever's left, which is either the product density or a machine bias. Save the one that fits.</p>`,
  },
};
