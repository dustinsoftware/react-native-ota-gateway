import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { CELL_WIDTH, columnCount } from './matrix-rain-layout';

/**
 * Decorative "digital rain" background for the developer screen: columns of
 * random ASCII glyphs falling at varied speeds. Purely cosmetic and
 * non-interactive (`pointerEvents="none"`); rendered behind the screen content
 * at low opacity so the foreground stays legible.
 */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%*+=/<>|';
const ROW_HEIGHT = 16;
const FONT_SIZE = 14;
const MIN_ROWS = 8;
const ROW_JITTER = 16;
const FALL_DURATION_MIN_MS = 4000;
const FALL_DURATION_JITTER_MS = 6000;
const START_DELAY_MAX_MS = 5000;

const HEAD_COLOR = '#CCFFCC';
const TRAIL_COLOR = '#22DD66';
const BACKDROP_COLOR = '#000000';

function randomGlyph(): string {
  return GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
}

type ColumnSpec = {
  key: number;
  x: number;
  rows: number;
  duration: number;
  startDelay: number;
};

function Column({ spec, fall }: { spec: ColumnSpec; fall: number }) {
  const columnHeight = spec.rows * ROW_HEIGHT;
  const translateY = useRef(new Animated.Value(-columnHeight)).current;
  const trail = useMemo(
    () => Array.from({ length: Math.max(0, spec.rows - 1) }, randomGlyph).join('\n'),
    [spec.rows],
  );

  useEffect(() => {
    // Fall from just above the top to just past the bottom, then repeat. The
    // per-column duration and start delay desync the columns so it reads as
    // organic rain rather than a marching grid. translateY is layout-independent,
    // so the native driver is safe; react-native-web has no native driver, so
    // fall back to the JS driver there to avoid a console warning.
    const loop = Animated.loop(
      Animated.timing(translateY, {
        toValue: fall + columnHeight,
        duration: spec.duration,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    const timer = setTimeout(() => loop.start(), spec.startDelay);
    return () => {
      clearTimeout(timer);
      loop.stop();
    };
  }, [translateY, fall, columnHeight, spec.duration, spec.startDelay]);

  return (
    <Animated.View style={[styles.column, { left: spec.x, transform: [{ translateY }] }]}>
      <Text style={[styles.glyph, styles.head]}>{randomGlyph()}</Text>
      <Text style={[styles.glyph, styles.trail]}>{trail}</Text>
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
      duration: FALL_DURATION_MIN_MS + Math.floor(Math.random() * FALL_DURATION_JITTER_MS),
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
  },
  head: {
    color: HEAD_COLOR,
  },
  trail: {
    color: TRAIL_COLOR,
  },
});
