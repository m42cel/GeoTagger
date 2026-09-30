import { describe, expect, it } from 'vitest';
import { nextWheelAxis, normaliseWheelDelta, wheelZoomFactor, type WheelGestureState } from './wheel-gesture.js';

describe('nextWheelAxis', () => {
  it('locks onto the axis of the first event and holds it through diagonal drift', () => {
    // A swipe that starts leaning horizontal, then drifts to leaning vertical on
    // later events within the same gesture, must stay locked to 'horizontal' —
    // that's what stops a diagonal swipe from suddenly zooming partway through.
    let state: WheelGestureState | null = null;
    let t = 1000;
    state = nextWheelAxis(state, 10, 2, t); // starts horizontal-leading
    expect(state.axis).toBe('horizontal');

    t += 16;
    state = nextWheelAxis(state, 3, 8, t); // this one event alone leans vertical
    expect(state.axis).toBe('horizontal');

    t += 16;
    state = nextWheelAxis(state, 1, 9, t); // leans vertical even harder
    expect(state.axis).toBe('horizontal');
  });

  it('resets to a fresh axis once the gesture pauses', () => {
    let state: WheelGestureState | null = nextWheelAxis(null, 10, 2, 1000); // horizontal
    expect(state.axis).toBe('horizontal');

    state = nextWheelAxis(state, 1, 9, 1000 + 150); // paused for exactly the threshold
    expect(state.axis).toBe('vertical');
  });

  it('continues the gesture right up to the pause threshold', () => {
    let state: WheelGestureState | null = nextWheelAxis(null, 10, 2, 1000); // horizontal
    state = nextWheelAxis(state, 1, 9, 1000 + 149);
    expect(state.axis).toBe('horizontal');
  });

  it('starts a fresh gesture from the first event after a real pause, not the old one', () => {
    let state: WheelGestureState | null = nextWheelAxis(null, 10, 2, 1000); // horizontal
    state = nextWheelAxis(state, 9, 1, 2000); // long pause, itself horizontal-leading
    expect(state.axis).toBe('horizontal');
    state = nextWheelAxis(state, 1, 9, 2016); // continues that new gesture
    expect(state.axis).toBe('horizontal');
  });
});

describe('normaliseWheelDelta', () => {
  it('passes pixel-mode deltas through unchanged', () => {
    expect(normaliseWheelDelta(42, 0)).toBe(42);
    expect(normaliseWheelDelta(-7.5, 0)).toBe(-7.5);
  });

  it('scales line-mode deltas up to pixels', () => {
    expect(normaliseWheelDelta(3, 1)).toBeGreaterThan(3);
    expect(normaliseWheelDelta(1, 1)).toBe(normaliseWheelDelta(1, 1)); // deterministic
    expect(normaliseWheelDelta(2, 1)).toBe(2 * normaliseWheelDelta(1, 1));
  });

  it('scales page-mode deltas up far more than line-mode', () => {
    const line = normaliseWheelDelta(1, 1);
    const page = normaliseWheelDelta(1, 2);
    expect(page).toBeGreaterThan(line);
  });
});

describe('wheelZoomFactor', () => {
  it('matches the old fixed step for one mouse-wheel notch', () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(1.15, 6);
    expect(wheelZoomFactor(-100)).toBeCloseTo(1 / 1.15, 6);
  });

  it('is symmetric: zooming in then out by the same delta is a no-op', () => {
    expect(wheelZoomFactor(240) * wheelZoomFactor(-240)).toBeCloseTo(1, 10);
  });

  it('is proportional: the factor compounds with the delta rather than stepping', () => {
    const half = wheelZoomFactor(50);
    const whole = wheelZoomFactor(100);
    expect(half * half).toBeCloseTo(whole, 10);
  });

  it('keeps a small trackpad delta far gentler than a full mouse notch', () => {
    expect(wheelZoomFactor(5)).toBeLessThan(1.01);
    expect(wheelZoomFactor(5)).toBeGreaterThan(1);
  });

  it('zooms out for positive deltaY and in for negative, same as before', () => {
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
  });
});
