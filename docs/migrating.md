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

The exported names are the same, and so is their behaviour. The one difference: the errors the package throws, and the message it logs when an `onError` callback throws, begin with `@cplieger/reactive:` instead of `@cplieger/ui:`.

The widgets, icons and stylesheets stay in `@cplieger/ui`.

## From @cplieger/reactive 2.3

The package root exports the same names, and they behave the same. Two things changed:

- The signal and DOM functions are also importable from `@cplieger/reactive/signal` and `@cplieger/reactive/dom`, and the package adds `/fetch`, `/actions` and `/actions/testing`.
- The errors the package throws begin with `@cplieger/reactive:` instead of `reactive:`.
