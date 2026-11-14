/**
 * Asks Claude for a short business description of one table, so searches like
 * "revenue" or "sales" find order_details even though no column is named that.
 *
 * Privacy (Layer 4): Claude only sees the table STRUCTURE, never any rows.
 */
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT =
  'You write short documentation for database tables. The documentation is used to ' +
  'find the right tables when someone asks a business question in plain English.';

export async function describeTable(
  claude: Anthropic,
  model: string,
  tableName: string,
  structure: string,
): Promise<string> {
  try {
    const response = await claude.messages.create({
      model,
      // Room for adaptive thinking plus a few sentences; the reply itself is short.
      max_tokens: 2_000,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `${structure}\n\n` +
            'In 2-3 plain sentences (no lists, no markdown), say what one row of this table ' +
            'represents, which business questions it helps answer, and other words a user might ' +
            'use for it (for example "sales" or "revenue"). Only mention columns listed above.',
        },
      ],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();

    if (response.stop_reason === 'end_turn' && text.length > 0) return text;
    console.warn('schema_describe_unusable_reply table=%s stop_reason=%s', tableName, response.stop_reason);
  } catch (err) {
    if (!(err instanceof Anthropic.APIError)) throw err;
    console.warn('schema_describe_failed table=%s error=%s status=%s', tableName, err.name, err.status ?? 'none');
  }

  // Indexing never fails because of the LLM: fall back to a plain description.
  return fallbackDescription(tableName, structure);
}

function fallbackDescription(tableName: string, structure: string): string {
  const columnNames = [...structure.matchAll(/^\s+- (\S+)/gm)].map((match) => match[1]);
  return `Table ${tableName} with columns: ${columnNames.join(', ')}.`;
}
