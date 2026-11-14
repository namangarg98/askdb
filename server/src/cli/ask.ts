/**
 * Ask AskDB a question from the terminal:
 *   npm run ask "Which 5 customers spent the most?"
 */
import { buildAgent } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { createMetaPool, createReadOnlyPool } from '../db/pool.js';
import { AgentError, StartupError } from '../errors.js';
import { estimateCostUsd } from '../llm/pricing.js';

const ROWS_TO_PRINT = 10;

const question = process.argv.slice(2).join(' ');
if (!question) {
  console.error('Usage: npm run ask "your question"');
  process.exit(1);
}

const config = loadConfig();
const readOnlyPool = createReadOnlyPool(config);
const metaPool = createMetaPool(config);

try {
  const agent = await buildAgent(config, readOnlyPool, metaPool);
  const result = await agent.ask(question);

  console.log('\nSteps:');
  result.steps.forEach((step, index) => {
    const input = step.input.replace(/\s+/g, ' ');
    console.log(`  ${index + 1}. ${step.ok ? 'ok ' : 'ERR'} ${step.tool}(${input.length > 90 ? `${input.slice(0, 90)}…` : input}) -> ${step.summary} [${step.durationMs} ms]`);
  });

  if (result.sql) console.log(`\nSQL:\n  ${result.sql.replace(/\n/g, '\n  ')}`);
  if (result.result) {
    const { columns, rows, rowCount } = result.result;
    console.table(rows.slice(0, ROWS_TO_PRINT).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))));
    if (rowCount > ROWS_TO_PRINT) console.log(`  … ${rowCount} rows in total`);
  }

  console.log(`\nAnswer (${result.status}, chart: ${result.chart}):\n  ${result.answer}`);

  const { usage } = result;
  const cost = estimateCostUsd(config.ASKDB_MODEL, usage);
  console.log(
    `\n${usage.modelCalls} model calls | tokens in ${usage.inputTokens} (+${usage.cacheReadTokens} cached, ` +
      `+${usage.cacheWriteTokens} cache write) out ${usage.outputTokens}` +
      `${cost === undefined ? '' : ` | ~$${cost.toFixed(4)}`} | ${(result.durationMs / 1000).toFixed(1)}s`,
  );
} catch (err) {
  if (err instanceof StartupError) {
    console.error(err.message);
  } else if (err instanceof AgentError) {
    console.error(`AskDB could not answer [${err.code}]: ${err.message}`);
  } else {
    throw err;
  }
  process.exitCode = 1;
} finally {
  await Promise.all([readOnlyPool.end(), metaPool.end()]);
}
