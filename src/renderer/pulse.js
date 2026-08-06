// ---------------------------------------------------------------------------
// Pulse in the sidebar header
//
// A curve that divides the header into two fields: warm above, cool below,
// both only hinted at. The line stays the main thing - the fields give it a
// horizon that makes the amplitude readable without having to follow the line.
//
// Four quantities, all derived from existing state:
//
//   Amplitude  how much is running at all - `busy` sessions above all, agents
//              with less weight (they keep working in the background while the
//              shell in front of them sits still).
//   Density    how much runs *in parallel*: the more agents are underway, the
//              more wave crests stand side by side. That is the quantity a
//              number shows badly and a picture shows well.
//   Colouring  of the fields picks up with the load; the gradient wanders very
//              slowly through two related tones.
//   Progress   the share of completed notes, as a brightness step in the line
//              and as a mark at the edge. When a note is added, a bright flash
//              runs across it.
//
// The loop only runs while something is moving: if everything is still, one
// last frame is drawn and rAF is unsubscribed. An app that stays open all day
// should not burn a core on decoration.
// ---------------------------------------------------------------------------
import { $ } from './dom.js';
import { sessions, activeId } from './sessions.js';

const pulseCanvas = $('#pulse-canvas');
const pulseCtx = pulseCanvas.getContext('2d');
const pulseCalm = window.matchMedia('(prefers-reduced-motion: reduce)');
const PULSE = { amp: 0, prog: 0, phase: 0, flash: 0, dens: 1, load: 0, drift: 0 };
let pulseRaf = 0;
let pulseLast = 0;
let pulseProgSeen = null;

/**
 * The progress of a newly activated session is not progress that just happened
 * - otherwise the pulse would flash on every session switch.
 */
export function pulseForgetProgress() {
  pulseProgSeen = null;
}

function pulseBusy() {
  let n = 0;
  for (const s of sessions.values()) if (!s.exited && s.state === 'busy') n++;
  return n;
}

// All agents across all sessions - the header shows the deck, not one tile
function pulseAgents() {
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.exited && s.agents) n += s.agents.running;
  }
  return n;
}

// null = no denominator. Without notes there is no progress to claim.
function pulseProgress() {
  const s = activeId && sessions.get(activeId);
  const todos = s ? s.todos : null;
  if (!todos || !todos.length) return null;
  return todos.filter((t) => t.done).length / todos.length;
}

export function sizePulse() {
  const dpr = window.devicePixelRatio || 1;
  pulseCanvas.width = Math.max(1, Math.round(pulseCanvas.clientWidth * dpr));
  pulseCanvas.height = Math.max(1, Math.round(pulseCanvas.clientHeight * dpr));
  pulseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Two superimposed sines of different length - a single wave looks like a
// screensaver, two look like an instrument. `dens` compresses both at once so
// the pattern gets denser with many agents without losing its character.
function pulseWaveAt(x) {
  const d = PULSE.dens;
  return PULSE.amp * (Math.sin(x * 0.055 * d + PULSE.phase) * 0.6
    + Math.sin(x * 0.021 * d - PULSE.phase * 1.4) * 0.4);
}

// Largest amplitude: the curve should graze the edge, not bump into it.
function pulseMaxAmp(h) {
  return Math.max(0.5, h / 2 - 3);
}

// Two related tones per field, between which the gradient wanders across the
// width. Two tones from the same corner of the colour wheel, not two colours:
// the shift should read as a shimmer, not as a rainbow.
const PULSE_WARM = [[217, 164, 65], [206, 118, 92]];   // amber -> copper
// The lower field carries the panel tone within it: muted tones that only push
// #16181f towards green or blue instead of laying a colour on top.
const PULSE_COOL = [[84, 134, 112], [78, 122, 142]];   // sage -> slate

function pulseMix([ar, ag, ab], [br, bg, bb], t) {
  return `${Math.round(ar + (br - ar) * t)}, `
    + `${Math.round(ag + (bg - ag) * t)}, `
    + `${Math.round(ab + (bb - ab) * t)}`;
}

// The gradient runs cyclically (cos) so the left and right edges match and the
// wandering leaves no seam.
function pulseFieldFill(w, [a, b], alpha) {
  const g = pulseCtx.createLinearGradient(0, 0, w, 0);
  const STOPS = 6;
  for (let i = 0; i <= STOPS; i++) {
    const p = i / STOPS;
    const t = (1 - Math.cos((p + PULSE.drift) * Math.PI * 2)) / 2;
    g.addColorStop(p, `rgba(${pulseMix(a, b, t)}, ${alpha})`);
  }
  return g;
}

function drawPulse() {
  const w = pulseCanvas.clientWidth;
  const h = pulseCanvas.clientHeight;
  if (!w || !h) return;
  const mid = h / 2;
  const edge = PULSE.prog * w;
  pulseCtx.clearRect(0, 0, w, h);

  // Sample the curve once - fields and line use the same points.
  const pts = [];
  for (let x = 0; x <= w; x += 2) pts.push([x, mid + pulseWaveAt(x)]);

  // The curve separates two fields: warm above (activity), cool below (what is
  // done). Kept pale - they should tint the header, not paint over it; wordmark
  // and buttons sit on top. With rising load the colouring picks up, so a full
  // deck still differs from an empty one even when you are not watching the
  // amplitude.
  const wash = 0.085 + PULSE.load * 0.09;

  // Upper field: warm, equally strong across the whole height.
  pulseCtx.beginPath();
  pulseCtx.moveTo(-2, 0);
  pulseCtx.lineTo(-2, pts[0][1]);
  for (const [px, py] of pts) pulseCtx.lineTo(px, py);
  pulseCtx.lineTo(w + 2, pts[pts.length - 1][1]);
  pulseCtx.lineTo(w + 2, 0);
  pulseCtx.closePath();
  pulseCtx.fillStyle = pulseFieldFill(w, PULSE_WARM, wash);
  pulseCtx.fill();

  // Lower field: already sits close to the panel tone by itself and becomes
  // fully transparent towards the bottom. Below the header the session list
  // continues in the same colour - a visible edge in between would be exactly
  // what one does not want here.
  pulseCtx.save();
  pulseCtx.beginPath();
  // The vertical edges lie outside the area: were they exactly on it,
  // half-opaque pixels would remain there that the fade-out can no longer
  // remove.
  pulseCtx.moveTo(-2, h);
  pulseCtx.lineTo(-2, pts[0][1]);
  for (const [px, py] of pts) pulseCtx.lineTo(px, py);
  pulseCtx.lineTo(w + 2, pts[pts.length - 1][1]);
  pulseCtx.lineTo(w + 2, h);
  pulseCtx.closePath();
  pulseCtx.clip();
  pulseCtx.fillStyle = pulseFieldFill(w, PULSE_COOL, wash * 1.15);
  // Beyond the edges: in device pixels the canvas is wider than the CSS width
  // suggests (a fractional devicePixelRatio), and the clipped last column would
  // otherwise be neither fully filled nor fully cleared.
  pulseCtx.fillRect(-2, 0, w + 4, h);
  // Pull the opacity down to zero from the line downwards. The gradient runs
  // across, the fade lengthwise - both in one gradient is impossible, so the
  // second direction is erased out instead of painted in.
  const fade = pulseCtx.createLinearGradient(0, mid, 0, h);
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  // Fully transparent just short of the bottom edge: if the ramp ran exactly to
  // h, a remnant would stay in the last pixel row because its centre still lies
  // above.
  fade.addColorStop(0.9, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
  pulseCtx.globalCompositeOperation = 'destination-out';
  pulseCtx.fillStyle = fade;
  pulseCtx.fillRect(-2, 0, w + 4, h);
  pulseCtx.restore();

  // The line takes on the colour of the lower field: it is that field's edge,
  // not a stroke of its own. It carries the progress only in its brightness -
  // a little more present left of the mark than right of it. A colour change
  // would be too loud here now that the fields carry the colour.
  pulseCtx.lineWidth = 1.4;
  pulseCtx.lineJoin = 'round';
  const segs = [
    [0, edge, 0.34 + PULSE.load * 0.1],
    [edge, w, 0.24 + PULSE.load * 0.08],
  ];
  for (const [from, to, alpha] of segs) {
    if (to - from < 0.5) continue;
    pulseCtx.save();
    pulseCtx.beginPath();
    pulseCtx.rect(from, 0, to - from, h);
    pulseCtx.clip();
    pulseCtx.beginPath();
    for (const [px, py] of pts) {
      if (px === 0) pulseCtx.moveTo(px, py);
      else pulseCtx.lineTo(px, py);
    }
    pulseCtx.strokeStyle = pulseFieldFill(w, PULSE_COOL, alpha + PULSE.flash * 0.35);
    pulseCtx.stroke();
    pulseCtx.restore();
  }

  // Edge of the progress, briefly lighting up when something is ticked off. A
  // little stronger than the line: since that has withdrawn into the field,
  // this mark is the only place where the level is still readable at all.
  if (edge > 0.5 && edge < w) {
    pulseCtx.fillStyle = `rgba(78, 201, 122, ${0.38 + PULSE.flash * 0.5})`;
    pulseCtx.fillRect(edge - 0.75, mid - PULSE.amp - 3, 1.5, PULSE.amp * 2 + 6);
  }
}

function pulseTick(now) {
  pulseRaf = 0;
  const dt = Math.min(0.05, (now - pulseLast) / 1000) || 0.016;
  pulseLast = now;

  const busy = pulseBusy();
  const agents = pulseAgents();
  const h = pulseCanvas.clientHeight || 1;
  const idle = busy === 0 && agents === 0;

  // Agents count for less than busy sessions: they keep running in the
  // background while the shell in front of them sits still - that is less
  // activity than a terminal in which something visibly happens.
  const targetAmp = idle ? 0.5
    : Math.min(pulseMaxAmp(h), 1.4 + busy * 1.8 + agents * 0.8);
  // Capped: beyond a dozen agents, denser only turns into restless.
  const targetDens = 1 + Math.min(1.1, agents * 0.16);
  const targetLoad = Math.min(1, (busy * 0.3 + agents * 0.15));
  const p = pulseProgress();
  const targetProg = p === null ? 0 : p;
  if (pulseProgSeen !== null && p !== null && p > pulseProgSeen) PULSE.flash = 1;
  pulseProgSeen = p;

  PULSE.amp += (targetAmp - PULSE.amp) * Math.min(1, dt * 4);
  PULSE.prog += (targetProg - PULSE.prog) * Math.min(1, dt * 5);
  // Let the density follow more softly than the amplitude: an agent that
  // finishes should not make the pattern jump.
  PULSE.dens += (targetDens - PULSE.dens) * Math.min(1, dt * 1.5);
  PULSE.load += (targetLoad - PULSE.load) * Math.min(1, dt * 2);
  // Very slow - one cycle takes over a minute. If the deck stands still, so
  // does the gradient: otherwise the loop would run forever for decoration.
  if (!idle) PULSE.drift = (PULSE.drift + dt * 0.016) % 1;
  PULSE.phase += dt * (idle ? 0.7 : 1.4 + busy * 0.8 + agents * 0.3);
  PULSE.flash = Math.max(0, PULSE.flash - dt * 1.6);
  drawPulse();

  // Only keep running while there is still movement pending
  const settled = idle && PULSE.flash <= 0
    && Math.abs(targetAmp - PULSE.amp) < 0.15
    && Math.abs(targetDens - PULSE.dens) < 0.01
    && Math.abs(targetLoad - PULSE.load) < 0.004
    && Math.abs(targetProg - PULSE.prog) < 0.004;
  if (!settled) pulseRaf = requestAnimationFrame(pulseTick);
}

export function pulseWake() {
  if (pulseCalm.matches) {
    // Without motion: still show the progress as a calm line.
    // Density and colouring may stay: those are states, not motion.
    const p = pulseProgress();
    const agents = pulseAgents();
    PULSE.amp = 0.5;
    PULSE.dens = 1 + Math.min(1.1, agents * 0.16);
    PULSE.load = Math.min(1, pulseBusy() * 0.3 + agents * 0.15);
    PULSE.prog = p === null ? 0 : p;
    PULSE.flash = 0;
    pulseProgSeen = p;
    drawPulse();
    return;
  }
  if (pulseRaf) return;
  pulseLast = performance.now();
  pulseRaf = requestAnimationFrame(pulseTick);
}

pulseCalm.addEventListener('change', () => {
  if (pulseRaf) { cancelAnimationFrame(pulseRaf); pulseRaf = 0; }
  pulseWake();
});
