// scheduler.js — SM-2 variant with learning steps (pure; no DOM, no storage).
// Spec: docs/PLAN.md §5.5. Unit-tested in tests/unit/scheduler.test.mjs.
//
// Card state shape (stored inside a `cards` row):
//   { due, interval, ease, reps, lapses, lastReview, status, step, lapseIvl }
//   - due        epoch ms when the card is next due
//   - interval   current interval in DAYS (learning steps are fractions: 1 min = 1/1440)
//   - ease       SM-2 ease factor (default 2.5, min 1.3)
//   - status     "new" | "learning" | "review"
//   - step       learning step index (0 = 1-minute step, 1 = 10-minute step)
//   - lapseIvl   days to use when a lapsed card re-graduates (null if not relearning)

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;
export const MAX_INTERVAL_DAYS = 365;
export const FUZZ = 0.05;

const STEP_AGAIN = 1 / 1440; // 1 minute, in days
const STEP_HARD = 10 / 1440; // 10 minutes
const GRADES = ['again', 'hard', 'good', 'easy'];

/** Fresh state for a card that has never been graded. */
export function newCardState(nowMs = Date.now()) {
  return {
    due: nowMs, interval: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0,
    lastReview: null, status: 'new', step: 0, lapseIvl: null,
  };
}

/** Small deterministic PRNG (mulberry32) so fuzz is reproducible from a seed in tests. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toRng(rng) {
  if (typeof rng === 'function') return rng;
  if (typeof rng === 'number') return mulberry32(rng);
  return Math.random;
}

/** Accept 'again'|'hard'|'good'|'easy' or 1..4. */
export function normaliseGrade(grade) {
  if (typeof grade === 'number') return GRADES[grade - 1];
  const g = String(grade).toLowerCase();
  if (!GRADES.includes(g)) throw new Error(`unknown grade: ${grade}`);
  return g;
}

const clampEase = (e) => Math.max(MIN_EASE, Math.round(e * 100) / 100);
const capDays = (d) => Math.min(MAX_INTERVAL_DAYS, d);

/** ±5 % fuzz on day intervals ≥ 2 days, rounded to whole days. rng()=0.5 → no fuzz. */
function fuzzDays(days, rng) {
  if (days < 2) return Math.round(days);
  const factor = 1 + (rng() * 2 - 1) * FUZZ;
  return Math.round(days * factor);
}

/**
 * Apply a grade to a card state and return the NEW state (input is not mutated).
 * @param {object} state  card state (or null/undefined for a brand-new card)
 * @param {string|number} grade  again|hard|good|easy or 1..4
 * @param {number} nowMs  epoch ms of the review
 * @param {Function|number} [rng]  random source or numeric seed (fuzz)
 */
export function gradeCard(state, grade, nowMs = Date.now(), rng) {
  const g = normaliseGrade(grade);
  const r = toRng(rng);
  const s = { ...newCardState(nowMs), ...(state || {}) };
  const next = { ...s, reps: s.reps + 1, lastReview: nowMs };

  if (s.status === 'new' || s.status === 'learning') {
    const relearning = s.lapseIvl != null;
    const graduate = (days) => {
      next.status = 'review';
      next.step = 0;
      next.lapseIvl = null;
      next.interval = capDays(days);
    };
    switch (g) {
      case 'again':
        next.status = 'learning'; next.step = 0; next.interval = STEP_AGAIN; break;
      case 'hard':
        next.status = 'learning'; next.interval = STEP_HARD; break; // step unchanged
      case 'good':
        if (s.step >= 1) graduate(relearning ? s.lapseIvl : 1);
        else { next.status = 'learning'; next.step = 1; next.interval = STEP_HARD; }
        break;
      case 'easy':
        if (relearning) graduate(Math.max(4, s.lapseIvl));
        else { graduate(4); next.ease = 2.65; }
        break;
    }
  } else {
    // Review card.
    const old = Math.max(1, s.interval);
    const ease = s.ease || DEFAULT_EASE;
    switch (g) {
      case 'again':
        next.lapses = s.lapses + 1;
        next.ease = clampEase(ease - 0.2);
        next.status = 'learning';
        next.step = 0;
        next.interval = STEP_AGAIN;
        next.lapseIvl = Math.max(1, Math.round(old * 0.3));
        break;
      case 'hard':
        next.ease = clampEase(ease - 0.15);
        next.interval = capDays(Math.max(old + 1, fuzzDays(old * 1.2, r)));
        break;
      case 'good':
        next.interval = capDays(Math.max(old + 1, fuzzDays(old * ease, r)));
        break;
      case 'easy': {
        const good = Math.max(old + 1, Math.round(old * ease));
        next.ease = clampEase(ease + 0.15);
        next.interval = capDays(Math.max(good + 1, fuzzDays(old * ease * 1.3, r)));
        break;
      }
    }
  }
  next.due = nowMs + Math.round(next.interval * DAY);
  return next;
}

/** Human label for an interval in days: 1m, 10m, 3h, 1d, 12d, 2.5mo, 1.2y. */
export function formatInterval(days) {
  const mins = days * 1440;
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round((days / 30) * 10) / 10}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

/** Interval labels for each grade button (computed without fuzz). */
export function previewIntervals(state, nowMs = Date.now()) {
  const out = {};
  for (const g of GRADES) out[g] = formatInterval(gradeCard(state, g, nowMs, () => 0.5).interval);
  return out;
}

/** Epoch ms of the most recent day boundary (default 04:00 local) at or before nowMs. */
export function startOfDay(nowMs = Date.now(), dayStartHour = 4) {
  const d = new Date(nowMs);
  d.setHours(dayStartHour, 0, 0, 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** Epoch ms of the next day boundary after nowMs ("end of today"). */
export function endOfToday(nowMs = Date.now(), dayStartHour = 4) {
  const d = new Date(startOfDay(nowMs, dayStartHour));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** True if a (non-new) card state is due by the end of today. */
export function isDue(state, nowMs = Date.now(), dayStartHour = 4) {
  return !!state && state.status !== 'new' && state.due <= endOfToday(nowMs, dayStartHour);
}
