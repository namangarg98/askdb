import { useState } from 'react';
import { chooseView } from '../chartData';
import { formatNumber, humanize } from '../format';
import type { AskResponse } from '../types';
import { ResultChart } from './ResultChart';
import { ResultTable } from './ResultTable';

type Tab = 'result' | 'table' | 'sql' | 'steps';

interface Props {
  response: AskResponse;
  question: string;
  /** Set when the result was reopened from history: shows its age and an Ask again button. */
  savedAt?: string;
  onAskAgain?: () => void;
}

export function ResultView({ response, question, savedAt, onAskAgain }: Props) {
  const view = chooseView(response.columns, response.rows, response.chart);
  const hasData = response.status === 'answered' && response.columns.length > 0;
  const tabs: { id: Tab; label: string }[] = [
    ...(hasData && view.kind !== 'table' ? [{ id: 'result' as const, label: view.kind === 'stat' ? 'Result' : 'Chart' }] : []),
    ...(hasData ? [{ id: 'table' as const, label: 'Table' }] : []),
    ...(response.sql ? [{ id: 'sql' as const, label: 'SQL' }] : []),
    { id: 'steps', label: 'Steps' },
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'steps');

  const cost = response.usage.estimatedCostUsd;

  return (
    <article className="card result" aria-live="polite">
      {savedAt && (
        <div className="saved-banner">
          <span>Saved result from {new Date(savedAt).toLocaleString()}. Shown without asking the AI again.</span>
          {onAskAgain && <button className="secondary" onClick={onAskAgain}>Ask again</button>}
        </div>
      )}
      <p className="result-question">{question}</p>
      <p className="result-answer">{response.answer}</p>
      {response.unverifiedNumbers.length > 0 && (
        <p className="unverified" role="note">
          ⚠ Could not verify {response.unverifiedNumbers.join(', ')} against the query results. Check the Table tab before relying on {response.unverifiedNumbers.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {savedAt && response.status === 'answered' && response.columns.length === 0 && (
        <p className="muted">The saved table for this answer has expired. Use Ask again to get current data.</p>
      )}
      <p className="result-meta">
        {hasData && <span>{response.rowCount} row{response.rowCount === 1 ? '' : 's'}</span>}
        {!savedAt && <span>{(response.durationMs / 1000).toFixed(1)}s</span>}
        {!savedAt && <span>{response.usage.modelCalls} AI calls</span>}
        {!savedAt && cost !== null && <span>~${cost.toFixed(4)}</span>}
      </p>

      <div className="tabs" role="tablist" aria-label="Result views">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-panel" role="tabpanel">
        {tab === 'result' && view.kind === 'stat' && (
          <div className="stat">
            <div className="stat-label">{humanize(view.label)}</div>
            <div className="stat-value">{formatNumber(view.value)}</div>
          </div>
        )}
        {tab === 'result' && (view.kind === 'bar' || view.kind === 'line') && (
          <>
            <ResultChart kind={view.kind} points={view.points} labelColumn={view.labelColumn} valueColumn={view.valueColumn} />
            {view.otherNumericColumns.length > 0 && (
              <p className="muted">
                Chart shows {humanize(view.valueColumn).toLowerCase()}. {view.otherNumericColumns.map(humanize).join(', ')} {view.otherNumericColumns.length === 1 ? 'is' : 'are'} in the Table tab.
              </p>
            )}
          </>
        )}
        {tab === 'table' && <ResultTable columns={response.columns} rows={response.rows} truncated={response.truncated} />}
        {tab === 'sql' && response.sql && (
          <pre className="sql">
            <code>{response.sql}</code>
          </pre>
        )}
        {tab === 'steps' && (
          <ol className="steps">
            {response.steps.map((step, index) => (
              <li key={index} className={step.ok ? 'step' : 'step step-failed'}>
                <span className="step-status" aria-label={step.ok ? 'succeeded' : 'failed'}>{step.ok ? '✓' : '✕'}</span>
                <div>
                  <div className="step-title">
                    <code>{step.tool}</code> <span className="muted">{step.summary} · {step.durationMs} ms</span>
                  </div>
                  {step.input && <div className="step-input">{step.input}</div>}
                </div>
              </li>
            ))}
            {response.steps.length === 0 && <li className="muted">No tools were needed for this answer.</li>}
          </ol>
        )}
      </div>
    </article>
  );
}
