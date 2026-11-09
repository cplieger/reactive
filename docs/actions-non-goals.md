# What the actions module leaves out

This page lists what `@cplieger/reactive/actions` leaves out on purpose, with the reason for each. It is for a developer deciding whether the module fits, or about to propose one of these as a feature.

| Feature | Reason |
| --- | --- |
| Query caching, stale-while-revalidate | This is an action runner, not a data cache. Use TanStack Query alongside it. |
| Cache invalidation, revalidation | A data-cache concern. |
| Framework adapters for React, Vue or Svelte | Vanilla TypeScript by design. Framework bindings belong in separate packages. |
| Visual DevTools panel | A separate package. `getActionLog` and `subscribeByName` give it the data. |
| SSR and hydration | Actions are imperative mutations, with no state to carry from server to client. |
| Debounce `maxWait` | A deliberate simplification. Call `flush()` when a dispatch must fire. |
| Throttle helper | Not specific to actions. Throttle before you call `dispatch()`. |
| `condition` or a pre-execution guard | An `if` in the caller does it. `dedupe` covers the main case. |
| `onProgress` callback | Transport-specific. Report progress from your `run()` function. |
| Batch dispatch | A store concern, and this module does not own a store. |
| `dispose()` or action deregistration | An idle action holds little memory, so a realistic app does not leak. |
