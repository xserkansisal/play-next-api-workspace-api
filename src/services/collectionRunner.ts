import { and, asc, count, desc, eq, isNull, or } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { environments, environmentVariables, testRunResults, testRuns, variables } from "../db/schema.js";
import { BadRequestError, HttpError, NotFoundError } from "../errors.js";
import type { CollectionRunInput, RunHistoryQuery } from "../validation/schemas.js";
import { MAX_RUN_REQUESTS } from "../validation/schemas.js";
import { newId, nowIso, truncateUtf8 } from "./common.js";
import { requireActiveCollection } from "./collections.js";
import {
  executeProxyRequest,
  type ProxyOptions,
  type ProxyResult,
} from "./proxy.js";
import { loadActiveTree, type ItemNode, type RequestNode } from "./tree.js";
import {
  executeTestScript,
  scriptResponseForResult,
  type ScriptRequest,
  TestScriptError,
} from "./testScripts.js";

const MAX_RUN_DURATION_MS = 10 * 60_000;
const MAX_VARIABLE_COUNT = 2_500;
const MAX_VARIABLE_BYTES = 512 * 1024;
const RESPONSE_PREVIEW_LENGTH = 16_384;

type RunStatus = "running" | "passed" | "failed" | "error";
type ResultStatus = "passed" | "failed" | "error" | "skipped";
type AssertionResult = { name: string; passed: boolean; errorCode?: string };

export interface RunnerProxyOptions extends ProxyOptions {
  maxRunDurationMs?: number;
}

export interface RunResultSummary {
  id: string;
  position: number;
  itemId: string;
  itemName: string;
  status: ResultStatus;
  httpStatus: number | null;
  durationMs: number;
  responseSizeBytes: number | null;
  responsePreview: string | null;
  responseTruncated: boolean;
  assertions: AssertionResult[];
  errorCode: string | null;
}

export interface RunSummary {
  id: string;
  collectionId: string;
  folderId: string | null;
  environmentId: string | null;
  status: RunStatus;
  requestCount: number;
  passedCount: number;
  failedCount: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunDetail extends RunSummary {
  results: RunResultSummary[];
}

function toRunSummary(row: typeof testRuns.$inferSelect): RunSummary {
  return {
    id: row.id,
    collectionId: row.collectionId,
    folderId: row.folderId,
    environmentId: row.environmentId,
    status: row.status,
    requestCount: row.requestCount,
    passedCount: row.passedCount,
    failedCount: row.failedCount,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
  };
}

function toRunResult(row: typeof testRunResults.$inferSelect): RunResultSummary {
  return {
    id: row.id,
    position: row.position,
    itemId: row.itemId,
    itemName: row.itemName,
    status: row.status,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    responseSizeBytes: row.responseSizeBytes,
    responsePreview: row.responsePreview,
    responseTruncated: row.responseTruncated,
    assertions: row.assertions,
    errorCode: row.errorCode,
  };
}

async function readRunResults(db: AppDatabase, runId: string): Promise<RunResultSummary[]> {
  const rows = await db
    .select()
    .from(testRunResults)
    .where(eq(testRunResults.runId, runId))
    .orderBy(asc(testRunResults.position));
  return rows.map(toRunResult);
}

function collectRequests(nodes: ItemNode[], output: RequestNode[]): void {
  for (const node of nodes) {
    if (node.type === "request") output.push(node);
    else collectRequests(node.items, output);
  }
}

async function loadRunVariables(
  db: AppDatabase,
  userId: string,
  environmentId: string | undefined,
): Promise<Map<string, string>> {
  let environmentRows: Array<{ key: string; value: string }> = [];
  if (environmentId) {
    const [environment] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.id, environmentId), isNull(environments.deletedAt)))
      .limit(1);
    if (!environment) throw new NotFoundError(`Environment ${environmentId} not found`);
    environmentRows = await db
      .select({ key: environmentVariables.key, value: environmentVariables.value })
      .from(environmentVariables)
      .where(and(eq(environmentVariables.environmentId, environmentId), eq(environmentVariables.enabled, true)))
      .orderBy(asc(environmentVariables.position));
  }

  const scopedRows = await db
    .select({ scope: variables.scope, key: variables.key, value: variables.value })
    .from(variables)
    .where(or(and(eq(variables.scope, "user"), eq(variables.userId, userId)), eq(variables.scope, "global")));
  const map = new Map<string, string>();
  for (const row of scopedRows) if (row.scope === "global") map.set(row.key, row.value);
  for (const row of scopedRows) if (row.scope === "user") map.set(row.key, row.value);
  for (const row of environmentRows) map.set(row.key, row.value);

  if (map.size > MAX_VARIABLE_COUNT || Buffer.byteLength(JSON.stringify([...map])) > MAX_VARIABLE_BYTES) {
    throw new HttpError(422, "The effective variable set is too large for a collection run", "RUN_VARIABLES_TOO_LARGE");
  }
  return map;
}

function replaceVariables(value: string, variables: Map<string, string>): string {
  return value.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const replacement = variables.get(key);
    if (replacement === undefined) {
      throw new HttpError(422, `Variable "${key}" is not defined for this run`, "RUN_VARIABLE_NOT_FOUND", { key });
    }
    return replacement;
  });
}

function variableRecord(variables: Map<string, string>): Record<string, string> {
  return Object.fromEntries(variables);
}

function toScriptRequest(request: RequestNode): ScriptRequest {
  return {
    method: request.method,
    url: request.url,
    queryParams: request.queryParams.filter((row) => row.enabled).map(({ key, value }) => ({ key, value })),
    headers: request.headers.filter((row) => row.enabled).map(({ key, value }) => ({ key, value })),
    body: request.body?.content ?? null,
  };
}

function resolveAuthHeaders(request: RequestNode, variables: Map<string, string>): Array<{ key: string; value: string }> {
  const auth = request.effectiveAuth;
  switch (auth.type) {
    case "none":
      return [];
    case "basic": {
      const username = replaceVariables(auth.username, variables);
      const password = replaceVariables(auth.password, variables);
      return [{ key: "Authorization", value: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` }];
    }
    case "bearer":
      return [{ key: "Authorization", value: `Bearer ${replaceVariables(auth.token, variables)}` }];
    case "api-key":
      return auth.in === "header"
        ? [{ key: replaceVariables(auth.key, variables), value: replaceVariables(auth.value, variables) }]
        : [];
  }
}

function prepareProxyRequest(
  request: RequestNode,
  scriptRequest: ScriptRequest,
  variables: Map<string, string>,
): { method: ScriptRequest["method"]; url: string; headers: Array<[string, string]>; body: string | null } {
  const urlText = replaceVariables(scriptRequest.url, variables);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new HttpError(400, "A request URL is not a valid absolute URL after variable substitution", "RUN_INVALID_URL");
  }

  for (const param of scriptRequest.queryParams) {
    url.searchParams.append(replaceVariables(param.key, variables), replaceVariables(param.value, variables));
  }

  const headers = scriptRequest.headers.map((header) => [
    replaceVariables(header.key, variables),
    replaceVariables(header.value, variables),
  ] as [string, string]);
  const resolvedAuthHeaders = resolveAuthHeaders(request, variables);
  for (const header of resolvedAuthHeaders) headers.push([header.key, header.value]);

  if (request.effectiveAuth.type === "api-key" && request.effectiveAuth.in === "query") {
    url.searchParams.append(
      replaceVariables(request.effectiveAuth.key, variables),
      replaceVariables(request.effectiveAuth.value, variables),
    );
  }

  return {
    method: scriptRequest.method,
    url: url.toString(),
    headers,
    body: scriptRequest.body === null ? null : replaceVariables(scriptRequest.body, variables),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof TestScriptError) return error.code;
  return "RUN_REQUEST_FAILED";
}

async function runOneRequest(
  request: RequestNode,
  variables: Map<string, string>,
  proxyOptions: RunnerProxyOptions,
  runDeadline: number,
): Promise<{
  status: ResultStatus;
  durationMs: number;
  httpStatus: number | null;
  responseSizeBytes: number | null;
  responsePreview: string | null;
  responseTruncated: boolean;
  assertions: AssertionResult[];
  errorCode: string | null;
}> {
  const startedAt = Date.now();
  let response: ProxyResult | undefined;
  let assertions: AssertionResult[] = [];
  try {
    let scriptRequest = toScriptRequest(request);
    if (request.preRequestScript !== "") {
      const preRequest = await executeTestScript(
        request.preRequestScript,
        { request: scriptRequest, variables: variableRecord(variables) },
      );
      scriptRequest = preRequest.request;
      variables.clear();
      for (const [key, value] of Object.entries(preRequest.variables)) variables.set(key, value);
    }

    const prepared = prepareProxyRequest(request, scriptRequest, variables);
    const timeoutMs = Math.max(1, Math.min(proxyOptions.timeoutMs, runDeadline - Date.now()));
    response = await executeProxyRequest(prepared, { ...proxyOptions, timeoutMs });

    if (request.postResponseScript !== "") {
      const postResponse = await executeTestScript(
        request.postResponseScript,
        {
          request: scriptRequest,
          variables: variableRecord(variables),
          response: scriptResponseForResult(response),
        },
      );
      assertions = postResponse.tests;
      variables.clear();
      for (const [key, value] of Object.entries(postResponse.variables)) variables.set(key, value);
    }
    const status: ResultStatus = assertions.some((assertion) => !assertion.passed) ? "failed" : "passed";
    const preview = truncateUtf8(response.bodyText, RESPONSE_PREVIEW_LENGTH);
    return {
      status,
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
      responseSizeBytes: response.sizeBytes,
      responsePreview: preview.text,
      responseTruncated: response.truncated || preview.truncated,
      assertions,
      errorCode: null,
    };
  } catch (error) {
    const code = errorCode(error);
    const preview = response ? truncateUtf8(response.bodyText, RESPONSE_PREVIEW_LENGTH) : null;
    assertions = error instanceof HttpError && error.code === "RUN_VARIABLE_NOT_FOUND"
      ? [{ name: "Request variables", passed: false, errorCode: "ASSERTION_FAILED" }]
      : [];
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      httpStatus: response?.status ?? null,
      responseSizeBytes: response?.sizeBytes ?? null,
      responsePreview: preview?.text ?? null,
      responseTruncated: response ? response.truncated || preview?.truncated === true : false,
      assertions,
      errorCode: code,
    };
  }
}

export async function runCollection(
  db: AppDatabase,
  collectionId: string,
  userId: string,
  input: CollectionRunInput,
  proxyOptions: RunnerProxyOptions,
  folderId?: string,
): Promise<RunDetail> {
  await requireActiveCollection(db, collectionId);
  const tree = await loadActiveTree(db, collectionId);
  let roots = tree.roots;
  if (folderId) {
    const node = tree.byId.get(folderId);
    if (!node) throw new NotFoundError(`Folder ${folderId} not found in collection ${collectionId}`);
    if (node.type !== "folder") throw new BadRequestError(`Item ${folderId} is not a folder`, "ITEM_NOT_FOLDER");
    roots = [node];
  }

  const requests: RequestNode[] = [];
  collectRequests(roots, requests);
  if (requests.length > MAX_RUN_REQUESTS) {
    throw new HttpError(413, `A run may include at most ${MAX_RUN_REQUESTS} requests`, "RUN_TOO_LARGE", {
      maxRequests: MAX_RUN_REQUESTS,
    });
  }
  const variables = await loadRunVariables(db, userId, input.environmentId);
  const runId = newId();
  const startedAt = nowIso();
  const startTimeMs = Date.now();
  const runDeadline = startTimeMs + (proxyOptions.maxRunDurationMs ?? MAX_RUN_DURATION_MS);
  await db.insert(testRuns).values({
    id: runId,
    collectionId,
    folderId: folderId ?? null,
    environmentId: input.environmentId ?? null,
    userId,
    status: "running",
    requestCount: requests.length,
    startedAt,
  });

  let passedCount = 0;
  let failedCount = 0;
  try {
    for (const [position, request] of requests.entries()) {
      const result = Date.now() >= runDeadline
        ? {
            status: "skipped" as const,
            durationMs: 0,
            httpStatus: null,
            responseSizeBytes: null,
            responsePreview: null,
            responseTruncated: false,
            assertions: [] as AssertionResult[],
            errorCode: "RUN_TIMEOUT",
          }
        : await runOneRequest(request, variables, proxyOptions, runDeadline);
      if (result.status === "passed") passedCount += 1;
      else failedCount += 1;
      await db.insert(testRunResults).values({
        id: newId(),
        runId,
        position,
        itemId: request.id,
        itemName: request.name,
        ...result,
      });
    }
    const finishedAt = nowIso();
    const status: RunStatus = failedCount > 0 ? "failed" : "passed";
    await db.update(testRuns)
      .set({ status, passedCount, failedCount, finishedAt, durationMs: Date.now() - startTimeMs })
      .where(eq(testRuns.id, runId));
  } catch (error) {
    await db.update(testRuns)
      .set({ status: "error", passedCount, failedCount, finishedAt: nowIso(), durationMs: Date.now() - startTimeMs })
      .where(eq(testRuns.id, runId));
    throw error;
  }
  return getCollectionRun(db, collectionId, runId, userId);
}

export async function listCollectionRuns(
  db: AppDatabase,
  collectionId: string,
  userId: string,
  pagination: RunHistoryQuery,
): Promise<{ runs: RunSummary[]; total: number; limit: number; offset: number }> {
  await requireActiveCollection(db, collectionId);
  const where = and(eq(testRuns.collectionId, collectionId), eq(testRuns.userId, userId));
  const [countRows, rows] = await Promise.all([
    db.select({ value: count() }).from(testRuns).where(where),
    db.select().from(testRuns).where(where)
      .orderBy(desc(testRuns.startedAt), desc(testRuns.id))
      .limit(pagination.limit)
      .offset(pagination.offset),
  ]);
  return {
    runs: rows.map(toRunSummary),
    total: Number(countRows[0]?.value ?? 0),
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export async function getCollectionRun(
  db: AppDatabase,
  collectionId: string,
  runId: string,
  userId: string,
): Promise<RunDetail> {
  await requireActiveCollection(db, collectionId);
  const [row] = await db.select().from(testRuns)
    .where(and(
      eq(testRuns.id, runId),
      eq(testRuns.collectionId, collectionId),
      eq(testRuns.userId, userId),
    ))
    .limit(1);
  if (!row) throw new NotFoundError(`Run ${runId} not found`);
  return { ...toRunSummary(row), results: await readRunResults(db, runId) };
}
