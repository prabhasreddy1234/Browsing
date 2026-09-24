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

type ActivityStats = {
  runs: number;
  total_time_ms: number;
  average_time_ms: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  average_decision_latency_ms: number;
  last_query: string | null;
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

const chartColors = {
  jev: '#65d8b5',
  openai: '#f2b35d',
  grid: 'rgba(163, 195, 185, 0.14)',
  axis: '#78908b',
};

const chartAxis = { fill: chartColors.axis, fontSize: 11 };

function BenchmarkTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-label">{label}</div>
      {payload.map((entry: any) => (
        <div className="chart-tooltip-row" key={entry.dataKey}>
          <span><i style={{ background: entry.color }} />{entry.name || entry.dataKey}</span>
          <strong>{typeof entry.value === 'number' ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : entry.value}</strong>
        </div>
      ))}
    </div>
  );
}

// Human-readable dollars for larger (monthly) totals.
const usd = (value: number) =>
  `$${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(Number(value)) < 1 ? 6 : 2,
  })}`;

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

const EMPTY_ACTIVITY: ActivityStats = {
  runs: 0, total_time_ms: 0, average_time_ms: 0, total_cost: 0,
  total_input_tokens: 0, total_output_tokens: 0,
  average_decision_latency_ms: 0, last_query: null,
};

type TabKey = 'dashboard' | 'llm' | 'browser' | 'compare';

type Comparison = {
  same_tool: boolean;
  jev_tool: string;
  llm_tool: string;
  decision_latency_ms: { jev: number; llm: number };
  decision_cost: { jev: number; llm: number };
  decision_tokens: { jev: number; llm: number };
  total_time_ms: { jev: number; llm: number };
  total_cost: { jev: number; llm: number };
  total_tokens: { jev: number; llm: number };
  decision_cost_savings_pct: number;
  decision_latency_savings_pct: number;
  total_cost_savings_pct: number;
  total_time_savings_pct: number;
};

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
  approach?: string;
  query: string;
  selected_tool: string;
  decision_latency_ms?: number;
  decision_cost?: number;
  decision_tokens?: number;
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

function WorkflowSteps({ steps, nowTick }: { steps: LiveStep[]; nowTick: number }) {
  return (
    <ol className="workflow">
      {steps.map((s) => {
        const elapsed = s.status === 'running' ? (nowTick - s.startedAt) / 1000 : (s.latency_ms ?? 0) / 1000;
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
                {(s.step === 'jev_decide' || s.step === 'llm_decide') &&
                  (s.status === 'done' ? (
                    <>
                      chose <strong>{s.tool}</strong>
                      {s.confidence != null ? ` @ ${(Number(s.confidence) * 100).toFixed(0)}%` : ''}
                      {s.simulated ? ' (simulated)' : ''}
                    </>
                  ) : (
                    'deciding the path…'
                  ))}
                {s.step === 'browser' &&
                  (s.status === 'running' ? (
                    <>searching {s.target}</>
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
                  {s.cumulative_time_ms != null && <span>elapsed {(s.cumulative_time_ms / 1000).toFixed(1)}s</span>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [sim, setSim] = useState({ requestsPerMonth: 3000000, avgInput: 1200, avgOutput: 220, pctLlm: 30 });

  // LLM-only tab state
  const [llmQuery, setLlmQuery] = useState('What is the capital of Australia?');
  const [llmResult, setLlmResult] = useState<BrowserResult | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState('');
  const [llmOnlySteps, setLlmOnlySteps] = useState<LiveStep[]>([]);

  // Jev + LLM browser tab state
  const [browserQuery, setBrowserQuery] = useState('Find information about Android 16');
  const [browserResult, setBrowserResult] = useState<BrowserResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState('');
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [nowTick, setNowTick] = useState(0);

  // Compare tab state (Jev+LLM vs LLM-only, side by side)
  const [compareQuery, setCompareQuery] = useState('What is the latest news about Android 16?');
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [jevSteps, setJevSteps] = useState<LiveStep[]>([]);
  const [llmSteps, setLlmSteps] = useState<LiveStep[]>([]);
  const [jevResult, setJevResult] = useState<BrowserResult | null>(null);
  const [cmpLlmResult, setCmpLlmResult] = useState<BrowserResult | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [activityStats, setActivityStats] = useState<Record<string, ActivityStats>>({
    'LLM only': EMPTY_ACTIVITY, 'Jev + LLM': EMPTY_ACTIVITY,
  });
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

  const fetchPricing = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/benchmark/cost-analysis`);
      const data = await response.json();
      setPricing(data.pricing || null);
    } catch (error) {
      setPricing(null);
    }
  };

  const fetchActivityStats = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/activity/stats`);
      const data = await response.json();
      setActivityStats({
        'LLM only': { ...EMPTY_ACTIVITY, ...(data.stats?.['LLM only'] || {}) },
        'Jev + LLM': { ...EMPTY_ACTIVITY, ...(data.stats?.['Jev + LLM'] || {}) },
      });
    } catch {
      setActivityStats({ 'LLM only': EMPTY_ACTIVITY, 'Jev + LLM': EMPTY_ACTIVITY });
    }
  };

  const refreshData = async () => {
    await fetchStatus();
    await fetchPricing();
    await fetchSummary();
    await fetchResults();
    await fetchQueries();
    await fetchActivityStats();
  };

  useEffect(() => {
    refreshData();
  }, []);

  // Ticks while an agent runs, so the active step shows a live elapsed timer.
  useEffect(() => {
    if (!browserLoading && !compareLoading && !llmLoading) return;
    const id = setInterval(() => setNowTick(Date.now()), 100);
    return () => clearInterval(id);
  }, [browserLoading, compareLoading, llmLoading]);

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
    // Only count graded results (jev_correct / openai_correct is a real boolean).
    const jevGraded = results.filter((r) => r.jev_correct === true || r.jev_correct === false);
    const openaiGraded = results.filter((r) => r.openai_correct === true || r.openai_correct === false);
    const jevCount = jevGraded.filter((r) => r.jev_correct).length;
    const openaiCount = openaiGraded.filter((r) => r.openai_correct).length;
    return [
      {
        name: 'Accuracy',
        jev: jevGraded.length ? (jevCount / jevGraded.length) * 100 : 0,
        openai: openaiGraded.length ? (openaiCount / openaiGraded.length) * 100 : 0,
      },
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
      await fetchActivityStats();
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
    try {
      await fetch(`${API_BASE}/api/benchmark/results`, { method: 'DELETE' });
    } catch (error) {
      /* ignore */
    }
    setResults([]);
    setRuns([]);
    setSummary(EMPTY_SUMMARY);
    setJsonPayload('');
    await refreshData();
  };

  // Live cost model for the simulator, using the real pricing table + Jev price.
  const simResult = useMemo(() => {
    const llmModel = appStatus?.llm_model || 'gpt-4o-mini';
    const p = (pricing?.openai?.[llmModel]) || { input: 0.15, output: 0.6 };
    const jevIn = appStatus?.jev_in_per_m ?? 0.042;
    const perLlmCall = (sim.avgInput * p.input + sim.avgOutput * p.output) / 1_000_000;
    const jevDecision = (sim.avgInput * jevIn) / 1_000_000; // Jev bills input only
    const llmOnly = sim.requestsPerMonth * perLlmCall;
    const jevRouted = sim.requestsPerMonth * jevDecision + sim.requestsPerMonth * (sim.pctLlm / 100) * perLlmCall;
    const diff = llmOnly - jevRouted;
    const pct = llmOnly ? (diff / llmOnly) * 100 : 0;
    return { llmModel, perLlmCall, jevDecision, llmOnly, jevRouted, diff, pct };
  }, [sim, pricing, appStatus]);

  const runLlmOnly = async () => {
    if (!llmQuery.trim()) return;
    setLlmLoading(true);
    setLlmError('');
    setLlmResult(null);
    setLlmOnlySteps([]);
    try {
      await streamSSE('/api/agent/llm/stream', { query: llmQuery.trim(), temperature: 0.2 }, (ev) => {
        applyStepEvent(setLlmOnlySteps, ev);
        if (ev.type === 'done') setLlmResult(ev.result as BrowserResult);
        else if (ev.type === 'error') setLlmError(String(ev.error));
      });
      await fetchActivityStats();
    } catch (error) {
      setLlmError(String(error instanceof Error ? error.message : error));
    } finally {
      setLlmLoading(false);
    }
  };

  // Parse a Server-Sent Events stream (events separated by a blank line).
  const streamSSE = async (path: string, body: unknown, onEvent: (ev: any) => void) => {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || 'Request failed');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
          onEvent(JSON.parse(dataLine.slice(5).trim()));
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  };

  // Apply a step_start / step_end event to a live-steps state setter.
  const applyStepEvent = (setSteps: React.Dispatch<React.SetStateAction<LiveStep[]>>, ev: any) => {
    if (ev.type === 'step_start') {
      setSteps((prev) => [
        ...prev,
        { index: ev.index, total: ev.total, step: ev.step, label: ev.label, status: 'running', startedAt: Date.now(), target: ev.target, mode: ev.mode },
      ]);
    } else if (ev.type === 'step_end') {
      setSteps((prev) =>
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
    }
  };

  const runBrowserAgent = async () => {
    if (!browserQuery.trim()) return;
    setBrowserLoading(true);
    setBrowserError('');
    setBrowserResult(null);
    setLiveSteps([]);
    try {
      await streamSSE('/api/agent/browser/stream', { query: browserQuery.trim(), temperature: 0.2 }, (ev) => {
        applyStepEvent(setLiveSteps, ev);
        if (ev.type === 'done') setBrowserResult(ev.result as BrowserResult);
        else if (ev.type === 'error') setBrowserError(String(ev.error));
      });
      await fetchActivityStats();
    } catch (error) {
      setBrowserError(String(error instanceof Error ? error.message : error));
    } finally {
      setBrowserLoading(false);
    }
  };

  const runCompare = async () => {
    if (!compareQuery.trim()) return;
    setCompareLoading(true);
    setCompareError('');
    setJevSteps([]);
    setLlmSteps([]);
    setJevResult(null);
    setCmpLlmResult(null);
    setComparison(null);
    try {
      await streamSSE('/api/agent/compare/stream', { query: compareQuery.trim(), temperature: 0.2 }, (ev) => {
        const setSteps = ev.approach === 'llm' ? setLlmSteps : setJevSteps;
        applyStepEvent(setSteps, ev);
        if (ev.type === 'done') {
          if (ev.result.approach === 'llm') setCmpLlmResult(ev.result as BrowserResult);
          else setJevResult(ev.result as BrowserResult);
        } else if (ev.type === 'comparison') {
          setComparison(ev.comparison as Comparison);
        } else if (ev.type === 'error') {
          setCompareError(String(ev.error));
        }
      });
    } catch (error) {
      setCompareError(String(error instanceof Error ? error.message : error));
    } finally {
      setCompareLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">J</div>
          <div>
            <p className="brand-kicker">System One</p>
            <h1>Decision<br />Benchmark</h1>
          </div>
        </div>
        <p className="sidebar-caption">Measure the cost of letting models choose the path.</p>
        <div className="nav-label">Workspace</div>
        <nav>
          <button
            className={`nav-link ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
            aria-current={activeTab === 'dashboard' ? 'page' : undefined}
          >
            <span className="nav-icon">01</span>
            <span>Dashboard</span>
          </button>
          <button
            className={`nav-link ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
            aria-current={activeTab === 'llm' ? 'page' : undefined}
          >
            <span className="nav-icon">02</span>
            <span>LLM Only</span>
          </button>
          <button
            className={`nav-link ${activeTab === 'browser' ? 'active' : ''}`}
            onClick={() => setActiveTab('browser')}
            aria-current={activeTab === 'browser' ? 'page' : undefined}
          >
            <span className="nav-icon">03</span>
            <span>Jev + LLM <small>Browser</small></span>
          </button>
          <button
            className={`nav-link ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveTab('compare')}
            aria-current={activeTab === 'compare' ? 'page' : undefined}
          >
            <span className="nav-icon">04</span>
            <span>Compare <small>Jev vs LLM</small></span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <span className={`connection-dot ${appStatus ? 'online' : ''}`} />
          <span>{appStatus ? 'API connected' : 'Waiting for API'}</span>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Observability / {activeTab}</p>
            <h2>
              {activeTab === 'dashboard' && 'Benchmark Dashboard'}
              {activeTab === 'llm' && 'LLM Only — live browser agent'}
              {activeTab === 'browser' && 'Jev + LLM — live browser agent'}
              {activeTab === 'compare' && 'Benchmark — Jev + LLM vs LLM only'}
            </h2>
          </div>
          <div className="topbar-meta">
            <span className="data-freshness">Live workspace</span>
            <div className={`status ${statusClass}`}><span className="status-dot" />{status}</div>
          </div>
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

        <section className="activity-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your agent activity</p>
              <h3>LLM only vs Jev + LLM</h3>
            </div>
            <p className="chart-caption">Completed live agent runs, saved across refreshes</p>
          </div>
          <div className="activity-grid">
            {(['LLM only', 'Jev + LLM'] as const).map((mode) => {
              const stats = activityStats[mode];
              return (
                <div className={`activity-card ${mode === 'Jev + LLM' ? 'jev-activity' : 'llm-activity'}`} key={mode}>
                  <div className="activity-card-header">
                    <span className="activity-marker" />
                    <h3>{mode}</h3>
                    <strong>{stats.runs} runs</strong>
                  </div>
                  <div className="activity-metrics">
                    <div><span>Avg total time</span><strong>{stats.average_time_ms.toFixed(0)} ms</strong></div>
                    <div><span>Total cost</span><strong>{currency(stats.total_cost)}</strong></div>
                    <div><span>Input tokens</span><strong>{stats.total_input_tokens.toLocaleString()}</strong></div>
                    <div><span>Output tokens</span><strong>{stats.total_output_tokens.toLocaleString()}</strong></div>
                    <div><span>Avg decision time</span><strong>{stats.average_decision_latency_ms.toFixed(0)} ms</strong></div>
                  </div>
                  <p className="activity-query">{stats.last_query ? `Last: ${stats.last_query}` : 'No completed runs yet.'}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="charts-grid">
          <div className="panel chart-panel">
            <h3>Latency comparison</h3>
            <p className="chart-caption">Average and median decision time</p>
            <ResponsiveContainer width="100%" height={238}>
              <BarChart data={latencyChartData} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={chartColors.grid} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={chartAxis} />
                <YAxis axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `${value}ms`} />
                <Tooltip content={<BenchmarkTooltip />} cursor={{ fill: 'rgba(101, 216, 181, 0.06)' }} />
                <Legend />
                <Bar dataKey="jev" fill={chartColors.jev} name="Jev" radius={[5, 5, 0, 0]} maxBarSize={42} />
                <Bar dataKey="openai" fill={chartColors.openai} name="OpenAI" radius={[5, 5, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel chart-panel">
            <h3>Cost comparison</h3>
            <p className="chart-caption">Cumulative spend by request</p>
            <ResponsiveContainer width="100%" height={238}>
              <LineChart data={costChartData} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={chartColors.grid} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={chartAxis} />
                <YAxis axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `$${Number(value).toFixed(4)}`} />
                <Tooltip content={<BenchmarkTooltip />} />
                <Legend />
                <Line dataKey="jev" stroke={chartColors.jev} strokeWidth={3} dot={{ r: 3, fill: chartColors.jev, strokeWidth: 0 }} activeDot={{ r: 5 }} name="Jev" />
                <Line dataKey="openai" stroke={chartColors.openai} strokeWidth={3} dot={{ r: 3, fill: chartColors.openai, strokeWidth: 0 }} activeDot={{ r: 5 }} name="OpenAI" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="panel chart-panel">
            <h3>Accuracy comparison</h3>
            <p className="chart-caption">Graded tool-selection results</p>
            <ResponsiveContainer width="100%" height={238}>
              <BarChart data={accuracyData} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={chartColors.grid} />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={chartAxis} />
                <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `${value}%`} />
                <Tooltip content={<BenchmarkTooltip />} cursor={{ fill: 'rgba(101, 216, 181, 0.06)' }} />
                <Bar dataKey="jev" fill={chartColors.jev} name="Jev" radius={[5, 5, 0, 0]} maxBarSize={42} />
                <Bar dataKey="openai" fill={chartColors.openai} name="OpenAI" radius={[5, 5, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="panel chart-panel">
            <h3>Cost vs accuracy</h3>
            <p className="chart-caption">Each point is a benchmark request</p>
            <ResponsiveContainer width="100%" height={238}>
              <ScatterChart margin={{ top: 12, right: 8, left: -8, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={chartColors.grid} />
                <XAxis type="number" dataKey="x" name="Jev cost" axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `$${Number(value).toFixed(4)}`} />
                <YAxis type="number" dataKey="y" name="OpenAI cost" axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `$${Number(value).toFixed(4)}`} />
                <ZAxis type="number" dataKey="z" range={[60, 400]} name="Latency" />
                <Tooltip content={<BenchmarkTooltip />} cursor={{ stroke: chartColors.jev, strokeDasharray: '4 4' }} />
                <Scatter data={scatterData} fill={chartColors.jev} fillOpacity={0.78} stroke="#d7fff1" strokeWidth={1} />
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
          <p className="muted">
            Live estimate using the real pricing table ({simResult.llmModel}: LLM, Jev at $
            {appStatus?.jev_in_per_m ?? 0.042}/1M input, output free). Jev routes every request cheaply and
            only a percentage need the full LLM call.
          </p>
          <div className="simulator-grid">
            <div>
              <label>
                Requests per month
                <input
                  type="number"
                  value={sim.requestsPerMonth}
                  onChange={(e) => setSim({ ...sim, requestsPerMonth: Number(e.target.value) })}
                />
              </label>
              <label>
                Average input tokens / call
                <input
                  type="number"
                  value={sim.avgInput}
                  onChange={(e) => setSim({ ...sim, avgInput: Number(e.target.value) })}
                />
              </label>
              <label>
                Average output tokens / call
                <input
                  type="number"
                  value={sim.avgOutput}
                  onChange={(e) => setSim({ ...sim, avgOutput: Number(e.target.value) })}
                />
              </label>
              <label>
                % of requests needing the main LLM
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={sim.pctLlm}
                  onChange={(e) => setSim({ ...sim, pctLlm: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="simulator-results">
              <p>LLM-only monthly cost: <strong>{usd(simResult.llmOnly)}</strong></p>
              <p>Jev-routed monthly cost: <strong>{usd(simResult.jevRouted)}</strong></p>
              <p>Estimated saving: <strong>{usd(simResult.diff)}</strong></p>
              <p>Estimated saving: <strong>{simResult.pct.toFixed(1)}%</strong></p>
              <p className="muted">
                Per LLM call: {currency(simResult.perLlmCall)} · Per Jev decision: {currency(simResult.jevDecision)} ·
                Scenario: {sim.pctLlm}% of requests reach the main LLM.
              </p>
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
              <h3>
                LLM only{' '}
                {appStatus && (
                  <span className={`badge ${appStatus.llm === 'live' ? 'badge-live' : 'badge-sim'}`}>LLM: {appStatus.llm}</span>
                )}
              </h3>
              <p className="muted">
                The <strong>LLM decides</strong> the tool, then your code opens a <strong>real browser
                (a window pops up on screen)</strong> to search the web for your input, and the LLM
                <strong> writes an answer</strong> grounded in the page. Time, tokens and cost are logged per step.
              </p>
              <textarea
                value={llmQuery}
                onChange={(e) => setLlmQuery(e.target.value)}
                placeholder="Ask something, e.g. What is the latest news about Android 16?"
              />
              <div className="button-row">
                <button onClick={runLlmOnly} disabled={llmLoading}>
                  {llmLoading ? 'Opening browser…' : 'Run LLM'}
                </button>
              </div>
              {llmError && <p className="error-text">{llmError}</p>}
            </div>

            {llmOnlySteps.length > 0 && (
              <div className="panel">
                <h3>
                  Live workflow{' '}
                  <span className="muted">
                    {llmOnlySteps.filter((s) => s.status === 'done').length}/{llmOnlySteps[0]?.total ?? 3} steps
                  </span>
                </h3>
                <div className="wf-progress">
                  <div
                    className="wf-progress-fill"
                    style={{ width: `${(llmOnlySteps.filter((s) => s.status === 'done').length / (llmOnlySteps[0]?.total ?? 3)) * 100}%` }}
                  />
                </div>
                <WorkflowSteps steps={llmOnlySteps} nowTick={nowTick} />
              </div>
            )}

            {llmResult && (
              <>
                <section className="kpis">
                  <div className="card">
                    <span>Selected tool</span>
                    <strong>{llmResult.selected_tool}</strong>
                  </div>
                  <div className="card">
                    <span>Total time</span>
                    <strong>{`${Number(llmResult.total_time_ms).toFixed(0)} ms`}</strong>
                  </div>
                  <div className="card">
                    <span>Total cost</span>
                    <strong>{currency(llmResult.total_cost)}</strong>
                  </div>
                  <div className="card">
                    <span>Browser time</span>
                    <strong>{`${Number(llmResult.browser.browser_time_ms).toFixed(0)} ms`}</strong>
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
                  <h3>LLM answer (grounded in the page)</h3>
                  <p>{llmResult.answer}</p>
                </div>
                <div className="panel">
                  <h3>Browser result</h3>
                  <p className="muted">
                    Engine: {llmResult.browser.engine}
                    {llmResult.browser.fallback &&
                      ' (visible browser unavailable — fell back to HTTP fetch. Run the backend on your desktop with Chromium installed.)'}
                  </p>
                  <p>
                    <strong>{llmResult.browser.title || '(no title)'}</strong>
                  </p>
                  <p className="muted">{llmResult.browser.final_url}</p>
                  <pre>{llmResult.browser.snippet || '(no text captured)'}</pre>
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
                the control flow</strong> and opens a <strong>real browser (a window pops up on screen)</strong>.
                <strong> The LLM writes the words</strong> — a short answer grounded in the page. Time and cost
                are logged per step below.
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

        {activeTab === 'compare' && (
          <section className="agent-view">
            <div className="panel">
              <h3>
                Benchmark: Jev + LLM vs LLM only{' '}
                {appStatus && (
                  <span className={`badge ${appStatus.jev === 'live' ? 'badge-live' : 'badge-sim'}`}>Jev: {appStatus.jev}</span>
                )}
                {appStatus && (
                  <span className={`badge ${appStatus.llm === 'live' ? 'badge-live' : 'badge-sim'}`}>LLM: {appStatus.llm}</span>
                )}
              </h3>
              <p className="muted">
                Both pipelines run the <strong>same task</strong> with the <strong>same web search</strong> and the
                <strong> same answer step</strong> — only the <strong>decision layer</strong> differs (Jev System One
                vs the LLM classifying the tool). So every difference in the stats below is attributable to that layer.
              </p>
              <textarea
                value={compareQuery}
                onChange={(e) => setCompareQuery(e.target.value)}
                placeholder="Enter a task to research on the web…"
              />
              <div className="button-row">
                <button onClick={runCompare} disabled={compareLoading}>
                  {compareLoading ? 'Running both…' : 'Run benchmark'}
                </button>
              </div>
              {compareError && <p className="error-text">{compareError}</p>}
            </div>

            {(jevSteps.length > 0 || llmSteps.length > 0) && (
              <div className="compare-grid">
                <div className="panel">
                  <h3>
                    Jev + LLM{' '}
                    <span className="muted">
                      {jevSteps.filter((s) => s.status === 'done').length}/{jevSteps[0]?.total ?? 3}
                    </span>
                  </h3>
                  <div className="wf-progress">
                    <div
                      className="wf-progress-fill"
                      style={{ width: `${(jevSteps.filter((s) => s.status === 'done').length / (jevSteps[0]?.total ?? 3)) * 100}%` }}
                    />
                  </div>
                  <WorkflowSteps steps={jevSteps} nowTick={nowTick} />
                </div>
                <div className="panel">
                  <h3>
                    LLM only{' '}
                    <span className="muted">
                      {llmSteps.filter((s) => s.status === 'done').length}/{llmSteps[0]?.total ?? 3}
                    </span>
                  </h3>
                  <div className="wf-progress">
                    <div
                      className="wf-progress-fill wf-fill-amber"
                      style={{ width: `${(llmSteps.filter((s) => s.status === 'done').length / (llmSteps[0]?.total ?? 3)) * 100}%` }}
                    />
                  </div>
                  <WorkflowSteps steps={llmSteps} nowTick={nowTick} />
                </div>
              </div>
            )}

            {comparison && (
              <>
                <div className="panel">
                  <h3>Verdict</h3>
                  <p>
                    Tool choice:{' '}
                    <strong>{comparison.same_tool ? 'agreed' : 'differed'}</strong> (Jev: {comparison.jev_tool}, LLM:{' '}
                    {comparison.llm_tool}). Jev's decision was{' '}
                    <strong>{comparison.decision_latency_savings_pct.toFixed(0)}% faster</strong> and{' '}
                    <strong>{comparison.decision_cost_savings_pct.toFixed(0)}% cheaper</strong>. End-to-end, Jev + LLM cost{' '}
                    <strong>{comparison.total_cost_savings_pct.toFixed(0)}% less</strong> and finished{' '}
                    <strong>{comparison.total_time_savings_pct.toFixed(0)}% faster</strong>.
                  </p>
                </div>

                <div className="panel">
                  <h3>Stats</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>Jev + LLM</th>
                          <th>LLM only</th>
                          <th>Jev advantage</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>Decision latency</td>
                          <td>{comparison.decision_latency_ms.jev.toFixed(0)} ms</td>
                          <td>{comparison.decision_latency_ms.llm.toFixed(0)} ms</td>
                          <td>{comparison.decision_latency_savings_pct.toFixed(0)}% faster</td>
                        </tr>
                        <tr>
                          <td>Decision cost</td>
                          <td>{currency(comparison.decision_cost.jev)}</td>
                          <td>{currency(comparison.decision_cost.llm)}</td>
                          <td>{comparison.decision_cost_savings_pct.toFixed(0)}% cheaper</td>
                        </tr>
                        <tr>
                          <td>Decision tokens</td>
                          <td>{comparison.decision_tokens.jev}</td>
                          <td>{comparison.decision_tokens.llm}</td>
                          <td>—</td>
                        </tr>
                        <tr>
                          <td>Total time</td>
                          <td>{comparison.total_time_ms.jev.toFixed(0)} ms</td>
                          <td>{comparison.total_time_ms.llm.toFixed(0)} ms</td>
                          <td>{comparison.total_time_savings_pct.toFixed(0)}% faster</td>
                        </tr>
                        <tr>
                          <td>Total cost</td>
                          <td>{currency(comparison.total_cost.jev)}</td>
                          <td>{currency(comparison.total_cost.llm)}</td>
                          <td>{comparison.total_cost_savings_pct.toFixed(0)}% cheaper</td>
                        </tr>
                        <tr>
                          <td>Total tokens</td>
                          <td>{comparison.total_tokens.jev}</td>
                          <td>{comparison.total_tokens.llm}</td>
                          <td>—</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="charts-grid">
                  <div className="panel chart-panel">
                    <h3>Decision latency (ms)</h3>
                    <p className="chart-caption">Time spent choosing the tool</p>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={[{ name: 'Decision', jev: comparison.decision_latency_ms.jev, llm: comparison.decision_latency_ms.llm }]} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
                        <CartesianGrid vertical={false} stroke={chartColors.grid} />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={chartAxis} />
                        <YAxis axisLine={false} tickLine={false} tick={chartAxis} tickFormatter={(value) => `${value}ms`} />
                        <Tooltip content={<BenchmarkTooltip />} cursor={{ fill: 'rgba(101, 216, 181, 0.06)' }} />
                        <Legend />
                        <Bar dataKey="jev" fill={chartColors.jev} name="Jev+LLM" radius={[5, 5, 0, 0]} maxBarSize={42} />
                        <Bar dataKey="llm" fill={chartColors.openai} name="LLM only" radius={[5, 5, 0, 0]} maxBarSize={42} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="panel chart-panel">
                    <h3>Decision cost (USD)</h3>
                    <p className="chart-caption">Cost of selecting the tool</p>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={[{ name: 'Decision', jev: comparison.decision_cost.jev, llm: comparison.decision_cost.llm }]} margin={{ top: 12, right: 8, left: -8, bottom: 4 }}>
                        <CartesianGrid vertical={false} stroke={chartColors.grid} />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={chartAxis} />
                        <YAxis tickFormatter={(v) => `$${Number(v).toExponential(1)}`} width={74} axisLine={false} tickLine={false} tick={chartAxis} />
                        <Tooltip content={<BenchmarkTooltip />} cursor={{ fill: 'rgba(101, 216, 181, 0.06)' }} />
                        <Legend />
                        <Bar dataKey="jev" fill={chartColors.jev} name="Jev+LLM" radius={[5, 5, 0, 0]} maxBarSize={42} />
                        <Bar dataKey="llm" fill={chartColors.openai} name="LLM only" radius={[5, 5, 0, 0]} maxBarSize={42} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="compare-grid">
                  <div className="panel">
                    <h3>Jev + LLM answer</h3>
                    <p>{jevResult?.answer}</p>
                  </div>
                  <div className="panel">
                    <h3>LLM only answer</h3>
                    <p>{cmpLlmResult?.answer}</p>
                  </div>
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
