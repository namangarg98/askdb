/**
 * HTTP API tests: a fake agent (no Claude calls) with the real audit log in
 * askdb_meta. Test rows use the model name "test-fake" and are deleted afterwards.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { AskResult } from '../src/agent/agent.js';
import { createApp, type AppOptions, type Asker } from '../src/api/app.js';
import { AuditLog } from '../src/audit/auditLog.js';
import { loadConfig } from '../src/config.js';
import { createMetaPool } from '../src/db/pool.js';
import { AgentError } from '../src/errors.js';
import { emptyUsage } from '../src/llm/usage.js';

const hasDatabase = Boolean(process.env.ASKDB_APP_PASSWORD && process.env.ASKDB_CLIENT_ID_SECRET);
const TEST_MODEL = 'test-fake';

const answered: AskResult = {
  status: 'answered',
  answer: 'There are 830 orders.',
  sql: 'SELECT count(*) FROM orders',
  result: { columns: ['count'], rows: [['830']], rowCount: 1, truncated: false, durationMs: 3 },
  chart: 'none',
  unverifiedNumbers: [],
  steps: [{ tool: 'run_query', input: 'SELECT count(*) FROM orders', ok: true, summary: '1 row', durationMs: 3 }],
  usage: { ...emptyUsage(), modelCalls: 2 },
  durationMs: 1200,
};

describe.skipIf(!hasDatabase)('AskDB HTTP API', () => {
  let metaPool: pg.Pool;
  let audit: AuditLog;
  const servers: Server[] = [];

  /** Starts the app on a random free port and returns a fetch helper for it. */
  async function startApp(asker: Asker, overrides: Partial<AppOptions> = {}, auditLog: AuditLog = audit) {
    const app = createApp({
      asker,
      audit: auditLog,
      model: TEST_MODEL,
      checkHealth: async () => ({ database: true, metaDatabase: true }),
      options: { rateLimitPerMinute: 100, dailyBudgetUsd: 1_000, trustProxy: true, clientIdSecret: 'test-secret-123456', ...overrides },
    });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    return async (path: string, init: { body?: unknown; raw?: string; ip?: string } = {}) => {
      const response = await fetch(base + path, {
        method: init.body !== undefined || init.raw !== undefined ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': init.ip ?? '203.0.113.1' },
        body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
  }

  beforeAll(async () => {
    metaPool = createMetaPool(loadConfig());
    audit = new AuditLog(metaPool, 'test-host:1/test_db');
    await audit.ensureSchema();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await metaPool?.query('DELETE FROM audit_log WHERE model = $1', [TEST_MODEL]);
    await metaPool?.end();
  });

  it('answers a question and records it in the audit log', async () => {
    const call = await startApp({ ask: async () => answered });
    const { status, body } = await call('/api/ask', { body: { question: 'How many orders?' }, ip: '203.0.113.10' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'answered', answer: 'There are 830 orders.', rows: [['830']], chart: 'none' });

    const logged = await metaPool.query('SELECT question, status, sql, row_count, steps FROM audit_log WHERE request_id = $1', [body.requestId]);
    expect(logged.rows[0]).toMatchObject({ question: 'How many orders?', status: 'answered', row_count: 1 });
    expect(logged.rows[0].steps).toHaveLength(1);
  });

  it.each([
    ['missing question', { body: {} }, 'INVALID_QUESTION'],
    ['empty question', { body: { question: '   ' } }, 'INVALID_QUESTION'],
    ['question too long', { body: { question: 'x'.repeat(501) } }, 'INVALID_QUESTION'],
    ['broken JSON', { raw: '{"question": ' }, 'INVALID_JSON'],
  ])('rejects bad input: %s', async (_label, init, code) => {
    const call = await startApp({ ask: async () => answered });
    const { status, body } = await call('/api/ask', init);
    expect(status).toBe(400);
    expect(body.error.code).toBe(code);
  });

  it('rate-limits each client', async () => {
    const call = await startApp({ ask: async () => answered }, { rateLimitPerMinute: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call('/api/ask', { body: { question: 'q' }, ip: '203.0.113.20' })).status);
    expect(statuses).toEqual([200, 200, 429]);
    // A different client is not affected.
    expect((await call('/api/ask', { body: { question: 'q' }, ip: '203.0.113.21' })).status).toBe(200);
  });

  it('stops answering when the daily budget is used up', async () => {
    let asked = false;
    const call = await startApp({ ask: async () => { asked = true; return answered; } }, { dailyBudgetUsd: 0 });
    const { status, body } = await call('/api/ask', { body: { question: 'q' } });
    expect(status).toBe(503);
    expect(body.error.code).toBe('BUDGET_EXCEEDED');
    expect(asked).toBe(false);
  });

  it('shows each client only their own history', async () => {
    const call = await startApp({ ask: async () => answered });
    await call('/api/ask', { body: { question: 'Alice question' }, ip: '198.51.100.1' });
    await call('/api/ask', { body: { question: 'Bob question' }, ip: '198.51.100.2' });

    const alice = await call('/api/history', { ip: '198.51.100.1' });
    const questions = alice.body.items.map((item: { question: string }) => item.question);
    expect(questions).toContain('Alice question');
    expect(questions).not.toContain('Bob question');
  });

  it('never stores client IP addresses', async () => {
    const call = await startApp({ ask: async () => answered });
    const { body } = await call('/api/ask', { body: { question: 'privacy check' }, ip: '192.0.2.77' });
    const row = await metaPool.query('SELECT client_id FROM audit_log WHERE request_id = $1', [body.requestId]);
    expect(row.rows[0].client_id).not.toContain('192.0.2.77');
    expect(row.rows[0].client_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hides upstream error details from the client but logs the failure', async () => {
    const call = await startApp({
      ask: async () => { throw new AgentError('MODEL_ERROR', 'litellm.BadRequestError: internal gateway detail'); },
    });
    const { status, body } = await call('/api/ask', { body: { question: 'q' } });

    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain('litellm');
    const logged = await metaPool.query('SELECT status, error_code FROM audit_log WHERE request_id = $1', [body.requestId]);
    expect(logged.rows[0]).toEqual({ status: 'error', error_code: 'MODEL_ERROR' });
  });

  it('returns a generic 500 for unexpected errors, without the message', async () => {
    const call = await startApp({ ask: async () => { throw new Error('password=hunter2 stack trace'); } });
    const { status, body } = await call('/api/ask', { body: { question: 'q' } });
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'Something went wrong.' });
  });

  it('stops the agent when the client disconnects (Cancel) and audits it as CANCELLED', async () => {
    let agentSawAbort = false;
    const call = await startApp({
      ask: (_question, options) =>
        new Promise<AskResult>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            agentSawAbort = true;
            reject(new AgentError('CANCELLED', 'The question was cancelled.'));
          });
        }),
    });
    void call; // only used to start the server
    const port = (servers.at(-1)?.address() as AddressInfo).port;

    const client = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'cancel-me-unique-question' }),
      signal: client.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.abort();
    await request;

    // The server finishes asynchronously after the disconnect; wait for the audit row.
    let row: { status: string; error_code: string } | undefined;
    for (let attempt = 0; attempt < 20 && !row; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = (await metaPool.query("SELECT status, error_code FROM audit_log WHERE question = 'cancel-me-unique-question'")).rows[0];
    }
    expect(agentSawAbort).toBe(true);
    expect(row).toEqual({ status: 'error', error_code: 'CANCELLED' });
  });

  it('reopens a saved answer from history without calling the agent again', async () => {
    let calls = 0;
    const call = await startApp({ ask: async () => { calls += 1; return answered; } });
    const asked = await call('/api/ask', { body: { question: 'saved-answer-question' }, ip: '198.51.100.30' });
    const id = (await metaPool.query('SELECT id FROM audit_log WHERE request_id = $1', [asked.body.requestId])).rows[0].id;

    const reopened = await call(`/api/history/${id}`, { ip: '198.51.100.30' });

    expect(calls).toBe(1);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({
      question: 'saved-answer-question',
      status: 'answered',
      sql: 'SELECT count(*) FROM orders',
      snapshot: { columns: ['count'], rows: [['830']], rowCount: 1, chart: 'none' },
    });
  });

  it("returns 404 for another client's saved answer, exactly like a missing one", async () => {
    const call = await startApp({ ask: async () => answered });
    const asked = await call('/api/ask', { body: { question: 'private question' }, ip: '198.51.100.40' });
    const id = (await metaPool.query('SELECT id FROM audit_log WHERE request_id = $1', [asked.body.requestId])).rows[0].id;

    const otherClient = await call(`/api/history/${id}`, { ip: '198.51.100.41' });
    const missing = await call('/api/history/999999999999', { ip: '198.51.100.40' });
    const invalid = await call('/api/history/1%20OR%201=1', { ip: '198.51.100.40' });

    expect(otherClient.status).toBe(404);
    expect(otherClient.body.error).toEqual(missing.body.error);
    expect(invalid.status).toBe(404);
  });

  it("shows only the current database's history, and never reopens another database's answer", async () => {
    const shopAudit = new AuditLog(metaPool, 'test-host:1/shop_db');
    const onTestDb = await startApp({ ask: async () => answered });
    const onShopDb = await startApp({ ask: async () => answered }, {}, shopAudit);

    const asked = await onTestDb('/api/ask', { body: { question: 'test-db-only question' }, ip: '198.51.100.60' });
    await onShopDb('/api/ask', { body: { question: 'shop-db-only question' }, ip: '198.51.100.60' });
    const id = (await metaPool.query('SELECT id, source FROM audit_log WHERE request_id = $1', [asked.body.requestId])).rows[0];

    const testHistory = await onTestDb('/api/history', { ip: '198.51.100.60' });
    const shopHistory = await onShopDb('/api/history', { ip: '198.51.100.60' });
    const reopenedElsewhere = await onShopDb(`/api/history/${id.id}`, { ip: '198.51.100.60' });

    expect(id.source).toBe('test-host:1/test_db');
    expect(testHistory.body.items.map((item: { question: string }) => item.question)).toEqual(['test-db-only question']);
    expect(shopHistory.body.items.map((item: { question: string }) => item.question)).toEqual(['shop-db-only question']);
    expect(reopenedElsewhere.status).toBe(404);
  });

  it('expires saved rows after the retention period but keeps the audit record', async () => {
    const call = await startApp({ ask: async () => answered });
    const asked = await call('/api/ask', { body: { question: 'old question' }, ip: '198.51.100.50' });
    await metaPool.query("UPDATE audit_log SET created_at = now() - interval '40 days' WHERE request_id = $1", [asked.body.requestId]);

    await audit.expireSnapshots(30);

    const row = (await metaPool.query('SELECT question, sql, result FROM audit_log WHERE request_id = $1', [asked.body.requestId])).rows[0];
    expect(row).toEqual({ question: 'old question', sql: 'SELECT count(*) FROM orders', result: null });
  });

  it('reports health and returns JSON 404s', async () => {
    const call = await startApp({ ask: async () => answered });
    expect(await call('/api/health')).toEqual({ status: 200, body: { status: 'ok', checks: { database: true, metaDatabase: true } } });
    expect((await call('/api/nope')).status).toBe(404);
  });
});
