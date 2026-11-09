# What the fetch module leaves out

This page lists what `@cplieger/reactive/fetch` leaves out on purpose, for a developer wondering whether a missing feature is coming. The library is the request and response envelope only. These are decisions, not a backlog.

| Feature | Reason |
| --- | --- |
| Retries and backoff | They belong to the code that dispatches the request. Use [`@cplieger/reactive/actions`](lifecycle.md) or your own retry helper |
| Idempotency-key or `X-Request-ID` injection | Pass them per request in `headers`, or set them in `prepareHeaders` |
| Interceptor or middleware chains | `prepareHeaders` sets headers on every request, `onError` sees every failure, and a custom `fetchFn` can wrap the call itself, so no plugin pipeline is needed |
| Decoder combinators | The library ships only the `Decoder<T>` type and calls it. Keep your own validators, hand-written or from a library such as zod or valibot |
| Response caching and revalidation | This is a request envelope, not a data cache |
| Changeable or global settings | Settings are frozen at `createFetch`. A changed backend is a new instance, and state that changes per request is read inside `prepareHeaders` |
| Streamed responses or the raw `Response` | A body is read whole, as JSON or with `as: "blob"` as a `Blob`. Call `fetch` directly for a streamed body, `statusText`, `url` or `redirected` |
