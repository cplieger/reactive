# Results and errors

This page lists what every request returns, for a developer writing the code that branches on the result.

## The result type

`requestRaw` and the `*Raw` helpers resolve to `ApiResult<T>`, a union of `ApiOk<T>` and `ApiErr` that you narrow on `ok`. They never throw.

| Field | On | Meaning |
| --- | --- | --- |
| `ok` | both | `true` on a 2xx response, unless its body is not JSON or fails the decoder. `false` otherwise |
| `status` | both | The HTTP status, or 0 when no response arrived |
| `data` | `ApiOk` | The parsed or decoded body, or a `Blob` under `as: "blob"`. `undefined` for a 204 or an empty body read as JSON |
| `headers` | `ApiOk` | The response `Headers`, always present |
| `error` | `ApiErr` | A readable message |
| `code` | `ApiErr` | One of the library codes below, or a code the server sent |
| `requestId` | `ApiErr` | The `request_id` or `requestId` field of a JSON error body |
| `headers` | `ApiErr` | The response `Headers` whenever a response arrived. Absent when `status` is 0 |
| `body` | `ApiErr` | The parsed JSON body of a failed response, of any shape. Absent on a non-JSON or empty body and when `status` is 0 |

## Error codes

| `code` | `status` | When |
| --- | --- | --- |
| `network` | 0 | `fetch` failed for a reason other than a timeout or your abort, or a 2xx body could not be read or went over `maxResponseBytes` |
| `timeout` | 0 | The request timeout fired before the response finished |
| `cancelled` | 0 | Your `signal` was aborted, before or during the request |
| `invalid` | 0 | The request could not be built, so nothing was sent |
| `decode` | the real 2xx status | The body was not JSON, or the decoder threw |
| any other value | the real non-2xx status | The server sent it in the error body |

A request is `invalid` when the body cannot be JSON-encoded, such as a circular object, a `BigInt`, a function or a symbol. It is also `invalid` when `body` and `rawBody` are both set, when JavaScript code passes `as: "blob"` with a `decoder` or `ignoreBody`, when a header name or value is rejected, or when `prepareHeaders` throws. A `timeoutMs` below 0, above `Number.MAX_SAFE_INTEGER` or not finite, such as `NaN` or `Infinity`, is `invalid` too. If your signal was already aborted, a build failure is reported as `cancelled` instead.

A `decode` error message starts with `response not JSON:` or `response shape mismatch:`. On a decoder mismatch, `body` holds the parsed value the decoder refused.

## Error responses

For a non-2xx response, the library reads the body as JSON when it can. A string `error` field becomes `error`, a string `code` field becomes `code`, and a string `request_id` or `requestId` field becomes `requestId`. Without them, `error` is `HTTP <status>`. The response headers are always kept, so a rate limit's `Retry-After` is readable:

```typescript
const res = await api.apiGetRaw("/items");
if (!res.ok && res.status === 429) {
  console.warn("retry after", res.headers?.get("Retry-After"));
}
```

A 409 whose body describes the conflict is readable from `res.body`. Validate its shape before you read a field. The server controls `code` too, and it can send `timeout` or any other library code. Tell the two apart by `status`. The library's codes carry 0, except `decode`, which carries the 2xx status. A server code always carries its non-2xx status.

## Empty bodies

A 204, or a 2xx with an empty body, gives `data: undefined`. With a `*Raw` helper on an endpoint that can answer 204, type `T` to include `undefined`, or branch on `status`. A JSON `null`, `0`, `false` or `""` body is real data and passes through unchanged.

Under `as: "blob"`, an empty 2xx body and a 204 both give an empty `Blob`, so `data` is always a `Blob` on success.

`ignoreBody: true` skips reading a 2xx body and gives `data: undefined` without calling the decoder. An error body is still read.

## The three helper forms

| Form | Returns | Helpers |
| --- | --- | --- |
| Plain | the data, or `null` on any error or empty body | `request`, `apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete` |
| Raw | the full `ApiResult<T>` | `requestRaw`, `apiGetRaw`, `apiPostRaw`, `apiPutRaw`, `apiPatchRaw`, `apiDeleteRaw` |
| Typed | the decoded data, or `null` | `apiGetTyped`, `apiPostTyped` |

`apiPut`, `apiPatch` and `apiDelete`, and their `*Raw` forms, validate through the `decoder` option instead, for example `api.apiPut(path, body, { decoder })`.

## Decoders

A `Decoder<T>` is a function that takes the parsed body as `unknown` and returns a `T` or throws. The library ships the type and calls it on a 2xx body. It ships no validators, so you write your own or use a schema library.

```typescript
import { type Decoder } from "@cplieger/reactive/fetch";

const decodeUser: Decoder<{ id: string }> = (v) => {
  if (typeof v !== "object" || v === null || typeof (v as { id?: unknown }).id !== "string") {
    throw new Error("expected { id: string }");
  }
  return v as { id: string };
};

const user = await api.apiGetTyped("/users/me", decodeUser); // { id: string } | null
```
