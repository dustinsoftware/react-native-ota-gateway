// Committed companion to the generated, git-ignored expo-env.d.ts.
//
// expo-env.d.ts (which carries `/// <reference types="expo/types" />`) is only
// written by the Expo CLI on dev/build/prebuild, so it is absent in a fresh
// checkout -- which drops the Expo/Metro ambient types and breaks `tsc`
// (notably `require.context` in src/brownfield/entry.tsx). Referencing the types
// here keeps the typecheck deterministic regardless of whether expo-env.d.ts has
// been generated.
/// <reference types="expo/types" />
