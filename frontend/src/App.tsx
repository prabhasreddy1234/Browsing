import { useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

type DashboardSummary = {
  total_tests: number;
  jev_accuracy: number;
  openai_accuracy: number;
  average_jev_latency_ms: number;
  average_openai_latency_ms: number;
  total_jev_cost: number;
  total_openai_cost: number;
  estimated_cost_savings_percent: number;
};

type ResultRow = {
  run_id: string;
  query: string;
  expected_tool: string;
  jev_tool?: string;
  openai_tool?: string;
  jev_latency_ms?: number;
  openai_latency_ms?: number;
  jev_estimated_cost?: number;
  openai_estimated_cost?: number;
  jev_correct?: boolean;
  openai_correct?: boolean;
  jev_model?: string;
  openai_model?: string;
};

type BenchmarkRun = {
  id: string;
  run_name: string;
  created_at: string;
  config: string;
  summary: string;
  results: string;
};

const API_BASE = 'http://localhost:8000';

const currency = (value: number) => `$${Number(value || 0).toFixed(8)}`;

const EMPTY_SUMMARY: DashboardSummary = {
  total_tests: 0,
  jev_accuracy: 0,
  openai_accuracy: 0,
  average_jev_latency_ms: 0,
  average_openai_latency_ms: 0,
  total_jev_cost: 0,
  total_openai_cost: 0,
  estimated_cost_savings_percent: 0,
};

type TabKey = 'dashboard' | 'llm' | 'browser';

type LlmOnlyResult = {
  mode: string;
  query: string;
  selected_tool: string;
  decision: { tool: string; confidence: number; reason: string };
  total_time_ms: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  model?: string;
};

type AgentStep = {
  step: string;
  label: string;
  tool?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  simulated?: boolean;
  reason?: string;
  mode?: string;
  engine?: string;
  url?: string;
  http_status?: number | null;
  latency_ms: number;
  cost: number;
};

type BrowserResult = {
  query: string;
  selected_tool: string;
  jev: {
    tool: string;
    confidence: number;
    probabilities: Record<string, number>;
    clarity: number;
    simulated: boolean;
    low_confidence: boolean;
    latency_ms: number;
    cost: number;
    input_tokens: number;
  };
  answer: string;
  browser: {
    engine: string;
    url: string;
    final_url: string;
    http_status?: number | null;
    title: string;
    snippet: string;
    browser_time_ms: number;
    fallback: boolean;
    fallback_reason?: string;
  };
  steps: AgentStep[];
  total_time_ms: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
};

type AppStatus = {
  jev: string;
  jev_in_per_m: number;
  jev_note: string;
  llm: string;
  llm_model: string;
  budget_usd: number;
};

type LiveStep = {
  index: number;
  total: number;
  step: string;
  label: string;
  status: 'running' | 'done';
  startedAt: number;
  latency_ms?: number;
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  tool?: string;
  confidence?: number;
  simulated?: boolean;
  engine?: string;
  http_status?: number | null;
  url?: string;
  target?: string;
  mode?: string;
  cumulative_time_ms?: number;
  cumulative_cost?: number;
  cumulative_input_tokens?: number;
  cumulative_output_tokens?: number;
};

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);

  // LLM-only tab state
  const [llmQuery, setLlmQuery] = useState('What is the capital of Australia?');
  const [llmResult, setLlmResult] = useState<LlmOnlyResult | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState('');

  // Jev + LLM browser tab state
  const [browserQuery, setBrowserQuery] = useState('Find information about Android 16');
  const [browserResult, setBrowserResult] = useState<BrowserResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [nowTick, setNowTick] = useState(0);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [queries, setQueries] = useState<string[]>([]);
  const [customQuery, setCustomQuery] = useState('');
  const [customExpectedTool, setCustomExpectedTool] = useState('weather');
  const [status, setStatus] = useState('Idle');
  const [loading, setLoading] = useState(false);
  const [jsonPayload, setJsonPayload] = useState('');
  const [runConfig, setRunConfig] = useState({
    runs: 1,
    openaiModel: 'gpt-4o-mini',
    jevModel: 'typesafe/jev-1.13',
    temperature: 0,
    runOpenai: true,
    runJev: true,
  });

  const statusClass = status.toLowerCase().replace(/[^a-z0-9]/g, '');

  const fetchSummary = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/benchmark/summary`);
      const data = await response.json();
      if (data.summary) {
        setSummary({
          ...EMPTY_SUMMARY,
          ...data.summary,
          total_tests: Number(data.summary.total_tests ?? 0),
          jev_accuracy: Number(data.summary.jev_accuracy ?? 0),
          openai_accuracy: Number(data.summary.openai_accuracy ?? 0),
          average_jev_latency_ms: Number(data.summary.average_jev_latency_ms ?? 0),
          average_openai_latency_ms: Number(data.summary.average_openai_latency_ms ?? 0),
          total_jev_cost: Number(data.summary.total_jev_cost ?? 0),
          total_openai_cost: Number(data.summary.total_openai_cost ?? 0),
          estimated_cost_savings_percent: Number(data.summary.estimated_cost_savings_percent ?? 0),
        } as DashboardSummary);
      } else {
        setSummary(EMPTY_SUMMARY);
      }
    } catch (error) {
      setSummary(EMPTY_SUMMARY);
    }
  };

  const fetchResults = async () => {
    const response = await fetch(`${API_BASE}/api/benchmark/results`);
    const data = await response.json();
    if (data.runs) {
      setRuns(data.runs);
      const allResults: ResultRow[] = [];
      data.runs.forEach((run: BenchmarkRun) => {
        const values = JSON.parse(run.results || '[]');
        allResults.push(...values);
      });
      setResults(allResults);
    }
  };

  const fetchQueries = async () => {
    const response = await fetch(`${API_BASE}/api/benchmark/default-queries`);
    const data = await response.json();
    setQueries((data.queries || []).map((row: any) => row.query));
  };

  const fetchStatus = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/status`);
      const data = await response.json();
      setAppStatus(data as AppStatus);
    } catch (error) {
      setAppStatus(null);
    }
  };

  const refreshData = async () => {
    await fetchStatus();
    await fetchSummary();
    await fetchResults();
    await fetchQueries();
  };

  useEffect(() => {
    refreshData();
  }, []);

  // Ticks while the browser agent runs, so the active step shows a live elapsed timer.
  useEffect(() => {
    if (!browserLoading) return;
    const id = setInterval(() => setNowTick(Date.now()), 100);
    return () => clearInterval(id);
  }, [browserLoading]);

  const latencyChartData = useMemo(() => {
    const jev = results.filter((row) => row.jev_latency_ms != null).map((row) => row.jev_latency_ms as number);
    const openai = results.filter((row) => row.openai_latency_ms != null).map((row) => row.openai_latency_ms as number);
    return [
      { name: 'Avg latency', jev: jev.reduce((a, b) => a + b, 0) / Math.max(1, jev.length), openai: openai.reduce((a, b) => a + b, 0) / Math.max(1, openai.length) },
      { name: 'P50 latency', jev: jev.sort((a,b)=>a-b)[Math.floor(jev.length/2)] || 0, openai: openai.sort((a,b)=>a-b)[Math.floor(openai.length/2)] || 0 },
    ];
  }, [results]);

  const costChartData = useMemo(() => {
    const points: { name: string; jev: number; openai: number }[] = [];
    let jevRunning = 0;
    let openaiRunning = 0;
    for (let i = 0; i < Math.max(results.length, 1); i += 1) {
      const entry = results[i];
      if (!entry) continue;
      jevRunning += Number(entry.jev_estimated_cost ?? 0);
      openaiRunning += Number(entry.openai_estimated_cost ?? 0);
      points.push({ name: `Req ${i + 1}`, jev: jevRunning, openai: openaiRunning });
    }
    return points;
  }, [results]);

  const accuracyData = useMemo(() => {
    const total = results.length || 1;
    const jevCount = results.filter((r) => r.jev_correct).length;
    const openaiCount = results.filter((r) => r.openai_correct).length;
    return [
      { name: 'Accuracy', jev: (jevCount / total) * 100, openai: (openaiCount / total) * 100 },
    ];
  }, [results]);

  const scatterData = useMemo(
    () =>
      results
        .filter((row) => row.jev_estimated_cost != null && row.openai_estimated_cost != null)
        .map((row) => ({
          x: Number(row.jev_estimated_cost ?? 0),
          y: Number(row.openai_estimated_cost ?? 0),
          z: Number(row.jev_latency_ms ?? 0),
          name: row.query.slice(0, 24),
        })),
    [results]
  );

  const runBenchmark = async () => {
    setLoading(true);
    setStatus('Running...');
    try {
      const response = await fetch(`${API_BASE}/api/benchmark/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: queries.length ? queries : undefined,
          runs: Number(runConfig.runs),
          openai_model: runConfig.openaiModel,
          jev_model: runConfig.jevModel,
          temperature: Number(runConfig.temperature),
          run_openai: runConfig.runOpenai,
          run_jev: runConfig.runJev,
        }),
      });
      const data = await response.json();
      setJsonPayload(JSON.stringify(data, null, 2));
      setStatus(response.ok ? 'Completed' : 'Failed');
      if (response.ok) {
        await refreshData();
      }
    } catch (error) {
      setStatus('Failed');
      setJsonPayload(JSON.stringify({ error: String(error) }, null, 2));
    } finally {
      setLoading(false);
    }
  };

  const runAll = async () => { 
    setLoading(true);
    setStatus('Running...');
    try {
      const response = await fetch(`${API_BASE}/api/benchmark/run-all`, { method: 'POST' });
      const data = await response.json();
      setJsonPayload(JSON.stringify(data, null, 2));
      setStatus(response.ok ? 'Completed' : 'Failed');
      if (response.ok) await refreshData();
    } catch (error) {
      setStatus('Failed');
      setJsonPayload(JSON.stringify({ error: String(error) }, null, 2));
    } finally {
      setLoading(false);
    }
  };

  const addCustomQuery = () => {
    if (!customQuery.trim()) return;
    setQueries((prev) => [...prev, customQuery.trim()]);
    setCustomQuery('');
    setCustomExpectedTool('weather');
  };

  const clearHistory = async () => {
    setResults([]);
    setRuns([]);
    setSummary(null);
  };

  const runLlmOnly = async () => {
    if (!llmQuery.trim()) return;
    setLlmLoading(true);
    setLlmError('');
    setLlmResult(null);
    try {
      const response = await fetch(`${API_BASE}/api/agent/llm-only`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: llmQuery.trim(), temperature: 0 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Request failed');
      setLlmResult(data as LlmOnlyResult);
    } catch (error) {
      setLlmError(String(error instanceof Error ? error.message : error));
    } finally {
      setLlmLoading(false);
    }
  };

  const handleStreamEvent = (ev: any) => {
    if (ev.type === 'step_start') {
      setLiveSteps((prev) => [
        ...prev,
        {
          index: ev.index,
          total: ev.total,
          step: ev.step,
          label: ev.label,
          status: 'running',
          startedAt: Date.now(),
          target: ev.target,
          mode: ev.mode,
        },
      ]);
    } else if (ev.type === 'step_end') {
      setLiveSteps((prev) =>
        prev.map((s) =>
          s.step === ev.step && s.status === 'running'
            ? {
                ...s,
                status: 'done',
                latency_ms: ev.latency_ms,
                cost: ev.cost,
                input_tokens: ev.input_tokens,
                output_tokens: ev.output_tokens,
                tool: ev.tool,
                confidence: ev.confidence,
                simulated: ev.simulated,
                engine: ev.engine,
                http_status: ev.http_status,
                url: ev.url,
                cumulative_time_ms: ev.cumulative_time_ms,
                cumulative_cost: ev.cumulative_cost,
                cumulative_input_tokens: ev.cumulative_input_tokens,
                cumulative_output_tokens: ev.cumulative_output_tokens,
              }
            : s
        )
      );
    } else if (ev.type === 'done') {
      setBrowserResult(ev.result as BrowserResult);
    } else if (ev.type === 'error') {
      setBrowserError(String(ev.error));
    }
  };

  const runBrowserAgent = async () => {
    if (!browserQuery.trim()) return;
    setBrowserLoading(true);
    setBrowserError('');
    setBrowserResult(null);
    setLiveSteps([]);
    try {
      const response = await fetch(`${API_BASE}/api/agent/browser/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: browserQuery.trim(), temperature: 0.2 }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || 'Request failed');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Parse the Server-Sent Events stream: events are separated by a blank line.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            handleStreamEvent(JSON.parse(dataLine.slice(5).trim()));
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    } catch (error) {
      setBrowserError(String(error instanceof Error ? error.message : error));
    } finally {
      setBrowserLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Jev Decision Benchmark</h1>
        <nav>
          <button
            className={`nav-link ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-link ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
          >
            LLM Only
          </button>
          <button
            className={`nav-link ${activeTab === 'browser' ? 'active' : ''}`}
            onClick={() => setActiveTab('browser')}
          >
            Jev + LLM (Browser)
          </button>
        </nav>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h2>
              {activeTab === 'dashboard' && 'Benchmark Dashboard'}
              {activeTab === 'llm' && 'LLM Only — tool decision'}
              {activeTab === 'browser' && 'Jev + LLM — live browser agent'}
            </h2>
          </div>
          <div className={`status ${statusClass}`}>{status}</div>
        </header>

        {activeTab === 'dashboard' && (
        <>
        <section className="kpis">
          <div className="card">
            <span>Total Tests</span>
            <strong>{summary?.total_tests ?? results.length}</strong>
          </div>
          <div className="card">
            <span>Jev Accuracy</span>
            <strong>{`${Number(summary?.jev_accuracy ?? 0).toFixed(2)}%`}</strong>
          </div>
          <div className="card">
            <span>OpenAI Accuracy</span>
            <strong>{`${Number(summary?.openai_accuracy ?? 0).toFixed(2)}%`}</strong>
          </div>
          <div className="card">
            <span>Avg Jev Latency</span>
            <strong>{`${Number(summary?.average_jev_latency_ms ?? 0).toFixed(0)} ms`}</strong>
          </div>
          <div className="card">
            <span>Avg OpenAI Latency</span>
            <strong>{`${Number(summary?.average_openai_latency_ms ?? 0).toFixed(0)} ms`}</strong>
          </div>
          <div className="card">
            <span>Total Jev Cost</span>
            <strong>{currency(Number(summary?.total_jev_cost ?? 0))}</strong>
          </div>
          <div className="card">
            <span>Total OpenAI Cost</span>
            <strong>{currency(Number(summary?.total_openai_cost ?? 0))}</strong>
          </div>
          <div className="card">
            <span>Estimated Savings</span>
            <strong>{`${Number(summary?.estimated_cost_savings_percent ?? 0).toFixed(2)}%`}</strong>
          </div>
        </section>

        <section className="charts-grid">
          <div className="panel">
            <h3>Latency comparison</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={latencyChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="jev" fill="#25c2a0" name="Jev" />
                <Bar dataKey="openai" fill="#f59e0b" name="OpenAI" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel">
            <h3>Cost comparison</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={costChartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line dataKey="jev" stroke="#25c2a0" />
                <Line dataKey="openai" stroke="#f59e0b" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="panel">
            <h3>Accuracy comparison</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={accuracyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="jev" fill="#25c2a0" name="Jev" />
                <Bar dataKey="openai" fill="#f59e0b" name="OpenAI" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel">
            <h3>Cost vs accuracy</h3>
            <ResponsiveContainer width="100%" height={220}>
              <ScatterChart>
                <CartesianGrid />
                <XAxis type="number" dataKey="x" name="Jev cost" />
                <YAxis type="number" dataKey="y" name="OpenAI cost" />
                <ZAxis type="number" dataKey="z" range={[60, 400]} name="Latency" />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                <Scatter data={scatterData} fill="#8b5cf6" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="experiment-controls">
          <div className="panel controls-panel">
            <h3>Experiment controls</h3>
            <div className="control-grid">
              <label>
                OpenAI model
                <input value={runConfig.openaiModel} onChange={(e) => setRunConfig({ ...runConfig, openaiModel: e.target.value })} />
              </label>
              <label>
                Jev model
                <input value={runConfig.jevModel} onChange={(e) => setRunConfig({ ...runConfig, jevModel: e.target.value })} />
              </label>
              <label>
                Number of benchmark runs
                <input type="number" min={1} value={runConfig.runs} onChange={(e) => setRunConfig({ ...runConfig, runs: Number(e.target.value) })} />
              </label>
              <label>
                Temperature
                <input type="number" step="0.1" value={runConfig.temperature} onChange={(e) => setRunConfig({ ...runConfig, temperature: Number(e.target.value) })} />
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={runConfig.runJev} onChange={(e) => setRunConfig({ ...runConfig, runJev: e.target.checked })} />
                Run Jev only
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={runConfig.runOpenai} onChange={(e) => setRunConfig({ ...runConfig, runOpenai: e.target.checked })} />
                Run OpenAI only
              </label>
            </div>
            <div className="button-row">
              <button onClick={runBenchmark} disabled={loading}>{loading ? 'Running...' : 'Run benchmark'}</button>
              <button onClick={runAll} disabled={loading}>Run entire benchmark</button>
              <button className="secondary" onClick={clearHistory}>Clear history</button>
            </div>
          </div>

          <div className="panel custom-panel">
            <h3>Add custom test query</h3>
            <textarea value={customQuery} onChange={(e) => setCustomQuery(e.target.value)} placeholder="What is the weather in Hyderabad?" />
            <select value={customExpectedTool} onChange={(e) => setCustomExpectedTool(e.target.value)}>
              <option value="web_search">web_search</option>
              <option value="fetch_webpage">fetch_webpage</option>
              <option value="weather">weather</option>
              <option value="calculator">calculator</option>
              <option value="database_search">database_search</option>
              <option value="file_search">file_search</option>
              <option value="no_tool">no_tool</option>
            </select>
            <button onClick={addCustomQuery}>Add query</button>
            <ul className="query-list">
              {queries.map((query, idx) => <li key={`${query}-${idx}`}>{query}</li>)}
            </ul>
          </div>
        </section>

        <section className="panel">
          <h3>Request-level comparison</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Expected</th>
                  <th>Jev Tool</th>
                  <th>LLM Tool</th>
                  <th>Jev Latency</th>
                  <th>LLM Latency</th>
                  <th>Jev Cost</th>
                  <th>LLM Cost</th>
                  <th>Correctness</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 20).map((row, idx) => (
                  <tr key={`${row.query}-${idx}`}>
                    <td>{row.query}</td>
                    <td>{row.expected_tool}</td>
                    <td>{row.jev_tool ?? '—'}</td>
                    <td>{row.openai_tool ?? '—'}</td>
                    <td>{row.jev_latency_ms ? `${row.jev_latency_ms.toFixed(0)} ms` : '—'}</td>
                    <td>{row.openai_latency_ms ? `${row.openai_latency_ms.toFixed(0)} ms` : '—'}</td>
                    <td>{row.jev_estimated_cost != null ? currency(row.jev_estimated_cost) : '—'}</td>
                    <td>{row.openai_estimated_cost != null ? currency(row.openai_estimated_cost) : '—'}</td>
                    <td>{row.jev_correct !== undefined || row.openai_correct !== undefined ? `${row.jev_correct ? 'Jev' : ''}${row.jev_correct && row.openai_correct ? '/' : ''}${row.openai_correct ? 'OpenAI' : ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="architecture-grid">
          <div className="panel arch-panel">
            <h3>Traditional architecture</h3>
            <pre>User
 ↓
OpenAI LLM
 ↓
Tool Selection
 ↓
Tool</pre>
            <p>Measured latency: {`${Number(summary?.average_openai_latency_ms ?? 0).toFixed(0)} ms`}</p>
            <p>Measured cost: {currency(Number(summary?.total_openai_cost ?? 0))}</p>
          </div>
          <div className="panel arch-panel">
            <h3>Jev routing architecture</h3>
            <pre>User
 ↓
Jev
 ↓
Tool Selection
 ↓
Tool
 ↓
OpenAI LLM only when required</pre>
            <p>Measured latency: {`${Number(summary?.average_jev_latency_ms ?? 0).toFixed(0)} ms`}</p>
            <p>Measured cost: {currency(Number(summary?.total_jev_cost ?? 0))}</p>
          </div>
        </section>

        <section className="panel">
          <h3>Cost optimization simulator</h3>
          <div className="simulator-grid">
            <div>
              <label>Requests per day<input defaultValue={100000} /></label>
              <label>Requests per month<input defaultValue={3000000} /></label>
              <label>Average input tokens<input defaultValue={1200} /></label>
              <label>Average output tokens<input defaultValue={220} /></label>
            </div>
            <div className="simulator-results">
              <p>Jev monthly estimated cost: $0.00000000</p>
              <p>OpenAI monthly estimated cost: $0.00000000</p>
              <p>Estimated difference: $0.00000000</p>
              <p>Estimated percentage difference: 0.00%</p>
              <p>Scenario: 100,000 requests with only 30% requiring main LLM.</p>
            </div>
          </div>
        </section>

        <section className="panel">
          <h3>API response</h3>
          <pre>{jsonPayload || 'No benchmark results yet.'}</pre>
        </section>
        </>
        )}

        {activeTab === 'llm' && (
          <section className="agent-view">
            <div className="panel">
              <h3>LLM only</h3>
              <p className="muted">
                The query goes straight to the LLM, which selects one tool. No Jev routing and no
                browser — this is the traditional baseline. Time and cost are logged below.
              </p>
              <textarea
                value={llmQuery}
                onChange={(e) => setLlmQuery(e.target.value)}
                placeholder="Ask something, e.g. What is the capital of Australia?"
              />
              <div className="button-row">
                <button onClick={runLlmOnly} disabled={llmLoading}>
                  {llmLoading ? 'Running...' : 'Run LLM'}
                </button>
              </div>
              {llmError && <p className="error-text">{llmError}</p>}
            </div>

            {llmResult && (
              <>
                <section className="kpis">
                  <div className="card">
                    <span>Selected tool</span>
                    <strong>{llmResult.selected_tool}</strong>
                  </div>
                  <div className="card">
                    <span>Confidence</span>
                    <strong>{`${(Number(llmResult.decision.confidence) * 100).toFixed(0)}%`}</strong>
                  </div>
                  <div className="card">
                    <span>Time</span>
                    <strong>{`${Number(llmResult.total_time_ms).toFixed(0)} ms`}</strong>
                  </div>
                  <div className="card">
                    <span>Cost</span>
                    <strong>{currency(llmResult.total_cost)}</strong>
                  </div>
                  <div className="card">
                    <span>Input tokens</span>
                    <strong>{llmResult.total_input_tokens}</strong>
                  </div>
                  <div className="card">
                    <span>Output tokens</span>
                    <strong>{llmResult.total_output_tokens}</strong>
                  </div>
                </section>
                <div className="panel">
                  <h3>Reasoning</h3>
                  <p>{llmResult.decision.reason}</p>
                  <p className="muted">Model: {llmResult.model || '—'}</p>
                </div>
              </>
            )}
          </section>
        )}

        {activeTab === 'browser' && (
          <section className="agent-view">
            <div className="panel">
              <h3>
                Jev + LLM with a real browser{' '}
                {appStatus && (
                  <span className={`badge ${appStatus.jev === 'live' ? 'badge-live' : 'badge-sim'}`}>
                    Jev: {appStatus.jev}
                  </span>
                )}
                {appStatus && (
                  <span className={`badge ${appStatus.llm === 'live' ? 'badge-live' : 'badge-sim'}`}>
                    LLM: {appStatus.llm}
                  </span>
                )}
              </h3>
              <p className="muted">
                <strong>Jev makes the decision</strong> (a typed System One choice — input-billed only
                at ${appStatus ? appStatus.jev_in_per_m : 0.042}/1M, output free). <strong>Your code owns
                the control flow</strong> and opens a real headless Chromium browser. <strong>The LLM
                writes the words</strong> — a short answer grounded in the page. Time and cost are logged
                per step below.
              </p>
              <textarea
                value={browserQuery}
                onChange={(e) => setBrowserQuery(e.target.value)}
                placeholder="e.g. Find information about Android 16, or paste a URL to open"
              />
              <div className="button-row">
                <button onClick={runBrowserAgent} disabled={browserLoading}>
                  {browserLoading ? 'Opening browser...' : 'Run browser agent'}
                </button>
              </div>
              {browserError && <p className="error-text">{browserError}</p>}
            </div>

            {liveSteps.length > 0 && (
              <div className="panel">
                <h3>
                  Live workflow{' '}
                  <span className="muted">
                    {liveSteps.filter((s) => s.status === 'done').length}/{liveSteps[0]?.total ?? 3} steps
                  </span>
                </h3>
                <div className="wf-progress">
                  <div
                    className="wf-progress-fill"
                    style={{
                      width: `${(liveSteps.filter((s) => s.status === 'done').length / (liveSteps[0]?.total ?? 3)) * 100}%`,
                    }}
                  />
                </div>
                <ol className="workflow">
                  {liveSteps.map((s) => {
                    const elapsed =
                      s.status === 'running' ? (nowTick - s.startedAt) / 1000 : (s.latency_ms ?? 0) / 1000;
                    return (
                      <li key={`${s.step}-${s.index}`} className={`workflow-step ${s.status}`}>
                        <span className="wf-dot" />
                        <div className="wf-body">
                          <div className="wf-head">
                            <span className="wf-label">
                              {s.index}/{s.total} · {s.label}
                            </span>
                            <span className="wf-time">
                              {s.status === 'running' ? `${elapsed.toFixed(1)}s…` : `${(s.latency_ms ?? 0).toFixed(0)} ms`}
                            </span>
                          </div>
                          <div className="wf-detail">
                            {s.step === 'jev_decide' &&
                              (s.status === 'done' ? (
                                <>
                                  chose <strong>{s.tool}</strong> @ {(Number(s.confidence) * 100).toFixed(0)}%
                                  {s.simulated ? ' (simulated)' : ''}
                                </>
                              ) : (
                                'deciding the path…'
                              ))}
                            {s.step === 'browser' &&
                              (s.status === 'running' ? (
                                <>opening {s.target}</>
                              ) : (
                                <>
                                  {s.engine} → {s.url} {s.http_status ? `(${s.http_status})` : ''}
                                </>
                              ))}
                            {s.step === 'llm_answer' && (s.status === 'done' ? 'answer written' : 'writing the answer…')}
                          </div>
                          {s.status === 'done' && (
                            <div className="wf-metrics">
                              <span>
                                tokens {s.input_tokens ?? 0} → {s.output_tokens ?? 0}
                              </span>
                              <span>cost {currency(s.cost ?? 0)}</span>
                              {s.cumulative_time_ms != null && (
                                <span>elapsed {(s.cumulative_time_ms / 1000).toFixed(1)}s</span>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            {browserResult && (
              <>
                <section className="kpis">
                  <div className="card">
                    <span>Selected tool</span>
                    <strong>{browserResult.selected_tool}</strong>
                  </div>
                  <div className="card">
                    <span>Total time</span>
                    <strong>{`${Number(browserResult.total_time_ms).toFixed(0)} ms`}</strong>
                  </div>
                  <div className="card">
                    <span>Total cost</span>
                    <strong>{currency(browserResult.total_cost)}</strong>
                  </div>
                  <div className="card">
                    <span>Browser time</span>
                    <strong>{`${Number(browserResult.browser.browser_time_ms).toFixed(0)} ms`}</strong>
                  </div>
                  <div className="card">
                    <span>Input tokens</span>
                    <strong>{browserResult.total_input_tokens}</strong>
                  </div>
                  <div className="card">
                    <span>Output tokens</span>
                    <strong>{browserResult.total_output_tokens}</strong>
                  </div>
                </section>

                <div className="panel">
                  <h3>
                    Jev decision (System One){' '}
                    <span className={`badge ${browserResult.jev.simulated ? 'badge-sim' : 'badge-live'}`}>
                      {browserResult.jev.simulated ? 'simulated' : 'live'}
                    </span>
                    {browserResult.jev.low_confidence && (
                      <span className="badge badge-warn">low confidence</span>
                    )}
                  </h3>
                  <p>
                    Chose <strong>{browserResult.jev.tool}</strong> at{' '}
                    <strong>{`${(browserResult.jev.confidence * 100).toFixed(0)}%`}</strong> confidence in{' '}
                    {`${browserResult.jev.latency_ms.toFixed(0)} ms`} for {currency(browserResult.jev.cost)}.
                  </p>
                  <div className="prob-bars">
                    {Object.entries(browserResult.jev.probabilities)
                      .sort((a, b) => b[1] - a[1])
                      .map(([tool, prob]) => (
                        <div key={tool} className="prob-row">
                          <span className="prob-label">{tool}</span>
                          <div className="prob-track">
                            <div
                              className="prob-fill"
                              style={{ width: `${Math.max(2, prob * 100)}%` }}
                            />
                          </div>
                          <span className="prob-val">{`${(prob * 100).toFixed(0)}%`}</span>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="panel">
                  <h3>LLM answer (grounded in the page)</h3>
                  <p>{browserResult.answer}</p>
                </div>

                <div className="panel">
                  <h3>Agent steps (time &amp; cost per step)</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Step</th>
                          <th>Detail</th>
                          <th>Time</th>
                          <th>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {browserResult.steps.map((step, idx) => (
                          <tr key={`${step.step}-${idx}`}>
                            <td>{step.label}</td>
                            <td>
                              {step.step === 'browser'
                                ? `${step.engine} → ${step.url}${step.http_status ? ` (${step.http_status})` : ''}`
                                : step.reason || step.tool || '—'}
                            </td>
                            <td>{`${Number(step.latency_ms).toFixed(0)} ms`}</td>
                            <td>{currency(step.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="panel">
                  <h3>Browser result</h3>
                  <p className="muted">
                    Engine: {browserResult.browser.engine}
                    {browserResult.browser.fallback &&
                      ' (Playwright unavailable — fell back to HTTP fetch. Run "playwright install chromium".)'}
                  </p>
                  <p>
                    <strong>{browserResult.browser.title || '(no title)'}</strong>
                  </p>
                  <p className="muted">{browserResult.browser.final_url}</p>
                  <pre>{browserResult.browser.snippet || '(no text captured)'}</pre>
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
