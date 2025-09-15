# LangCache SDK

## Overview

LangCache: API for managing a [Redis LangCache](https://redis.io/docs/latest/develop/ai/langcache/) service.

### Available Operations

* [deleteQuery](#deletequery) - Deletes multiple cache entries based on specified attributes. If no attributes are provided, all entries in the cache are deleted.
* [set](#set) - Adds an entry to the cache with a prompt and response.
* [search](#search) - Searches the cache for entries that match the prompt and attributes. If no entries are found, this endpoint returns an empty array.
* [deleteById](#deletebyid) - Deletes a single cache entry by the entry ID.

## deleteQuery

Deletes multiple cache entries based on specified attributes. If no attributes are provided, all entries in the cache are deleted.

### Example Usage

<!-- UsageSnippet language="typescript" operationID="deleteQuery" method="delete" path="/v1/caches/{cacheId}/entries" -->
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

### Standalone function

The standalone function version of this method:

```typescript
import { LangCacheCore } from "@redis-ai/langcache/core.js";
import { deleteQuery } from "@redis-ai/langcache/funcs/deleteQuery.js";

// Use `LangCacheCore` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const langCache = new LangCacheCore({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const res = await deleteQuery(langCache, {
    attributes: {
      "language": "en",
      "topic": "ai",
    },
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("deleteQuery failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `attributes`                                                                                                                                                                   | Record<string, *string*>                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                             | N/A                                                                                                                                                                            |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[models.DeleteQueryResponse](../../models/deletequeryresponse.md)\>**

### Errors

| Error Type                                     | Status Code                                    | Content Type                                   |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| errors.BadRequestErrorResponseContent          | 400                                            | application/json                               |
| errors.AuthenticationErrorResponseContent      | 401                                            | application/json                               |
| errors.ForbiddenErrorResponseContent           | 403                                            | application/json                               |
| errors.NotFoundErrorResponseContent            | 404                                            | application/json                               |
| errors.PayloadTooLargeErrorResponseContent     | 413                                            | application/json                               |
| errors.ResourceUnavailableErrorResponseContent | 424                                            | application/json                               |
| errors.TooManyRequestsErrorResponseContent     | 429                                            | application/json                               |
| errors.UnexpectedErrorResponseContent          | 500                                            | application/json                               |
| errors.LangCacheDefaultError                   | 4XX, 5XX                                       | \*/\*                                          |

## set

Adds an entry to the cache with a prompt and response.

### Example Usage

<!-- UsageSnippet language="typescript" operationID="set" method="post" path="/v1/caches/{cacheId}/entries" -->
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
    response: "Semantic caching stores and retrieves data based on meaning, not exact matches.",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { LangCacheCore } from "@redis-ai/langcache/core.js";
import { set } from "@redis-ai/langcache/funcs/set.js";

// Use `LangCacheCore` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const langCache = new LangCacheCore({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const res = await set(langCache, {
    prompt: "How does semantic caching work?",
    response: "Semantic caching stores and retrieves data based on meaning, not exact matches.",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("set failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                                                                                                                                                                       | *string*                                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                             | The prompt for the entry.                                                                                                                                                      |
| `response`                                                                                                                                                                     | *string*                                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                             | The response to the prompt for the entry.                                                                                                                                      |
| `attributes`                                                                                                                                                                   | Record<string, *string*>                                                                                                                                                       | :heavy_minus_sign:                                                                                                                                                             | N/A                                                                                                                                                                            |
| `ttlMillis`                                                                                                                                                                    | *number*                                                                                                                                                                       | :heavy_minus_sign:                                                                                                                                                             | The entry's time-to-live, in milliseconds. If not set, the cache's default TTL is used.                                                                                        |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[models.SetResponse](../../models/setresponse.md)\>**

### Errors

| Error Type                                     | Status Code                                    | Content Type                                   |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| errors.BadRequestErrorResponseContent          | 400                                            | application/json                               |
| errors.AuthenticationErrorResponseContent      | 401                                            | application/json                               |
| errors.ForbiddenErrorResponseContent           | 403                                            | application/json                               |
| errors.NotFoundErrorResponseContent            | 404                                            | application/json                               |
| errors.PayloadTooLargeErrorResponseContent     | 413                                            | application/json                               |
| errors.ResourceUnavailableErrorResponseContent | 424                                            | application/json                               |
| errors.TooManyRequestsErrorResponseContent     | 429                                            | application/json                               |
| errors.UnexpectedErrorResponseContent          | 500                                            | application/json                               |
| errors.LangCacheDefaultError                   | 4XX, 5XX                                       | \*/\*                                          |

## search

Searches the cache for entries that match the prompt and attributes. If no entries are found, this endpoint returns an empty array.

### Example Usage

<!-- UsageSnippet language="typescript" operationID="search" method="post" path="/v1/caches/{cacheId}/entries/search" -->
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

### Standalone function

The standalone function version of this method:

```typescript
import { LangCacheCore } from "@redis-ai/langcache/core.js";
import { search } from "@redis-ai/langcache/funcs/search.js";

// Use `LangCacheCore` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const langCache = new LangCacheCore({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const res = await search(langCache, {
    prompt: "How does semantic caching work?",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("search failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`                                                                                                                                                                       | *string*                                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                             | The prompt to search for in the cache.                                                                                                                                         |
| `similarityThreshold`                                                                                                                                                          | *number*                                                                                                                                                                       | :heavy_minus_sign:                                                                                                                                                             | The minimum similarity threshold for the cache entry (normalized cosine similarity).                                                                                           |
| `searchStrategies`                                                                                                                                                             | [models.SearchStrategy](../../models/searchstrategy.md)[]                                                                                                                      | :heavy_minus_sign:                                                                                                                                                             | The search strategies to use for the search, ordered by priority.                                                                                                              |
| `attributes`                                                                                                                                                                   | Record<string, *string*>                                                                                                                                                       | :heavy_minus_sign:                                                                                                                                                             | N/A                                                                                                                                                                            |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[models.SearchResponse](../../models/searchresponse.md)\>**

### Errors

| Error Type                                     | Status Code                                    | Content Type                                   |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| errors.BadRequestErrorResponseContent          | 400                                            | application/json                               |
| errors.AuthenticationErrorResponseContent      | 401                                            | application/json                               |
| errors.ForbiddenErrorResponseContent           | 403                                            | application/json                               |
| errors.NotFoundErrorResponseContent            | 404                                            | application/json                               |
| errors.PayloadTooLargeErrorResponseContent     | 413                                            | application/json                               |
| errors.ResourceUnavailableErrorResponseContent | 424                                            | application/json                               |
| errors.TooManyRequestsErrorResponseContent     | 429                                            | application/json                               |
| errors.UnexpectedErrorResponseContent          | 500                                            | application/json                               |
| errors.LangCacheDefaultError                   | 4XX, 5XX                                       | \*/\*                                          |

## deleteById

Deletes a single cache entry by the entry ID.

### Example Usage

<!-- UsageSnippet language="typescript" operationID="deleteById" method="delete" path="/v1/caches/{cacheId}/entries/{entryId}" -->
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

### Standalone function

The standalone function version of this method:

```typescript
import { LangCacheCore } from "@redis-ai/langcache/core.js";
import { deleteById } from "@redis-ai/langcache/funcs/deleteById.js";

// Use `LangCacheCore` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const langCache = new LangCacheCore({
  serverURL: "https://api.example.com",
  cacheId: "<id>",
  apiKey: "<LANGCACHE_API_KEY>",
});

async function run() {
  const res = await deleteById(langCache, "<id>");
  if (res.ok) {
    const { value: result } = res;
    
  } else {
    console.log("deleteById failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entryId`                                                                                                                                                                      | *string*                                                                                                                                                                       | :heavy_check_mark:                                                                                                                                                             | Unique ID for the cache entry.                                                                                                                                                 |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<void\>**

### Errors

| Error Type                                     | Status Code                                    | Content Type                                   |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| errors.BadRequestErrorResponseContent          | 400                                            | application/json                               |
| errors.AuthenticationErrorResponseContent      | 401                                            | application/json                               |
| errors.ForbiddenErrorResponseContent           | 403                                            | application/json                               |
| errors.NotFoundErrorResponseContent            | 404                                            | application/json                               |
| errors.PayloadTooLargeErrorResponseContent     | 413                                            | application/json                               |
| errors.ResourceUnavailableErrorResponseContent | 424                                            | application/json                               |
| errors.TooManyRequestsErrorResponseContent     | 429                                            | application/json                               |
| errors.UnexpectedErrorResponseContent          | 500                                            | application/json                               |
| errors.LangCacheDefaultError                   | 4XX, 5XX                                       | \*/\*                                          |
