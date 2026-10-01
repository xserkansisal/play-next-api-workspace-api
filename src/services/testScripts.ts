import { DefaultIntrinsics, getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { z } from "zod";
import { truncateUtf8 } from "./common.js";
import type { ProxyResult } from "./proxy.js";

const SCRIPT_TIMEOUT_MS = 1_000;
const SCRIPT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_SCRIPT_STACK_BYTES = 512 * 1024;
const MAX_SCRIPT_INPUT_BYTES = 2_500 * 1024;
const MAX_CAPTURED_VARIABLES = 2_500;
const MAX_CAPTURED_VALUE_LENGTH = 64 * 1024;
const MAX_CAPTURED_TOTAL_BYTES = 512 * 1024;
const MAX_TESTS = 100;
const MAX_TEST_NAME_LENGTH = 200;
const MAX_SCRIPT_RESPONSE_BYTES = 256 * 1024;

const keyValueSchema = z.strictObject({ key: z.string().max(8_192), value: z.string().max(8_192) });
const scriptRequestSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1).max(8_192),
  queryParams: z.array(keyValueSchema).max(500),
  headers: z.array(keyValueSchema).max(500),
  body: z.string().max(10_000_000).nullable(),
});

export interface ScriptRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  queryParams: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  body: string | null;
}

export interface ScriptTestResult {
  name: string;
  passed: boolean;
  errorCode?: "ASSERTION_FAILED";
}

export interface ScriptResult {
  request: ScriptRequest;
  variables: Record<string, string>;
  tests: ScriptTestResult[];
}

export class TestScriptError extends Error {
  constructor(public readonly code:
    | "SCRIPT_TIMEOUT"
    | "SCRIPT_MEMORY_EXCEEDED"
    | "SCRIPT_FAILED"
    | "SCRIPT_INPUT_TOO_LARGE"
    | "SCRIPT_OUTPUT_INVALID") {
    super(code);
    this.name = "TestScriptError";
  }
}

interface ScriptInput {
  request: ScriptRequest;
  variables: Record<string, string>;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyText: string;
    sizeBytes: number;
    truncated: boolean;
  };
}

const SCRIPT_API = `
const __tests = [];
const __variables = new Map(Object.entries(__input.variables));
const __request = __input.request;
const __response = __input.response
  ? {
      code: __input.response.status,
      status: __input.response.status,
      statusText: __input.response.statusText,
      headers: __input.response.headers,
      bodyText: __input.response.bodyText,
      sizeBytes: __input.response.sizeBytes,
      truncated: __input.response.truncated,
      text() { return __input.response.bodyText; },
      json() { return JSON.parse(__input.response.bodyText); },
    }
  : undefined;
function __expect(actual) {
  let negate = false;
  const assert = (condition) => {
    if (negate ? condition : !condition) throw new Error("Assertion failed");
    negate = false;
    return chain;
  };
  const chain = {
    get not() { negate = !negate; return chain; },
    to: null,
    be: null,
    equal(expected) { return assert(Object.is(actual, expected)); },
    eql(expected) { return assert(JSON.stringify(actual) === JSON.stringify(expected)); },
    include(expected) {
      const found = typeof actual === "string"
        ? actual.includes(String(expected))
        : Array.isArray(actual) ? actual.some((value) => Object.is(value, expected))
        : actual !== null && typeof actual === "object" && Object.hasOwn(actual, String(expected));
      return assert(found);
    },
  };
  chain.to = chain;
  chain.be = chain;
  Object.defineProperty(chain, "true", { get() { return assert(actual === true); } });
  Object.defineProperty(chain, "false", { get() { return assert(actual === false); } });
  Object.defineProperty(chain, "ok", { get() { return assert(Boolean(actual)); } });
  return chain;
}
const __environment = {
  get(key) { return __variables.get(String(key)); },
  set(key, value) {
    key = String(key);
    if (!/^[^\\s{}]{1,256}$/.test(key)) throw new Error("Invalid variable key");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string" || text.length > ${MAX_CAPTURED_VALUE_LENGTH}) throw new Error("Invalid variable value");
    __variables.set(key, text);
    if (__variables.size > ${MAX_CAPTURED_VARIABLES}) throw new Error("Too many variables");
  },
};
const pm = {
  request: __request,
  environment: __environment,
  variables: __environment,
  collectionVariables: __environment,
  expect: __expect,
  response: __response,
  test(name, fn) {
    if (!__response) throw new Error("pm.test is only available after a response");
    if (__tests.length >= ${MAX_TESTS}) throw new Error("Too many tests");
    const testName = String(name).slice(0, ${MAX_TEST_NAME_LENGTH});
    try {
      const result = fn();
      if (result && typeof result.then === "function") throw new Error("Async tests are not supported");
      __tests.push({ name: testName, passed: true });
    } catch {
      __tests.push({ name: testName, passed: false, errorCode: "ASSERTION_FAILED" });
    }
  },
};
`;

/**
 * Evaluates one hook in a fresh QuickJS runtime. The guest receives only serialized copies of
 * request, response and variables; no host callbacks or module loaders are exposed.
 */
export async function executeTestScript(
  source: string,
  input: ScriptInput,
  options: { timeoutMs?: number } = {},
): Promise<ScriptResult> {
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > MAX_SCRIPT_INPUT_BYTES) {
    throw new TestScriptError("SCRIPT_INPUT_TOO_LARGE");
  }

  const quickJs = await getQuickJS();
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const interruptAfterDeadline = shouldInterruptAfterDeadline(deadline);
  let timedOut = false;
  const runtime = quickJs.newRuntime({
    memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
    maxStackSizeBytes: MAX_SCRIPT_STACK_BYTES,
    interruptHandler: (vm) => {
      timedOut = Date.now() >= deadline;
      return interruptAfterDeadline(vm);
    },
  });
  const context = runtime.newContext({
    intrinsics: { ...DefaultIntrinsics, Date: false, Promise: false },
  });

  try {
    const inputHandle = context.newString(payload);
    context.setProp(context.global, "__inputJson", inputHandle);
    inputHandle.dispose();

    const execution = context.evalCode(
      `const __input = JSON.parse(__inputJson);\n${SCRIPT_API}\n${source}\nJSON.stringify({request:pm.request, variables:Object.fromEntries(__variables), tests:__tests})`,
      "collection-test-script.js",
    );
    if (execution.error) {
      const dumpedError = context.dump(execution.error);
      execution.error.dispose();
      const message = typeof dumpedError === "object" && dumpedError !== null && "message" in dumpedError
        ? String(dumpedError.message)
        : "";
      if (timedOut || Date.now() >= deadline) throw new TestScriptError("SCRIPT_TIMEOUT");
      if (/out of memory/i.test(message)) throw new TestScriptError("SCRIPT_MEMORY_EXCEEDED");
      throw new TestScriptError("SCRIPT_FAILED");
    }

    try {
      const raw = context.dump(execution.value);
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_SCRIPT_INPUT_BYTES) {
        throw new TestScriptError("SCRIPT_OUTPUT_INVALID");
      }
      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        throw new TestScriptError("SCRIPT_OUTPUT_INVALID");
      }
      const validated = scriptOutputSchema.safeParse(result);
      if (
        !validated.success ||
        Object.keys(validated.data.variables).length > MAX_CAPTURED_VARIABLES ||
        Buffer.byteLength(JSON.stringify(validated.data.variables)) > MAX_CAPTURED_TOTAL_BYTES
      ) {
        throw new TestScriptError("SCRIPT_OUTPUT_INVALID");
      }
      return validated.data;
    } finally {
      execution.value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

const scriptOutputSchema = z.strictObject({
  request: scriptRequestSchema,
  variables: z.record(z.string().regex(/^[^\s{}]{1,256}$/), z.string().max(MAX_CAPTURED_VALUE_LENGTH)),
  tests: z.array(
    z.strictObject({
      name: z.string().max(MAX_TEST_NAME_LENGTH),
      passed: z.boolean(),
      errorCode: z.literal("ASSERTION_FAILED").optional(),
    }),
  ).max(MAX_TESTS),
});

export function scriptResponseForResult(result: ProxyResult): NonNullable<ScriptInput["response"]> {
  const responseBody = truncateUtf8(result.bodyText, MAX_SCRIPT_RESPONSE_BYTES);
  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    bodyText: responseBody.text,
    sizeBytes: result.sizeBytes,
    truncated: result.truncated || responseBody.truncated,
  };
}
