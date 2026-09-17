// The shared, org-synced ruleset lives in eslint.config.base.mjs (synced from
// cplieger/ci). Do NOT edit the base here — the next sync would clobber it.
//
// This repo needs no deltas on top of it: the base's own "*.mjs" entries in
// allowDefaultProject and disableTypeChecked already cover both this file and
// the bare-named vendored base. Until 2026-09-16 this file carried an inlined
// FORK of the base instead, so the vendored copy was unreferenced and every
// ruleset change synced from cplieger/ci reached the other eight TS packages
// and not this one.
export { default } from "./eslint.config.base.mjs";
