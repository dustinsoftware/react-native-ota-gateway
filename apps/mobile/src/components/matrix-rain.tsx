import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  CELL_WIDTH,
  columnCount,
  randomGlyph,
  stepEasing,
  trailBands,
} from './matrix-rain-layout';

/**
 * Decorative "digital rain" background for the developer screen, styled after
 * the 1999 film: columns of half-width katakana that step down the character
 * grid one row at a time (no smooth glide), shimmer as glyphs mutate in
 * place, and fade from a near-white head through green bands to a dim tail.
 * Purely cosmetic and non-interactive (`pointerEvents="none"`); rendered
 * behind the screen content at low opacity so the foreground stays legible.
 */

const ROW_HEIGHT = 16;
const FONT_SIZE = 14;
const MIN_ROWS = 8;
const ROW_JITTER = 16;
/** Per-column time to advance one row, randomized within this range. */
const STEP_INTERVAL_MIN_MS = 60;
const STEP_INTERVAL_JITTER_MS = 120;
const START_DELAY_MAX_MS = 5000;
/** How often each column re-randomizes some of its glyphs. */
const MUTATE_INTERVAL_MIN_MS = 250;
const MUTATE_INTERVAL_JITTER_MS = 350;
/** Fraction of trail glyphs replaced per mutation tick. */
const MUTATE_FRACTION = 0.2;

const HEAD_COLOR = '#F4FFF4';
const BRIGHT_COLOR = '#66FF66';
const MID_COLOR = '#22CC44';
const DIM_COLOR = '#0A5F20';
const BACKDROP_COLOR = '#000000';

type ColumnSpec = {
  key: number;
  x: number;
  rows: number;
  stepInterval: number;
  startDelay: number;
};

function randomGlyphs(count: number): string[] {
  return Array.from({ length: count }, randomGlyph);
}

function Column({ spec, fall }: { spec: ColumnSpec; fall: number }) {
  const columnHeight = spec.rows * ROW_HEIGHT;
  const translateY = useRef(new Animated.Value(-columnHeight)).current;
  const [glyphs, setGlyphs] = useState<string[]>(() => randomGlyphs(spec.rows));

  useEffect(() => {
    // Fall from just above the top to just past the bottom, then repeat. The
    // step easing quantizes the translation onto ROW_HEIGHT rows so the stream
    // jumps cell-by-cell like the film instead of gliding. Per-column step
    // interval and start delay desync the columns. Stepped output changes
    // per-frame values rarely, and translateY is layout-independent, so the
    // native driver is safe; react-native-web has no native driver, so fall
    // back to the JS driver there to avoid a console warning.
    // Reset to just above the top: on remount that's a no-op, but when the
    // effect re-runs after a dimension change the value may be mid-fall.
    translateY.setValue(-columnHeight);
    const distance = fall + 2 * columnHeight;
    const steps = Math.max(1, Math.round(distance / ROW_HEIGHT));
    const loop = Animated.loop(
      Animated.timing(translateY, {
        toValue: fall + columnHeight,
        duration: steps * spec.stepInterval,
        easing: stepEasing(steps),
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    const timer = setTimeout(() => loop.start(), spec.startDelay);
    return () => {
      clearTimeout(timer);
      loop.stop();
    };
  }, [translateY, fall, columnHeight, spec.stepInterval, spec.startDelay]);

  useEffect(() => {
    // Regenerate the glyph column whenever its row count changes (specs are
    // re-randomized on rotation/resize), then mutate a few glyphs in place on
    // a randomized cadence so the stream shimmers as it falls instead of
    // scrolling a frozen string.
    setGlyphs(randomGlyphs(spec.rows));
    const interval = MUTATE_INTERVAL_MIN_MS + Math.random() * MUTATE_INTERVAL_JITTER_MS;
    const timer = setInterval(() => {
      setGlyphs((prev) => {
        const next = prev.slice();
        const mutations = Math.max(1, Math.round(prev.length * MUTATE_FRACTION));
        for (let i = 0; i < mutations; i++) {
          next[Math.floor(Math.random() * next.length)] = randomGlyph();
        }
        return next;
      });
    }, interval);
    return () => clearInterval(timer);
  }, [spec.rows]);

  // The stream falls downward, so the head is the leading edge at the BOTTOM
  // of the column and the trail fades upward behind it. Render top-to-bottom
  // as dim tail, mid, bright, then the near-white head last -- the film's fade
  // profile, brightest at the bottom. Each band is reversed so the glyph
  // nearest the head sits closest to it.
  const bands = trailBands(spec.rows - 1);
  const head = glyphs[0];
  const bright = glyphs.slice(1, 1 + bands.bright).reverse().join('\n');
  const mid = glyphs.slice(1 + bands.bright, 1 + bands.bright + bands.mid).reverse().join('\n');
  const dim = glyphs.slice(1 + bands.bright + bands.mid).reverse().join('\n');

  return (
    <Animated.View style={[styles.column, { left: spec.x, transform: [{ translateY }] }]}>
      {dim ? <Text style={[styles.glyph, styles.dim]}>{dim}</Text> : null}
      {mid ? <Text style={[styles.glyph, styles.mid]}>{mid}</Text> : null}
      {bright ? <Text style={[styles.glyph, styles.bright]}>{bright}</Text> : null}
      <Text style={[styles.glyph, styles.head]}>{head}</Text>
    </Animated.View>
  );
}

export function MatrixRain() {
  const { width, height } = useWindowDimensions();
  // The web build is server-rendered (`web.output: "server"`), so defer the
  // random, resolution-dependent columns until after mount: server output and
  // the first client render then both show the empty backdrop, avoiding a React
  // hydration mismatch. The columns fade in on the client immediately after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const columns = useMemo<ColumnSpec[]>(() => {
    const count = columnCount(width);
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      x: i * CELL_WIDTH,
      rows: MIN_ROWS + Math.floor(Math.random() * ROW_JITTER),
      stepInterval: STEP_INTERVAL_MIN_MS + Math.floor(Math.random() * STEP_INTERVAL_JITTER_MS),
      startDelay: Math.floor(Math.random() * START_DELAY_MAX_MS),
    }));
  }, [width]);

  return (
    <View pointerEvents="none" style={styles.container}>
      {mounted
        ? columns.map((spec) => <Column key={spec.key} spec={spec} fall={height} />)
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BACKDROP_COLOR,
    overflow: 'hidden',
    opacity: 0.35,
  },
  column: {
    position: 'absolute',
    top: 0,
    width: CELL_WIDTH,
    alignItems: 'center',
  },
  glyph: {
    width: CELL_WIDTH,
    textAlign: 'center',
    fontSize: FONT_SIZE,
    lineHeight: ROW_HEIGHT,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    // The film's glyphs are mirrored; flip each column horizontally.
    transform: [{ scaleX: -1 }],
  },
  head: {
    color: HEAD_COLOR,
  },
  bright: {
    color: BRIGHT_COLOR,
  },
  mid: {
    color: MID_COLOR,
  },
  dim: {
    color: DIM_COLOR,
  },
});
