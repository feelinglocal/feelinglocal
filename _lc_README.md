# @redis-ai/langcache

Developer-friendly & type-safe Typescript SDK specifically catered to leverage *@redis-ai/langcache* API.

<!-- Start Summary [summary] -->
## Summary

LangCache: API for managing a [Redis LangCache](https://redis.io/docs/latest/develop/ai/langcache/) service.
<!-- End Summary [summary] -->

<!-- Start Table of Contents [toc] -->
## Table of Contents
<!-- $toc-max-depth=2 -->
* [@redis-ai/langcache](#redis-ailangcache)
  * [SDK Installation](#sdk-installation)
  * [Requirements](#requirements)
  * [SDK Example Usage](#sdk-example-usage)
  * [Available Resources and Operations](#available-resources-and-operations)
  * [Standalone functions](#standalone-functions)
  * [Retries](#retries)
  * [Error Handling](#error-handling)
  * [Custom HTTP Client](#custom-http-client)
  * [Debugging](#debugging)
* [Development](#development)
  * [Maturity](#maturity)

<!-- End Table of Contents [toc] -->

<!-- Start SDK Installation [installation] -->
## SDK Installation

The SDK can be installed with either [npm](https://www.npmjs.com/), [pnpm](https://pnpm.io/), [bun](https://bun.sh/) or [yarn](https://classic.yarnpkg.com/en/) package managers.

### NPM

```bash
npm add @redis-ai/langcache
```

### PNPM

```bash
pnpm add @redis-ai/langcache
```

### Bun

```bash
bun add @redis-ai/langcache
```

### Yarn

```bash
yarn add @redis-ai/langcache zod

# Note that Yarn does not install peer dependencies automatically. You will need
# to install zod as shown above.
```

> [!NOTE]
> This package is published with CommonJS and ES Modules (ESM) support.
<!-- End SDK Installation [installation] -->

<!-- Start Requirements [requirements] -->
## Requirements

For supported JavaScript runtimes, please consult [RUNTIMES.md](RUNTIMES.md).
<!-- End Requirements [requirements] -->

<!-- Start SDK Example Usage [usage] -->
## SDK Example Usage

### Save an entry

Save an entry to the cache

```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.set({
    prompt: "How does semantic caching work?",
    response:
      "Semantic caching stores and retrieves data based on meaning, not exact matches.",
  });

  console.log(result);
}

run();

```

### Search for entries

Search for entries in the cache

```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.search({
    prompt: "How does semantic caching work?",
  });

  console.log(result);
}

run();

```

### Delete an entry

Delete an entry from the cache by id

```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  await langCache.deleteById("<id>");
}

run();

```

### Delete entries

Delete entries based on attributes

```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.deleteQuery({
    attributes: {
      "language": "en",
      "topic": "ai",
    },
  });

  console.log(result);
}

run();

```
<!-- End SDK Example Usage [usage] -->

### Use exact search

Search for entries in the cache using both exact and semantic search

```typescript
import { LangCache } from "@redis-ai/langcache";
import { SearchStrategy } from '@redis-ai/langcache/models/searchstrategy.js';

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.search({
    prompt: "How does semantic caching work?",
    searchStrategies: [SearchStrategy.Exact, SearchStrategy.Semantic],
  });

  console.log(result);
}

run();

```

<!-- No Authentication [security] -->

<!-- Start Available Resources and Operations [operations] -->
## Available Resources and Operations

<details open>
<summary>Available methods</summary>

### [LangCache SDK](docs/sdks/langcache/README.md)

* [deleteQuery](docs/sdks/langcache/README.md#deletequery) - Deletes multiple cache entries based on specified attributes. If no attributes are provided, all entries in the cache are deleted.
* [set](docs/sdks/langcache/README.md#set) - Adds an entry to the cache with a prompt and response.
* [search](docs/sdks/langcache/README.md#search) - Searches the cache for entries that match the prompt and attributes. If no entries are found, this endpoint returns an empty array.
* [deleteById](docs/sdks/langcache/README.md#deletebyid) - Deletes a single cache entry by the entry ID.

</details>
<!-- End Available Resources and Operations [operations] -->

<!-- Start Standalone functions [standalone-funcs] -->
## Standalone functions

All the methods listed above are available as standalone functions. These
functions are ideal for use in applications running in the browser, serverless
runtimes or other environments where application bundle size is a primary
concern. When using a bundler to build your application, all unused
functionality will be either excluded from the final bundle or tree-shaken away.

To read more about standalone functions, check [FUNCTIONS.md](./FUNCTIONS.md).

<details>

<summary>Available standalone functions</summary>

- [`deleteById`](docs/sdks/langcache/README.md#deletebyid) - Deletes a single cache entry by the entry ID.
- [`deleteQuery`](docs/sdks/langcache/README.md#deletequery) - Deletes multiple cache entries based on specified attributes. If no attributes are provided, all entries in the cache are deleted.
- [`search`](docs/sdks/langcache/README.md#search) - Searches the cache for entries that match the prompt and attributes. If no entries are found, this endpoint returns an empty array.
- [`set`](docs/sdks/langcache/README.md#set) - Adds an entry to the cache with a prompt and response.

</details>
<!-- End Standalone functions [standalone-funcs] -->

<!-- No Global Parameters [global-parameters] -->

<!-- Start Retries [retries] -->
## Retries

Some of the endpoints in this SDK support retries.  If you use the SDK without any configuration, it will fall back to the default retry strategy provided by the API.  However, the default retry strategy can be overridden on a per-operation basis, or across the entire SDK.

To change the default retry strategy for a single API call, simply provide a retryConfig object to the call:
```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.deleteQuery({
    attributes: {
      "language": "en",
      "topic": "ai",
    },
  }, {
    retries: {
      strategy: "backoff",
      backoff: {
        initialInterval: 1,
        maxInterval: 50,
        exponent: 1.1,
        maxElapsedTime: 100,
      },
      retryConnectionErrors: false,
    },
  });

  console.log(result);
}

run();

```

If you'd like to override the default retry strategy for all operations that support retries, you can provide a retryConfig at SDK initialization:
```typescript
import { LangCache } from "@redis-ai/langcache";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  retryConfig: {
    strategy: "backoff",
    backoff: {
      initialInterval: 1,
      maxInterval: 50,
      exponent: 1.1,
      maxElapsedTime: 100,
    },
    retryConnectionErrors: false,
  },
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const result = await langCache.deleteQuery({
    attributes: {
      "language": "en",
      "topic": "ai",
    },
  });

  console.log(result);
}

run();

```
<!-- End Retries [retries] -->

<!-- Start Error Handling [errors] -->
## Error Handling

[`LangCacheError`](./src/models/errors/langcacheerror.ts) is the base class for all HTTP error responses. It has the following properties:

| Property            | Type       | Description                                                                             |
| ------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `error.message`     | `string`   | Error message                                                                           |
| `error.statusCode`  | `number`   | HTTP response status code eg `404`                                                      |
| `error.headers`     | `Headers`  | HTTP response headers                                                                   |
| `error.body`        | `string`   | HTTP body. Can be empty string if no body is returned.                                  |
| `error.rawResponse` | `Response` | Raw HTTP response                                                                       |
| `error.data$`       |            | Optional. Some errors may contain structured data. [See Error Classes](#error-classes). |

### Example
```typescript
import { LangCache } from "@redis-ai/langcache";
import * as errors from "@redis-ai/langcache/models/errors";

const langCache = new LangCache({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  try {
    const result = await langCache.deleteQuery({
      attributes: {
        "language": "en",
        "topic": "ai",
      },
    });

    console.log(result);
  } catch (error) {
    // The base class for HTTP error responses
    if (error instanceof errors.LangCacheError) {
      console.log(error.message);
      console.log(error.statusCode);
      console.log(error.body);
      console.log(error.headers);

      // Depending on the method different errors may be thrown
      if (error instanceof errors.BadRequestErrorResponseContent) {
        console.log(error.data$.title); // string
        console.log(error.data$.status); // number
        console.log(error.data$.detail); // string
        console.log(error.data$.instance); // string
        console.log(error.data$.type); // models.BadRequestErrorURI
      }
    }
  }
}

run();

```

### Error Classes
**Primary errors:**
* [`LangCacheError`](./src/models/errors/langcacheerror.ts): The base class for HTTP error responses.
  * [`BadRequestErrorResponseContent`](./src/models/errors/badrequesterrorresponsecontent.ts): BadRequestError 400 response. Status code `400`.
  * [`AuthenticationErrorResponseContent`](./src/models/errors/authenticationerrorresponsecontent.ts): AuthenticationError 401 response. Status code `401`.
  * [`ForbiddenErrorResponseContent`](./src/models/errors/forbiddenerrorresponsecontent.ts): ForbiddenError 403 response. Status code `403`.
  * [`NotFoundErrorResponseContent`](./src/models/errors/notfounderrorresponsecontent.ts): NotFoundError 404 response. Status code `404`.
  * [`PayloadTooLargeErrorResponseContent`](./src/models/errors/payloadtoolargeerrorresponsecontent.ts): PayloadTooLargeError 413 response. Status code `413`.
  * [`ResourceUnavailableErrorResponseContent`](./src/models/errors/resourceunavailableerrorresponsecontent.ts): ResourceUnavailableError 424 response. Status code `424`.
  * [`TooManyRequestsErrorResponseContent`](./src/models/errors/toomanyrequestserrorresponsecontent.ts): TooManyRequestsError 429 response. Status code `429`.
  * [`UnexpectedErrorResponseContent`](./src/models/errors/unexpectederrorresponsecontent.ts): UnexpectedError 500 response. Status code `500`.

<details><summary>Less common errors (6)</summary>

<br />

**Network errors:**
* [`ConnectionError`](./src/models/errors/httpclienterrors.ts): HTTP client was unable to make a request to a server.
* [`RequestTimeoutError`](./src/models/errors/httpclienterrors.ts): HTTP request timed out due to an AbortSignal signal.
* [`RequestAbortedError`](./src/models/errors/httpclienterrors.ts): HTTP request was aborted by the client.
* [`InvalidRequestError`](./src/models/errors/httpclienterrors.ts): Any input used to create a request is invalid.
* [`UnexpectedClientError`](./src/models/errors/httpclienterrors.ts): Unrecognised or unexpected error.


**Inherit from [`LangCacheError`](./src/models/errors/langcacheerror.ts)**:
* [`ResponseValidationError`](./src/models/errors/responsevalidationerror.ts): Type mismatch between the data returned from the server and the structure expected by the SDK. See `error.rawValue` for the raw value and `error.pretty()` for a nicely formatted multi-line string.

</details>
<!-- End Error Handling [errors] -->

<!-- Start Custom HTTP Client [http-client] -->
## Custom HTTP Client

The TypeScript SDK makes API calls using an `HTTPClient` that wraps the native
[Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). This
client is a thin wrapper around `fetch` and provides the ability to attach hooks
around the request lifecycle that can be used to modify the request or handle
errors and response.

The `HTTPClient` constructor takes an optional `fetcher` argument that can be
used to integrate a third-party HTTP client or when writing tests to mock out
the HTTP client and feed in fixtures.

The following example shows how to use the `"beforeRequest"` hook to to add a
custom header and a timeout to requests and how to use the `"requestError"` hook
to log errors:

```typescript
import { LangCache } from "@redis-ai/langcache";
import { HTTPClient } from "@redis-ai/langcache/lib/http";

const httpClient = new HTTPClient({
  // fetcher takes a function that has the same signature as native `fetch`.
  fetcher: (request) => {
    return fetch(request);
  }
});

httpClient.addHook("beforeRequest", (request) => {
  const nextRequest = new Request(request, {
    signal: request.signal || AbortSignal.timeout(5000)
  });

  nextRequest.headers.set("x-custom-header", "custom value");

  return nextRequest;
});

httpClient.addHook("requestError", (error, request) => {
  console.group("Request Error");
  console.log("Reason:", `${error}`);
  console.log("Endpoint:", `${request.method} ${request.url}`);
  console.groupEnd();
});

const sdk = new LangCache({ httpClient });
```
<!-- End Custom HTTP Client [http-client] -->

<!-- Start Debugging [debug] -->
## Debugging

You can setup your SDK to emit debug logs for SDK requests and responses.

You can pass a logger that matches `console`'s interface as an SDK option.

> [!WARNING]
> Beware that debug logging will reveal secrets, like API tokens in headers, in log messages printed to a console or files. It's recommended to use this feature only during local development and not in production.

```typescript
import { LangCache } from "@redis-ai/langcache";

const sdk = new LangCache({ debugLogger: console });
```
<!-- End Debugging [debug] -->

<!-- Placeholder for Future Speakeasy SDK Sections -->

# Development

## Maturity

This SDK is in beta, and there may be breaking changes between versions without a major version update. Therefore, we recommend pinning usage
to a specific package version. This way, you can install the same version each time without breaking changes unless you are intentionally
looking for the latest version.

