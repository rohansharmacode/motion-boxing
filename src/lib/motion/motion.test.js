import { describe, expect, it } from 'vitest';
import { Calibrator, LandmarkSmoother, OneEuroFilter, PunchClassifier } from './index';
import { RoundMetrics } from './metrics';
function random(seed) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function trial(action, seed, hand, repeats = 1) {
    const rng = random(seed + 1), fps = 25 + 10 * rng(), dt = 1000 / fps;
    const scale = 0.15 + 0.14 * rng(), cx = 0.42 + 0.16 * rng(), cy = 0.42 + 0.12 * rng();
    const duration = 100 + 50 * rng();
    function frame(timeMs, p) {
        const joint = (x, y, z) => ({ x, y, z, visibility: 0.98 });
        const world = Array.from({ length: 33 }, () => joint(0, 0, 0));
        world[0] = joint(action === 'slip' ? 0.22 * p : 0, -0.25 + (action === 'duck' ? 0.17 * p : 0), 0);
        for (const [i, side] of [[11, -1], [12, 1]]) {
            const active = hand === (i === 11 ? 'left' : 'right');
            const q = active ? p : 0;
            const twist = action === 'cross' ? -side * 0.09 * p : 0;
            world[i] = joint(side * 0.2, 0, twist);
            // Two rigid arm segments rotating from a bent stance.
            const straight = action === 'jab' || action === 'cross';
            const swing = action === 'hook' ? q * 1.7 : 0;
            const lift = action === 'uppercut' ? q * 1.35 : 0;
            const reach = straight ? q * 1.60 : 0;
            const upper = 0.55 + (action === 'uppercut' ? 0.65 : 0) - lift - (straight ? 0.45 * q : 0);
            const fore = upper - 1.62 + reach;
            const elbow = world[i + 2] = joint(side * (0.2 - 0.27 * Math.sin(swing) * Math.cos(upper)), 0.27 * Math.sin(upper), twist - 0.27 * Math.cos(upper) * Math.cos(swing));
            world[i + 4] = joint(elbow.x - side * 0.26 * Math.sin(swing) * Math.cos(fore), elbow.y + 0.26 * Math.sin(fore), elbow.z - 0.26 * Math.cos(fore) * Math.cos(swing));
            if (action === 'guard') {
                world[i + 4].x *= 1 - 0.55 * p;
                world[i + 4].y -= 0.15 * p;
            }
        }
        const image = world.map(v => joint(cx + v.x * scale / 0.4 + (rng() - 0.5) * scale * 0.022, cy + v.y * scale / 0.4 + (rng() - 0.5) * scale * 0.022, v.z * scale / 0.4));
        if (action === 'passer' && p > 0) {
            for (const j of image)
                j.x += 1.3 * scale;
            image[15].x -= 2 * p * scale;
            if (p > 0.5)
                image[13].visibility = 0.1;
        }
        return { timeMs, image, world };
    }
    const cal = new Calibrator();
    for (let i = 0; i < 14; i++)
        cal.update(frame(0, 0).image);
    const classifier = new PunchClassifier(cal.update(frame(0, 0).image));
    const events = [];
    for (let t = 0; t < repeats * 1100; t += dt) {
        const phase = t % 1100;
        const p = Math.min(1, Math.max(0, (phase - 230) / duration), Math.max(0, (810 - phase) / 210));
        events.push(...classifier.update(frame(t, p)));
    }
    return { events, frame, classifier };
}
describe('seeded motion trials', () => {
    it('scores complete event sequences including side and duplicate detections', () => {
        let correct = 0, total = 0, duplicates = 0;
        const scores = {};
        for (const action of ['jab', 'cross', 'hook', 'uppercut', 'guard', 'duck', 'slip', 'idle', 'passer']) {
            scores[action] = 0;
            for (let i = 0; i < 60; i++) {
                const hand = i % 2 ? 'left' : 'right';
                const { events } = trial(action, 800 + i * 7919, hand);
                const expected = action === 'idle' || action === 'passer' ? 0 : 1;
                duplicates += Math.max(0, events.length - expected);
                if (events.length === expected && events.every(e => e.kind === action && (!e.hand || e.hand === hand))) {
                    correct++;
                    scores[action]++;
                }
                total++;
            }
        }
        console.log({ correct, total, duplicates, scores });
        expect(duplicates).toBe(0);
        expect(Math.min(...Object.values(scores)) / 60).toBeGreaterThan(0.95);
    });
    it('rearms on return between separate punches', () => {
        expect(trial('hook', 16, 'right', 2).events.map(e => e.kind)).toEqual(['hook', 'hook']);
    });
    it('does not bridge an invisible wrist or out-of-order sample', () => {
        const { classifier, frame } = trial('idle', 0, 'left');
        for (let t = 1200; t < 1700; t += 33) {
            const f = frame(t, 0);
            if (t < 1410)
                f.image[15].visibility = 0;
            else
                f.image[15].x += 0.2;
            expect(classifier.update(f)).toEqual([]);
            expect(classifier.update(f)).toEqual([]);
        }
    });
    it('tracks the visible arm while the opposite wrist is occluded', () => {
        const { classifier, frame } = trial('hook', 7, 'left');
        const events = [];
        for (let t = 1300; t < 2500; t += 30) {
            const p = Math.min(1, Math.max(0, (t - 1600) / 130), Math.max(0, (2200 - t) / 180));
            const f = frame(t, p);
            f.image[16].visibility = 0.2;
            if (t >= 1900 && t < 1990)
                f.world[13].visibility = 0.1;
            events.push(...classifier.update(f));
        }
        expect(events.map(e => [e.kind, e.hand])).toEqual([['hook', 'left']]);
    });
    it('measures full classifier cost on prebuilt frames', () => {
        const { classifier, frame } = trial('hook', 3, 'right');
        const frames = Array.from({ length: 2000 }, (_, i) => frame(2000 + i * 33, (1 - Math.cos(i / 4)) / 2));
        const start = performance.now();
        for (const f of frames)
            classifier.update(f);
        const ms = (performance.now() - start) / frames.length;
        console.log('mean ms/frame', ms);
        expect(ms).toBeLessThan(1);
    });
});
it('calibrates from 15 visible frames, mirrors anchors and freezes scale', () => {
    const { frame } = trial('idle', 0, 'right'), f = frame(0, 0), c = new Calibrator();
    expect(c.update([])).toBeUndefined();
    for (let i = 0; i < 14; i++)
        expect(c.update(f.image)).toBeUndefined();
    expect(c.update(f.image)?.neutralNose.x).toBeCloseTo(1 - f.image[0].x);
});
it('smooths jitter and resets an occluded axis on reacquisition', () => {
    const filter = new OneEuroFilter();
    expect(filter.update(0, 0)).toBe(0);
    expect(filter.update(1, 33)).toBeLessThan(0.5);
    const smoother = new LandmarkSmoother(), p = { x: 1, y: 2, z: 3 };
    smoother.update([p], 0);
    expect(smoother.update([], 33)).toHaveLength(33);
    expect(smoother.update([{ ...p, x: 4 }], 66)[0]?.x).toBe(4);
});
it('computes cue latency, timed guard fraction, hand balance and speed decline', () => {
    const m = new RoundMetrics();
    m.observeGuard(20, true);
    m.observeGuard(80, false);
    m.markCue(100);
    expect(m.event(250, 4, 'left')).toMatchObject({ reactionMs: 150, symmetry: null, guardUptime: 0.2 });
    for (let i = 0; i < 3; i++)
        m.event(300 + i, 4, 'left');
    for (let i = 0; i < 3; i++)
        m.event(400 + i, 2, 'right');
    expect(m.event(500, 2, 'right')).toMatchObject({ reactionMs: null, symmetry: 0.5, fatigueTrend: 0.5 });
});
