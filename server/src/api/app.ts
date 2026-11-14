/**
 * The HTTP API.
 *
 *   POST /api/ask      { "question": "..." } -> answer, SQL, rows, chart, steps, usage
 *   GET  /api/history      this client's own recent questions
 *   GET  /api/history/:id  one saved answer (no model call); 404 unless it is this client's
 *   GET  /api/health   database connectivity
 *
 * Every error response has the same shape, { error: { code, message }, requestId },
 * and never contains stack traces or internal details; those are logged server-side.
 */
import { createHmac, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import type { AskResult } from '../agent/agent.js';
import type { AuditLog } from '../audit/auditLog.js';
import { AgentError, QueryFailedError } from '../errors.js';
import { estimateCostUsd } from '../llm/pricing.js';
import type { TokenUsage } from '../llm/usage.js';

/** Anything that can answer a question; the real AskDbAgent, or a fake in tests. */
export interface Asker {
  ask(question: string, options?: { signal?: AbortSignal }): Promise<AskResult>;
}

export interface AppOptions {
  readonly rateLimitPerMinute: number;
  readonly dailyBudgetUsd: number;
  readonly trustProxy: boolean;
  readonly clientIdSecret: string;
}

export interface AppDependencies {
  readonly asker: Asker;
  readonly audit: AuditLog;
  readonly model: string;
  readonly checkHealth: () => Promise<Record<string, boolean>>;
  readonly options: AppOptions;
}

const AskBody = z.object({ question: z.string().trim().min(1).max(500) });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
const HistoryId = z.string().regex(/^[1-9]\d{0,17}$/);

interface ApiFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly usage?: TokenUsage;
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.options.trustProxy ? 1 : false);
  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    next();
  });

  const clientIdOf = (req: Request): string =>
    createHmac('sha256', deps.options.clientIdSecret).update(req.ip ?? 'unknown').digest('hex').slice(0, 32);

  app.get('/api/health', async (_req, res) => {
    const checks = await deps.checkHealth();
    const healthy = Object.values(checks).every(Boolean);
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  });

  const askLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.options.rateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, { status: 429, code: 'RATE_LIMITED', message: 'Too many questions. Please wait a minute and try again.' }),
  });

  app.post('/api/ask', askLimiter, async (req, res) => {
    const requestId = res.locals.requestId as string;
    const body = AskBody.safeParse(req.body);
    if (!body.success) {
      return sendError(res, {
        status: 400,
        code: 'INVALID_QUESTION',
        message: 'Send JSON like {"question": "..."} with 1 to 500 characters.',
      });
    }

    if ((await deps.audit.spentTodayUsd()) >= deps.options.dailyBudgetUsd) {
      return sendError(res, {
        status: 503,
        code: 'BUDGET_EXCEEDED',
        message: 'AskDB has reached its daily usage limit. Please try again tomorrow.',
      });
    }

    const question = body.data.question;
    const clientId = clientIdOf(req);
    const startedAt = performance.now();

    // If the client goes away before we answer (Cancel, closed tab), stop the agent
    // so it does not keep spending tokens on an answer nobody will see.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) cancel.abort();
    });

    try {
      const result = await deps.asker.ask(question, { signal: cancel.signal });
      const costUsd = estimateCostUsd(deps.model, result.usage);
      await safeRecord(deps.audit, requestId, {
        requestId, clientId, question, status: result.status, answer: result.answer, sql: result.sql,
        rowCount: result.result?.rowCount, steps: result.steps, model: deps.model, usage: result.usage,
        costUsd, durationMs: result.durationMs,
        snapshot: result.result ? { ...result.result, chart: result.chart, unverifiedNumbers: result.unverifiedNumbers } : undefined,
      });

      res.json({
        requestId,
        status: result.status,
        answer: result.answer,
        sql: result.sql ?? null,
        columns: result.result?.columns ?? [],
        rows: result.result?.rows ?? [],
        rowCount: result.result?.rowCount ?? 0,
        truncated: result.result?.truncated ?? false,
        chart: result.chart,
        unverifiedNumbers: result.unverifiedNumbers,
        steps: result.steps,
        usage: { ...result.usage, estimatedCostUsd: costUsd ?? null },
        durationMs: result.durationMs,
      });
    } catch (err) {
      const failure = classifyFailure(err);
      if (failure.status >= 500) {
        console.error('ask_failed request_id=%s code=%s', requestId, failure.code, err);
      }
      await safeRecord(deps.audit, requestId, {
        requestId, clientId, question, status: 'error', errorCode: failure.code, model: deps.model,
        usage: failure.usage, costUsd: failure.usage ? estimateCostUsd(deps.model, failure.usage) : undefined,
        durationMs: Math.round(performance.now() - startedAt),
      });
      sendError(res, failure);
    }
  });

  app.get('/api/history', async (req, res) => {
    const query = HistoryQuery.safeParse(req.query);
    if (!query.success) {
      return sendError(res, { status: 400, code: 'INVALID_LIMIT', message: 'limit must be between 1 and 50.' });
    }
    res.json({ items: await deps.audit.history(clientIdOf(req), query.data.limit) });
  });

  app.get('/api/history/:id', async (req, res) => {
    const id = HistoryId.safeParse(req.params.id);
    const saved = id.success ? await deps.audit.findSaved(clientIdOf(req), id.data) : undefined;
    if (!saved) {
      // Same response for "does not exist" and "belongs to someone else".
      return sendError(res, { status: 404, code: 'NOT_FOUND', message: 'That question is not in your history.' });
    }
    res.json(saved);
  });

  app.use((_req, res) => sendError(res, { status: 404, code: 'NOT_FOUND', message: 'Not found.' }));

  // Express 5 sends errors from async handlers here as well.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: unknown }).type;
    if (type === 'entity.parse.failed') {
      return sendError(res, { status: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' });
    }
    if (type === 'entity.too.large') {
      return sendError(res, { status: 413, code: 'BODY_TOO_LARGE', message: 'The request body is too large.' });
    }
    console.error('request_failed request_id=%s', res.locals.requestId, err);
    sendError(res, { status: 500, code: 'INTERNAL', message: 'Something went wrong.' });
  });

  return app;
}

/** Maps internal errors to safe, user-facing ones. Upstream details stay in the server log. */
function classifyFailure(err: unknown): ApiFailure {
  if (err instanceof AgentError) {
    switch (err.code) {
      case 'INVALID_QUESTION':
        return { status: 400, code: err.code, message: err.message };
      case 'MODEL_REFUSED':
        return { status: 422, code: err.code, message: 'The AI declined to answer this question.', usage: err.usage };
      case 'TOO_MANY_STEPS':
        return { status: 422, code: err.code, message: 'AskDB could not find an answer. Try rephrasing the question.', usage: err.usage };
      case 'MODEL_ERROR':
        return { status: 502, code: err.code, message: 'The AI service is unavailable right now. Please try again.', usage: err.usage };
      case 'CANCELLED':
        // 499 "client closed request": the client has already gone, but the audit log records it.
        return { status: 499, code: err.code, message: 'The question was cancelled.', usage: err.usage };
    }
  }
  if (err instanceof QueryFailedError && err.code === 'DB_UNAVAILABLE') {
    return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable right now.' };
  }
  return { status: 500, code: 'INTERNAL', message: 'Something went wrong.' };
}

function sendError(res: Response, failure: ApiFailure): void {
  if (res.destroyed) return; // the client disconnected; there is nobody to reply to
  res.status(failure.status).json({
    error: { code: failure.code, message: failure.message },
    requestId: res.locals.requestId ?? null,
  });
}

/** An audit write failure is logged loudly but does not fail the user's request. */
async function safeRecord(audit: AuditLog, requestId: string, entry: Parameters<AuditLog['record']>[0]): Promise<void> {
  try {
    await audit.record(entry);
  } catch (err) {
    console.error('audit_write_failed request_id=%s', requestId, err);
  }
}
