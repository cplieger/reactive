/**
 * Internal test helper for the browser's own focus moves.
 */

/** Resolves when the browser fires `blur` on `el`. Chromium 153 queues the
 *  blur that a `disabled` write causes, later than a `MessageChannel` task
 *  (https://issues.chromium.org/issues/519062393), so the event is the only
 *  reliable signal. Attach BEFORE the disabling write: Chromium 152 and
 *  earlier fire the blur from inside it. */
export function blurredOff(el: HTMLElement): Promise<void> {
  return new Promise<void>((resolve) => {
    el.addEventListener(
      "blur",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}
