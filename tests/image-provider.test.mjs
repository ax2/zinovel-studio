import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import {
  imageGenerationRequest,
  imageGenerationPreflight,
  imageGenerationBudget,
  imageGenerationLimits,
} from "../packages/novel-domain/image-generation.mjs";
import {
  requestImageCandidates,
  ImageProviderError,
} from "../packages/novel-harness/image-provider.mjs";

const keyA = "synthetic-image-A-only",
  keyB = "synthetic-image-B-only";
const images = await Promise.all(
  ["png", "jpeg", "webp"].map((format) =>
    sharp({
      create: {
        width: 64,
        height: 32,
        channels: 4,
        background: { r: 35, g: 92, b: 129, alpha: 1 },
      },
    })
      .toFormat(format)
      .toBuffer(),
  ),
);
const document = (buffers = [images[0]]) => ({
  data: buffers.map((bytes) => ({ b64_json: bytes.toString("base64") })),
});
const configuration = (url) => ({
  baseURL: url + "/tenant/v1/",
  model: "synthetic-image-model",
  apiKey: keyA,
  request: {
    prompt: "合成人物定妆，蓝色衣装𠮷。",
    n: 1,
    size: "1024x1024",
    responseMode: "default-base64",
  },
  budget: { maxImages: 4, maxCost: 0, pricing: null },
});
async function fixture(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        path: request.url,
        method: request.method,
        body: body ? JSON.parse(body) : null,
        keyA: request.headers.authorization === `Bearer ${keyA}`,
        keyB: request.headers.authorization === `Bearer ${keyB}`,
      });
      await handler(request, response, requests.at(-1));
    } catch {
      if (!response.destroyed) {
        response.writeHead(500);
        response.end();
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const reply = (response, value, headers = {}) => {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
};
const errorIs = (code, dispatched, remoteResult) => (error) => {
  assert.ok(error instanceof ImageProviderError);
  assert.equal(error.code, code);
  assert.equal(error.dispatched, dispatched);
  if (remoteResult) assert.equal(error.remoteResult, remoteResult);
  assert.ok(!String(error.stack).includes(keyA));
  assert.ok(!String(error.stack).includes(keyB));
  return true;
};

test("image request and manual pricing preflight require explicit compatible modes; unknown price is never zero", () => {
  const config = configuration("https://images.example");
  assert.equal(
    imageGenerationPreflight(config.request, config.budget).estimatedCost,
    null,
  );
  assert.equal(
    imageGenerationPreflight(config.request, {
      maxImages: 1,
      pricing: { currency: "CNY", perImage: 3 },
      maxCost: 3,
    }).estimatedCost,
    3,
  );
  assert.throws(
    () =>
      imageGenerationPreflight({ ...config.request, n: 2 }, { maxImages: 1 }),
    /数量/,
  );
  assert.throws(
    () =>
      imageGenerationPreflight(config.request, {
        maxCost: 2,
        pricing: { currency: "CNY", perImage: 3 },
      }),
    /阈值/,
  );
  for (const patch of [
    { responseMode: undefined },
    { n: 0 },
    { n: 5 },
    { n: 1.5 },
    { size: "unbounded" },
    { prompt: "\ud800" },
    { prompt: "x".repeat(8001) },
    { referencePath: "arbitrary-local-file" },
  ])
    assert.throws(() =>
      imageGenerationRequest({ ...config.request, ...patch }),
    );
  for (const budget of [
    { maxCost: 1 },
    { maxImages: 5 },
    { pricing: { currency: "CNY", perImage: Infinity } },
    { pricing: { currency: "USD", perImage: -1 } },
    { maxOutputTokens: 100 },
  ])
    assert.throws(() => imageGenerationBudget(budget));
});

test("manual decimal price boundaries do not reject an exact budget or hide a representable overage", () => {
  const request = { ...configuration("https://images.example").request, n: 3 };
  const result = imageGenerationPreflight(request, {
    maxImages: 3,
    maxCost: 0.3,
    pricing: { currency: "CNY", perImage: 0.1 },
  });
  assert.equal(result.estimatedCost, 0.3);
  assert.throws(
    () =>
      imageGenerationPreflight(request, {
        maxImages: 3,
        maxCost: 0.3,
        pricing: { currency: "CNY", perImage: 0.10000000000000002 },
      }),
    /阈值/,
  );
});

test("actual HTTP uses only the frozen selected credential and tenant prefix; three image formats really decode and explicit modes differ", async () => {
  const service = await fixture((_request, response, entry) =>
    reply(response, {
      ...document(images.slice(0, entry.body.n)),
      usage: {
        input_tokens: 12,
        output_tokens: 18,
        total_tokens: 30,
        privateIgnored: keyA,
      },
    }),
  );
  try {
    let intents = 0;
    const config = configuration(service.url);
    config.request.n = 3;
    config.budget.pricing = { currency: "CNY", perImage: 2 };
    const result = await requestImageCandidates(config, {
      beforeDispatch: async () => {
        intents++;
        config.apiKey = keyB;
        config.model = "mutated-after-intent";
        config.request.prompt = "changed-after-intent";
      },
    });
    assert.equal(intents, 1);
    assert.equal(result.dispatched, true);
    assert.equal(result.remoteResult, "received");
    assert.deepEqual(
      result.candidates.map((c) => c.blob.format),
      ["png", "jpeg", "webp"],
    );
    result.candidates.forEach((candidate, i) => {
      assert.deepEqual(candidate.bytes, images[i]);
      assert.ok(candidate.thumbnail.length > 0);
    });
    assert.deepEqual(result.usage, {
      input_tokens: 12,
      output_tokens: 18,
      total_tokens: 30,
    });
    assert.equal(result.estimatedCost, 6);
    const next = configuration(service.url);
    next.apiKey = keyB;
    next.request.responseMode = "request-base64";
    const second = await requestImageCandidates(next, {
      beforeDispatch: async () => {},
    });
    assert.equal(second.candidates.length, 1);
    assert.deepEqual(
      service.requests.map((r) => [r.keyA, r.keyB]),
      [
        [true, false],
        [false, true],
      ],
    );
    assert.ok(
      service.requests.every(
        (r) =>
          r.path === "/tenant/v1/images/generations" && r.method === "POST",
      ),
    );
    assert.equal(service.requests[0].body.model, "synthetic-image-model");
    assert.ok(service.requests[0].body.prompt.includes("合成人物"));
    assert.equal(
      Object.hasOwn(service.requests[0].body, "response_format"),
      false,
    );
    assert.equal(service.requests[1].body.response_format, "b64_json");
    assert.ok(!JSON.stringify({ ...result, candidates: [] }).includes(keyA));
  } finally {
    await service.close();
  }
});

test("invalid settings, missing intent, budget excess, failed intent and pre-send cancellation cause zero network calls", async () => {
  const service = await fixture((_request, response) =>
    reply(response, document()),
  );
  try {
    for (const patch of [
      { baseURL: "https://name:secret@example.com" },
      { baseURL: "http://nonlocal.example" },
      { baseURL: "" },
      { apiKey: "" },
      { apiKey: "bad\nheader" },
      { model: "bad\nmodel" },
      {
        request: {
          ...configuration(service.url).request,
          responseMode: "guess-from-model",
        },
      },
      {
        budget: {
          maxImages: 1,
          maxCost: 1,
          pricing: { currency: "CNY", perImage: 2 },
        },
      },
    ])
      await assert.rejects(
        requestImageCandidates(
          { ...configuration(service.url), ...patch },
          { beforeDispatch: async () => {} },
        ),
        errorIs("INPUT", false, "not-sent"),
      );
    await assert.rejects(
      requestImageCandidates(configuration(service.url)),
      errorIs("INPUT", false),
    );
    await assert.rejects(
      requestImageCandidates(configuration(service.url), {
        beforeDispatch: async () => {
          throw new Error(keyA);
        },
      }),
      errorIs("INTENT", false),
    );
    const cancelled = AbortSignal.abort();
    await assert.rejects(
      requestImageCandidates(configuration(service.url), {
        signal: cancelled,
        beforeDispatch: async () =>
          assert.fail("pre-cancel must not save intent"),
      }),
      errorIs("CANCELLED", false),
    );
    const abort = new AbortController();
    await assert.rejects(
      requestImageCandidates(configuration(service.url), {
        signal: abort.signal,
        beforeDispatch: async () => abort.abort(),
      }),
      errorIs("CANCELLED", false),
    );
    assert.equal(service.requests.length, 0);
  } finally {
    await service.close();
  }
});

test("HTTP rejection is redacted and not retried; redirects never forward the credential to a second endpoint", async () => {
  const target = await fixture((_request, response) =>
    reply(response, document()),
  );
  const denied = await fixture((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ privateProviderError: keyA }));
  });
  const redirect = await fixture((_request, response) => {
    response.writeHead(307, { location: target.url + "/wrong" });
    response.end();
  });
  try {
    await assert.rejects(
      requestImageCandidates(configuration(denied.url), {
        beforeDispatch: async () => {},
      }),
      errorIs("HTTP", true, "rejected"),
    );
    await assert.rejects(
      requestImageCandidates(configuration(redirect.url), {
        beforeDispatch: async () => {},
      }),
      errorIs("NETWORK", true, "unknown"),
    );
    assert.equal(denied.requests.length, 1);
    assert.equal(redirect.requests.length, 1);
    assert.equal(target.requests.length, 0);
  } finally {
    await denied.close();
    await redirect.close();
    await target.close();
  }
});

test("URL-only results, malformed encodings, bad images, wrong counts and invalid usage never create adoptable candidates", async () => {
  for (const value of [
    { data: [{ url: "http://127.0.0.1:1/never-fetch" }] },
    { data: [{ b64_json: "not base64" }] },
    document([Buffer.from("not-an-image")]),
    { data: [] },
    document([images[0], images[1]]),
  ]) {
    const service = await fixture((_request, response) =>
      reply(response, value),
    );
    try {
      const invoke = () =>
        requestImageCandidates(configuration(service.url), {
          beforeDispatch: async () => {},
        });
      if (value.data.length === 1) {
        const result = await invoke();
        assert.equal(result.candidates.length, 0);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].sourceIndex, 0);
        assert.ok(["RESPONSE", "IMAGE"].includes(result.errors[0].code));
        assert.equal(result.remoteResult, "received");
      } else
        await assert.rejects(invoke(), (error) => {
          assert.ok(["RESPONSE", "IMAGE", "LIMIT"].includes(error.code));
          return errorIs(error.code, true, "received-invalid")(error);
        });
      assert.equal(service.requests.length, 1);
    } finally {
      await service.close();
    }
  }
  const service = await fixture((_request, response) =>
    reply(response, {
      ...document(),
      usage: { total_tokens: -1, privateText: keyA },
    }),
  );
  try {
    assert.equal(
      (
        await requestImageCandidates(configuration(service.url), {
          beforeDispatch: async () => {},
        })
      ).usage,
      null,
    );
  } finally {
    await service.close();
  }
});

test("mixed valid and invalid inline images retain valid PNG/WebP bytes with original positions and bounded per-item errors", async () => {
  const service = await fixture((_request, response) =>
    reply(response, {
      data: [
        document([images[0]]).data[0],
        { b64_json: "not base64", private: keyA },
        document([images[2]]).data[0],
      ],
    }),
  );
  try {
    const config = configuration(service.url);
    config.request.n = 3;
    const result = await requestImageCandidates(config, {
      beforeDispatch: async () => {},
    });
    assert.deepEqual(
      result.candidates.map((item) => item.sourceIndex),
      [0, 2],
    );
    assert.deepEqual(
      result.candidates.map((item) => item.bytes),
      [images[0], images[2]],
    );
    assert.deepEqual(result.errors, [{ sourceIndex: 1, code: "IMAGE" }]);
    assert.equal(service.requests.length, 1);
    assert.ok(!JSON.stringify(result.errors).includes(keyA));
  } finally {
    await service.close();
  }
});

test("response MIME, declared byte cap and strict UTF-8 fail closed without retaining raw response text", async () => {
  for (const handler of [
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(keyA);
    },
    (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": imageGenerationLimits.responseBytes + 1,
      });
      response.flushHeaders();
    },
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.from([0xc3, 0x28]));
    },
  ]) {
    const service = await fixture(handler);
    try {
      await assert.rejects(
        requestImageCandidates(configuration(service.url), {
          beforeDispatch: async () => {},
        }),
        (error) => errorIs(error.code, true)(error),
      );
      assert.equal(service.requests.length, 1);
    } finally {
      await service.close();
    }
  }
});

test("post-send abort and deadline leave remote result unknown and never automatically retry", async () => {
  let announce;
  const arrived = new Promise((resolve) => {
    announce = resolve;
  });
  const service = await fixture((_request, _response) => {
    announce();
  });
  try {
    const abort = new AbortController();
    const pending = requestImageCandidates(configuration(service.url), {
      signal: abort.signal,
      beforeDispatch: async () => {},
    });
    await arrived;
    abort.abort();
    await assert.rejects(pending, errorIs("CANCELLED", true, "unknown"));
    await assert.rejects(
      requestImageCandidates(configuration(service.url), {
        timeoutMs: 100,
        beforeDispatch: async () => {},
      }),
      errorIs("TIMEOUT", true, "unknown"),
    );
    assert.equal(service.requests.length, 2);
  } finally {
    await service.close();
  }
});

test("an actual chunked response cannot exceed the cumulative byte cap when no Content-Length is declared", async () => {
  const service = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(1024 * 1024, 32);
    let remaining = 65;
    const send = () => {
      while (remaining > 0 && !response.destroyed) {
        remaining--;
        if (!response.write(chunk)) {
          response.once("drain", send);
          return;
        }
      }
      if (!response.destroyed) response.end();
    };
    response.on("close", () => {
      remaining = 0;
    });
    send();
  });
  try {
    await assert.rejects(
      requestImageCandidates(configuration(service.url), {
        beforeDispatch: async () => {},
      }),
      errorIs("LIMIT", true, "unknown"),
    );
    assert.equal(service.requests.length, 1);
  } finally {
    await service.close();
  }
});

test("cancellation at the end-of-body checkpoint retains received decoded candidates rather than pretending nothing returned", async () => {
  const service = await fixture((_request, response) =>
      reply(response, document()),
    ),
    abort = new AbortController();
  try {
    const result = await requestImageCandidates(configuration(service.url), {
      signal: abort.signal,
      beforeDispatch: async () => {},
      fetchImpl: async (url, options) => {
        const actual = await fetch(url, options);
        return {
          ok: actual.ok,
          headers: actual.headers,
          body: {
            getReader() {
              const reader = actual.body.getReader();
              return {
                read: async () => {
                  const next = await reader.read();
                  if (next.done) queueMicrotask(() => abort.abort());
                  return next;
                },
                cancel: () => reader.cancel(),
                releaseLock: () => reader.releaseLock(),
              };
            },
          },
        };
      },
    });
    assert.equal(result.remoteResult, "received");
    assert.equal(result.interruptedAfterResponse, true);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0].bytes, images[0]);
    assert.equal(service.requests.length, 1);
  } finally {
    await service.close();
  }
});
