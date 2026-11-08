# Moving to reactive 2.4

`@cplieger/reactive` 2.4 holds the app foundation that `@cplieger/ui` 1.x carried beside its widgets: signals, the DOM helpers, typed requests and server actions. This page is for code that imports them from `@cplieger/ui`, or from an earlier release of `@cplieger/reactive`.

## From @cplieger/ui 1.x

| Earlier import | Import from |
| --- | --- |
| `@cplieger/ui` | `@cplieger/reactive` |
| `@cplieger/ui/signal` | `@cplieger/reactive/signal` |
| `@cplieger/ui/dom` | `@cplieger/reactive/dom` |
| `@cplieger/ui/fetch` | `@cplieger/reactive/fetch` |
| `@cplieger/ui/actions` | `@cplieger/reactive/actions` |
| `@cplieger/ui/actions/testing` | `@cplieger/reactive/actions/testing` |

The exported names are the same, and so is their behaviour, with two exceptions:

- The errors the package throws, and the message it logs when an `onError` callback throws, begin with `@cplieger/reactive:` instead of `@cplieger/ui:`.
- `withAsyncFeedback` builds its default glyphs without `innerHTML`, so it works on a page that enforces Trusted Types. It always resolves and gives the button back when a renderer throws, and a button that `fn` removes from the page comes back enabled. A call made while the previous glyph is still up starts from the button's own content. Its live region hides itself with inline styles, and is rebuilt when it leaves the document.

The widgets, icons and stylesheets stay in `@cplieger/ui`.

`@cplieger/ui` 1.x carries its own copy of the signal engine, and its widgets bind to that copy, not to this one. In an app that runs both:

- Move every `/signal`, `/dom` and `/actions` import to `@cplieger/reactive` in one change, so the app's own code shares one graph.
- A ui 1.x widget created under a `@cplieger/reactive` owner, such as a `createRoot` or a `bindList` row, does not end when that owner is disposed. Create it under ui 1.x's `createRoot`, or dispose it yourself.
- ui 1.x's `untracked` does not shield reads of `@cplieger/reactive` signals, and its `isSignal` returns false for them.

## From @cplieger/reactive 2.3

The package root exports the same names, and they behave the same. Two things changed:

- The signal and DOM functions are also importable from `@cplieger/reactive/signal` and `@cplieger/reactive/dom`, and the package adds `/fetch`, `/actions` and `/actions/testing`.
- The errors the package throws begin with `@cplieger/reactive:` instead of `reactive:`.
