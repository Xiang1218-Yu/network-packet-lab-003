import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  PacketScenario,
  ParseRequest,
  ParseTrace,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
const REPLAY_INTERVAL_MS = 1600;

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [trace, setTrace] = useState<ParseTrace | null>(null);
  const [traceIndex, setTraceIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const exitReplay = () => {
    setTrace(null);
    setPlaying(false);
    setTraceIndex(0);
  };

  const request = async <T,>(path: string, init?: RequestInit): Promise<{ data: T }> => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json() as Promise<{ data: T }>;
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    exitReplay();
    setLoading(true);
    setError('');
    try {
      const result = await request<SimulatedPacket>(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    exitReplay();
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request<SimulatedPacket>('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  const startReplay = async () => {
    exitReplay();
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request<ParseTrace>('/api/parse/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      setTrace(result.data);
      setTraceIndex(0);
      setPlaying(true);
    } catch (cause) {
      setTrace(null);
      setError(cause instanceof Error ? cause.message : '生成解析轨迹失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
  }, []);

  // 输入被清空时立即丢弃回放快照，避免残留上一包内容
  useEffect(() => {
    if (!rawInput.trim()) exitReplay();
  }, [rawInput]);

  // 播放驱动：逐阶段推进，到达末阶段自动暂停
  const activeStage = trace ? trace.stages[traceIndex] : null;
  useEffect(() => {
    if (!playing || !trace) return;
    if (traceIndex >= trace.stages.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setTraceIndex((index) => Math.min(index + 1, trace.stages.length - 1));
    }, REPLAY_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [playing, trace, traceIndex]);

  const displayPacket = useMemo<SimulatedPacket | null>(() => {
    if (trace && activeStage) {
      return {
        ...trace.packet,
        summary: activeStage.snapshot.summary,
        fields: activeStage.snapshot.fields,
        hex: activeStage.snapshot.hex,
        timeline: activeStage.snapshot.timeline,
        metadata: activeStage.snapshot.metadata
      };
    }
    return packet;
  }, [trace, activeStage, packet]);

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  const togglePlay = () => {
    if (!trace) return;
    if (!playing && traceIndex >= trace.stages.length - 1) setTraceIndex(0);
    setPlaying((value) => !value);
  };

  const stepOnce = () => {
    if (!trace) return;
    setPlaying(false);
    setTraceIndex((index) => Math.min(index + 1, trace.stages.length - 1));
  };

  const backToStart = () => {
    setPlaying(false);
    setTraceIndex(0);
  };

  const scrubTo = (index: number) => {
    if (!trace) return;
    setPlaying(false);
    setTraceIndex(Math.max(0, Math.min(index, trace.stages.length - 1)));
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据。</p>
          </div>
          <div className="hero-stat"><strong>{displayPacket?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
        </section>

        <section className="control-panel panel">
          <div className="control-group">
            <label>协议 <span>PROTOCOL</span></label>
            <div className="segmented-control">
              {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
              ))}
            </div>
          </div>
          <div className="control-group scenario-control">
            <label>模拟场景 <span>SCENARIO</span></label>
            <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
              {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
            </select>
          </div>
          <div className="control-actions">
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
            <button className="button ghost" onClick={() => void startReplay()} disabled={loading || !rawInput.trim()}>▶ 逐步回放</button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

        {trace && activeStage && (
          <section className="panel replay-panel">
            <div className="replay-head">
              <div>
                <p className="section-kicker">REPLAY · 逐步回放</p>
                <h3>{activeStage.label}</h3>
              </div>
              <div className="replay-buttons">
                <button className="button ghost" onClick={backToStart} disabled={traceIndex === 0}>⟲ 起点</button>
                <button className="button primary" onClick={togglePlay}>{playing ? '⏸ 暂停' : '▶ 播放'}</button>
                <button className="button ghost" onClick={stepOnce} disabled={traceIndex >= trace.stages.length - 1}>单步 →</button>
                <button className="button ghost" onClick={exitReplay}>退出回放</button>
              </div>
            </div>
            <div className="replay-progress-row">
              <input
                className="replay-slider"
                type="range"
                min={0}
                max={trace.stages.length - 1}
                step={1}
                value={traceIndex}
                onChange={(event) => scrubTo(Number(event.target.value))}
                aria-label="回放进度"
              />
              <span className="replay-progress">{String(traceIndex + 1).padStart(2, '0')} / {String(trace.stages.length).padStart(2, '0')}</span>
            </div>
            <div className="replay-stages">
              {trace.stages.map((stage, index) => (
                <button
                  key={stage.id}
                  className={`replay-stage ${index === traceIndex ? 'active' : ''} ${index < traceIndex ? 'done' : ''}`}
                  onClick={() => scrubTo(index)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {stage.label}
                </button>
              ))}
            </div>
            <p className="replay-caption">{activeStage.caption}</p>
          </section>
        )}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{displayPacket?.id ?? 'WAITING'}</span></div>
              <Timeline events={displayPacket?.timeline ?? []} activeId={trace && activeStage ? activeStage.snapshot.activeEventId : null} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{displayPacket?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> {trace ? 'REPLAYING' : 'DECODED'}</div></div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={displayPacket?.metadata.source ?? '—'} />
                <Meta label="DESTINATION" value={displayPacket?.metadata.destination ?? '—'} />
                <Meta label="CAPTURED AT" value={displayPacket?.metadata.capturedAt ?? '—'} />
                <Meta label="CHECKSUM" value={displayPacket?.metadata.checksum ?? '—'} />
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs"><button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button><button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button></div>
              {activeView === 'overview' ? <FieldTree fields={displayPacket?.fields ?? []} /> : <HexView rows={displayPacket?.hex ?? []} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function FieldTree({ fields }: { fields: ProtocolField[] }) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} />)}</div>;
}

function FieldNode({ field, depth }: { field: ProtocolField; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} />)}</div>}
  </div>;
}

function Timeline({ events, activeId }: { events: TimelineEvent[]; activeId?: string | null }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className={`timeline-event ${event.id === activeId ? 'active' : ''}`} key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className={`hex-row ${row.highlight ? 'highlight' : ''}`} key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
