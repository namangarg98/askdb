import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, ask, fetchHistory, fetchSaved } from './api';
import { ResultView } from './components/ResultView';
import type { AskResponse, HistoryItem, SavedAnswer } from './types';

const EXAMPLES = [
  'Which 5 customers spent the most money?',
  'What were the total sales per month in 1997?',
  'Which product category earns the most revenue?',
  'How many orders did each shipping company deliver?',
  'Which employees handled the most orders?',
];
const MAX_QUESTION_LENGTH = 500;

type Theme = 'light' | 'dark';

export function App() {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [response, setResponse] = useState<AskResponse | null>(null);
  // The saved answer being shown from history (no AI call), if any.
  const [saved, setSaved] = useState<SavedAnswer | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const abortRef = useRef<AbortController | null>(null);

  const refreshHistory = useCallback(() => {
    fetchHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(refreshHistory, [refreshHistory]);

  // Follow the operating-system theme while the user has not picked one explicitly.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(currentTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [loading]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    abortRef.current = new AbortController();
    setQuestion(trimmed);
    setAsked(trimmed);
    setLoading(true);
    setElapsed(0);
    setError(null);
    setCancelled(false);
    setResponse(null);
    setSaved(null);

    try {
      setResponse(await ask(trimmed, abortRef.current.signal));
    } catch (err) {
      // Aborting the request closes the connection, which also stops the agent on the server.
      if (err instanceof DOMException && err.name === 'AbortError') {
        setCancelled(true);
        return;
      }
      setError(err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Something went wrong.', null));
    } finally {
      setLoading(false);
      refreshHistory();
    }
  }

  /** Reopens a past question from its saved snapshot, without calling the AI. */
  async function openSaved(item: HistoryItem) {
    if (loading) return;
    setError(null);
    setCancelled(false);
    try {
      const answer = await fetchSaved(item.id);
      setSaved(answer);
      setResponse(savedToResponse(answer));
      setAsked(answer.question);
      setQuestion(answer.question);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError('UNKNOWN', 'Could not open that question.', null));
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(question);
  }

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('askdb-theme', next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
    setTheme(next);
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◆</span> AskDB
          <span className="brand-tag">Ask your database in plain English</span>
        </div>
        <button className="ghost" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <div className="layout">
        <main className="main">
          <form className="ask-form card" onSubmit={onSubmit}>
            <label htmlFor="question" className="visually-hidden">Your question</label>
            <textarea
              id="question"
              value={question}
              maxLength={MAX_QUESTION_LENGTH}
              rows={2}
              placeholder="e.g. Which 5 customers spent the most money?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit(question);
                }
              }}
            />
            <div className="ask-row">
              <span className="muted">{question.length}/{MAX_QUESTION_LENGTH} · read-only, AI-generated SQL is checked before it runs</span>
              {/* Separate keys make React swap the element instead of turning the clicked
                  Cancel button into a submit button mid-click (which re-submitted the form). */}
              {loading ? (
                <button
                  key="cancel"
                  type="button"
                  className="secondary"
                  onClick={(event) => {
                    event.preventDefault();
                    abortRef.current?.abort();
                  }}
                >
                  Cancel
                </button>
              ) : (
                <button key="ask" type="submit" className="primary" disabled={!question.trim()}>Ask</button>
              )}
            </div>
          </form>

          {!response && !loading && !error && !cancelled && (
            <section className="examples" aria-label="Example questions">
              <p className="muted">Try one of these, about the sample Northwind sales database:</p>
              <div className="chips">
                {EXAMPLES.map((example) => (
                  <button key={example} className="chip" onClick={() => void submit(example)}>{example}</button>
                ))}
              </div>
            </section>
          )}

          {loading && (
            <div className="card loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Finding tables, writing and checking SQL… {elapsed}s
            </div>
          )}

          {cancelled && (
            <div className="card" role="status">
              Cancelled. AskDB stopped working on <q>{asked}</q>.
            </div>
          )}

          {error && (
            <div className="card error" role="alert">
              <strong>{errorTitle(error.code)}</strong>
              <p>{error.message}</p>
              {error.requestId && <p className="muted">Reference: {error.requestId}</p>}
            </div>
          )}

          {saved && saved.status === 'error' && (
            <div className="card">
              <p className="result-question">{saved.question}</p>
              <p>{saved.errorCode === 'CANCELLED' ? 'This question was cancelled before it finished.' : `This question did not get an answer (${saved.errorCode ?? 'error'}).`}</p>
              <button className="secondary" onClick={() => void submit(saved.question)}>Ask again</button>
            </div>
          )}

          {response && (
            <ResultView
              key={response.requestId}
              response={response}
              question={asked}
              savedAt={saved?.createdAt}
              onAskAgain={saved ? () => void submit(saved.question) : undefined}
            />
          )}
        </main>

        <aside className="sidebar" aria-label="Your recent questions">
          <h2>Your recent questions</h2>
          {history.length === 0 && <p className="muted">Questions you ask will appear here. Only you can see them.</p>}
          <ul className="history">
            {history.map((item) => (
              <li key={item.id}>
                <button className="history-item" onClick={() => void openSaved(item)} disabled={loading} title="Show the saved answer">
                  <span className={`dot dot-${historyKind(item)}`} aria-label={historyLabel(item)} title={historyLabel(item)} />
                  <span className="history-question">{item.question}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

/** History marker: cancelled questions are not failures, so they get their own marker. */
function historyKind(item: HistoryItem): 'answered' | 'no_data' | 'cancelled' | 'error' {
  return item.status === 'error' && item.errorCode === 'CANCELLED' ? 'cancelled' : item.status;
}

function historyLabel(item: HistoryItem): string {
  const labels = { answered: 'Answered', no_data: 'No data for this question', cancelled: 'Cancelled', error: 'Failed' };
  return labels[historyKind(item)];
}

/** Shapes a saved answer like a live one, so the same result view renders it. */
function savedToResponse(saved: SavedAnswer): AskResponse | null {
  if (saved.status === 'error') return null;
  const snapshot = saved.snapshot;
  return {
    requestId: `saved-${saved.id}`,
    status: saved.status,
    answer: saved.answer ?? '',
    sql: saved.sql,
    columns: snapshot?.columns ?? [],
    rows: snapshot?.rows ?? [],
    rowCount: snapshot?.rowCount ?? 0,
    truncated: snapshot?.truncated ?? false,
    chart: snapshot?.chart ?? 'none',
    unverifiedNumbers: snapshot?.unverifiedNumbers ?? [],
    steps: saved.steps,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: null },
    durationMs: 0,
  };
}

function currentTheme(): Theme {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'light' || stamped === 'dark') return stamped;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function errorTitle(code: string): string {
  switch (code) {
    case 'RATE_LIMITED':
      return 'Slow down a little';
    case 'BUDGET_EXCEEDED':
      return 'Daily limit reached';
    case 'NETWORK':
      return 'Server unreachable';
    default:
      return 'AskDB could not answer';
  }
}
