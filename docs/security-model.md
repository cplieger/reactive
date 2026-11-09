# Base URLs and untrusted responses

This page covers what the library guards against when a path or a response comes from someone else. It is for a developer who builds paths from user input or calls a server they do not control.

## Paths and base URLs

`path` is meant to be relative. With an absolute `baseUrl`, one with a scheme and host, the configured scheme and host always come first:

- An absolute path such as `https://other.example/x` or a protocol-relative path such as `//host/x` is kept as a path segment and cannot change the origin.
- A `..` or `.` segment, including its percent-encoded forms, is encoded so it cannot climb out of the base path. Backslashes and tab, line feed and carriage return characters in the path are encoded too.
- The query string and fragment are sent as written.
- A trailing slash on `baseUrl` and a leading slash on `path` join as one slash.

The protection needs a `baseUrl` with a scheme and host. With an empty or relative `baseUrl`, a protocol-relative path can still reach another origin.

With no `baseUrl`, `path` goes to `fetch()` unchanged. Your code then owns the whole URL, so never pass untrusted input, such as a string from a server, as the whole path.

## Response size cap

`maxResponseBytes` caps the response body, read as JSON or as a `Blob`. It is unset by default, which means no limit, and `Infinity` means the same. With a cap, a response whose `content-length` is over it, or whose streamed body grows past it, is refused instead of buffered. This guards a server-side caller against a hostile upstream.

A 2xx body over the cap gives `code: "network"` with `status` 0. An error body over the cap is dropped, and `error` falls back to `HTTP <status>`.

`createFetch` throws a `TypeError` for a cap of `NaN`, which is what `Number(process.env.MAX_BYTES)` gives when the variable is unset. A `NaN` cap would never be reached, so the body would be read without a limit while the code looks capped. It throws for a negative cap too, which would refuse every body that is not empty. A cap of 0 accepts only empty bodies.

## Server-controlled fields

`ApiErr.error`, `ApiErr.code` and `ApiErr.body` come from the server on a non-2xx response. Validate `body` before you read a field, and render any text from it with `textContent`, never `innerHTML`.

A server can send a `code` that matches one of the library's own, such as `timeout`. The library's codes carry `status` 0, except `decode`, which carries the 2xx status. A server's code always carries its non-2xx status. So check `status` before you act on `code`.
