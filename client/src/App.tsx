import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  ReplayTrajectory,
  SimulatedPacket,
  StageSnapshot,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
const PLAYBACK_INTERVAL_MS = 1600;

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

interface ViewState {
  summary: string;
  fields: ProtocolField[];
  hex: SimulatedPacket['hex'];
  revealedBytes: number | null;
  timeline: TimelineEvent[];
  metadata: SimulatedPacket['metadata'] | undefined;
  traceId: string;
  stage: StageSnapshot | null;
}

function App() {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  const [replay, setReplay] = useState<ReplayTrajectory | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const playTimer = useRef<number | null>(null);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${API_BASE}${path}`, init);
    if (!response.ok) throw new Error(`API 请求失败：${response.status}`);
    return response.json();
  };

  /* -------------------------------------------------------------- */
  /* Normal parsing flows (always exit replay first)                */
  /* -------------------------------------------------------------- */

  const exitReplay = () => {
    setPlaying(false);
    setReplay(null);
    setStageIndex(0);
  };

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    exitReplay();
    setPacket(null);
    try {
      const result = await request(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      ) as { data: SimulatedPacket };
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    setLoading(true);
    setError('');
    exitReplay();
    setPacket(null);
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await request('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }) as { data: SimulatedPacket };
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  /* -------------------------------------------------------------- */
  /* Replay flow: clear stale snapshots before fetching a trace     */
  /* -------------------------------------------------------------- */

  const startReplay = async () => {
    setError('');
    setReplayLoading(true);
    // Discard the previous packet / trajectory immediately so a failed
    // request or an empty input can never leave an old packet on screen.
    setPlaying(false);
    setReplay(null);
    setPacket(null);
    setStageIndex(0);
    try {
      const result = await request('/api/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol, scenario, raw: rawInput } satisfies ParseRequest)
      }) as { data: ReplayTrajectory };
      setReplay(result.data);
      setStageIndex(0);
      setPlaying(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成解析轨迹失败');
    } finally {
      setReplayLoading(false);
    }
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
  }, []);

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

  /* -------------------------------------------------------------- */
  /* Playback transport                                              */
  /* -------------------------------------------------------------- */

  const stageCount = replay?.stages.length ?? 0;
  const atEnd = replay !== null && stageIndex >= stageCount - 1;

  useEffect(() => {
    if (!playing || !replay || atEnd) return;
    playTimer.current = window.setInterval(() => {
      setStageIndex((current) => {
        if (current >= replay.stages.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, PLAYBACK_INTERVAL_MS);
    return () => {
      if (playTimer.current !== null) window.clearInterval(playTimer.current);
    };
  }, [playing, replay, atEnd]);

  const togglePlay = () => {
    if (!replay) return;
    if (atEnd) {
      setStageIndex(0);
      setPlaying(true);
    } else {
      setPlaying((value) => !value);
    }
  };

  const stepForward = () => {
    if (!replay) return;
    setPlaying(false);
    setStageIndex((current) => Math.min(replay.stages.length - 1, current + 1));
  };

  const stepBackward = () => {
    if (!replay) return;
    setPlaying(false);
    setStageIndex((current) => Math.max(0, current - 1));
  };

  const restart = () => {
    setPlaying(false);
    setStageIndex(0);
  };

  const seek = (index: number) => {
    if (!replay) return;
    setPlaying(false);
    setStageIndex(Math.max(0, Math.min(replay.stages.length - 1, index)));
  };

  /* -------------------------------------------------------------- */
  /* Derive the visible views from the current replay stage         */
  /* -------------------------------------------------------------- */

  const view: ViewState = replay
    ? (() => {
        const stage = replay.stages[stageIndex];
        return {
          summary: stage.summary,
          fields: stage.fields,
          hex: stage.hex,
          revealedBytes: stage.revealedBytes,
          timeline: stage.timeline,
          metadata: stage.metadata,
          traceId: replay.id,
          stage
        };
      })()
    : {
        summary: packet?.summary ?? '',
        fields: packet?.fields ?? [],
        hex: packet?.hex ?? [],
        revealedBytes: null,
        timeline: packet?.timeline ?? [],
        metadata: packet?.metadata,
        traceId: packet?.id ?? 'WAITING',
        stage: null
      };

  const displayedLength = view.stage ? (view.metadata?.length || 0) : (packet?.metadata.length ?? '—');

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
            <p className="hero-subtitle">选择协议和场景，载入模拟流量；或开启逐步回放，在课堂上逐阶段展示解析过程。</p>
          </div>
          <div className="hero-stat"><strong>{displayedLength}</strong><span>BYTES<br />CURRENT FRAME</span></div>
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
            <button className="button ghost" onClick={() => void loadSample()} disabled={loading || replayLoading}>↻ 载入模拟包</button>
            <button className="button replay" onClick={() => void startReplay()} disabled={loading || replayLoading || !rawInput.trim()}>
              {replayLoading ? '生成轨迹中…' : '▶ 逐步回放'}
            </button>
            <button className="button primary" onClick={() => void parsePacket()} disabled={loading || replayLoading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          </div>
        </section>

        {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}
        {replayLoading && <div className="notice-banner">⏳ 正在生成带阶段快照的解析轨迹，已清空上一包的画面…</div>}

        {replay && (
          <ReplayPlayer
            trajectory={replay}
            stageIndex={stageIndex}
            playing={playing}
            onTogglePlay={togglePlay}
            onStepForward={stepForward}
            onStepBackward={stepBackward}
            onRestart={restart}
            onSeek={seek}
            onExit={exitReplay}
          />
        )}

        <section className="workspace-grid">
          <div className="left-column">
            <div className="panel packet-input-panel">
              <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
              <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
              <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
            </div>
            <div className="panel timeline-panel">
              <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{view.traceId}</span></div>
              <Timeline events={view.timeline} latestCount={replay ? 1 : 0} stageKey={view.stage?.stage ?? 'normal'} />
            </div>
          </div>

          <div className="right-column">
            <div className="panel packet-summary">
              <div className="summary-top">
                <div>
                  <p className="section-kicker">{replay ? `REPLAY STAGE ${String(stageIndex + 1).padStart(2, '0')} / ${String(stageCount).padStart(2, '0')}` : 'ACTIVE FRAME'}</p>
                  <h3>{replay || packet ? view.summary : '等待数据包'}</h3>
                </div>
                <div className={`live-chip ${replay ? 'replaying' : ''}`}><i /> {replay ? (atEnd ? 'COMPLETE' : 'REPLAYING') : 'DECODED'}</div>
              </div>
              <div className="metadata-grid">
                <Meta label="SOURCE" value={view.metadata?.source ?? '—'} pending={view.stage !== null && view.metadata?.source === '—'} />
                <Meta label="DESTINATION" value={view.metadata?.destination ?? '—'} pending={view.stage !== null && view.metadata?.destination === '—'} />
                <Meta label="CAPTURED AT" value={view.metadata?.capturedAt ?? '—'} pending={view.stage !== null && view.metadata?.capturedAt === '— pending —'} />
                <Meta label="CHECKSUM" value={view.metadata?.checksum ?? '—'} pending={view.stage !== null && view.metadata?.checksum === '0x----'} />
              </div>
            </div>

            <div className="panel details-panel">
              <div className="tabs">
                <button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button>
                <button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button>
                {view.stage && <span className="stage-hint">{view.stage.title}</span>}
              </div>
              {activeView === 'overview'
                ? <FieldTree key={view.stage?.stage ?? 'normal'} fields={view.fields} stageEmpty={view.stage !== null && view.fields.length === 0} />
                : <HexView rows={view.hex} revealedBytes={view.revealedBytes} />}
            </div>
          </div>
        </section>
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API</span></footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Replay player                                                       */
/* ------------------------------------------------------------------ */

interface ReplayPlayerProps {
  trajectory: ReplayTrajectory;
  stageIndex: number;
  playing: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onRestart: () => void;
  onSeek: (index: number) => void;
  onExit: () => void;
}

function ReplayPlayer({
  trajectory,
  stageIndex,
  playing,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onRestart,
  onSeek,
  onExit
}: ReplayPlayerProps) {
  const stage = trajectory.stages[stageIndex];
  const last = trajectory.stages.length - 1;
  const atStart = stageIndex === 0;
  const atEnd = stageIndex === last;

  return (
    <section className="panel replay-panel">
      <div className="replay-heading">
        <div>
          <p className="section-kicker">STEP-BY-STEP REPLAY · 课堂演示模式</p>
          <h3>{stage.title}</h3>
        </div>
        <div className="replay-heading-actions">
          <span className="replay-counter">{stageIndex + 1} / {trajectory.stages.length}</span>
          <button className="button ghost replay-exit" onClick={onExit}>✕ 退出回放，回到普通解析结果</button>
        </div>
      </div>

      <p className="replay-narration">{stage.narration}</p>

      <div className="replay-controls">
        <button className="player-btn" onClick={onRestart} disabled={atStart && !playing} title="回到起点">⏮</button>
        <button className="player-btn" onClick={onStepBackward} disabled={atStart} title="上一步">◀</button>
        <button className="player-btn primary" onClick={onTogglePlay} title={playing ? '暂停' : '播放'}>
          {playing ? '⏸ 暂停' : atEnd ? '↻ 重新播放' : '▶ 播放'}
        </button>
        <button className="player-btn" onClick={onStepForward} disabled={atEnd} title="单步前进">▶</button>
        <input
          className="replay-scrubber"
          type="range"
          min={0}
          max={last}
          step={1}
          value={stageIndex}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="回放进度"
        />
      </div>

      <div className="replay-ticks">
        {trajectory.stages.map((item, index) => (
          <button
            key={item.stage}
            className={`replay-tick ${index === stageIndex ? 'current' : ''} ${index < stageIndex ? 'passed' : ''}`}
            onClick={() => onSeek(index)}
            title={item.title}
          >
            <span className="tick-dot" />
            <span className="tick-label">{item.title.split(' · ')[0]}</span>
          </button>
        ))}
      </div>

      {atEnd && !playing && (
        <div className="replay-finished">
          回放结束：最终阶段与普通解析结果完全一致。你可以拖动进度回顾，或
          <button onClick={onExit}>退出回放，回到普通解析结果</button>。
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

function Meta({ label, value, pending }: { label: string; value: string; pending?: boolean }) {
  return <div className="meta-item"><span>{label}</span><strong className={pending ? 'meta-pending' : ''}>{value}</strong></div>;
}

function FieldTree({ fields, stageEmpty }: { fields: ProtocolField[]; stageEmpty?: boolean }) {
  if (stageEmpty) return <div className="empty-state">抓取阶段：原始字节已经到达，但解析尚未开始。点击 ▶ 播放或单步前进。</div>;
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree stage-enter">{fields.map((item) => <FieldNode key={item.id} field={item} depth={0} />)}</div>;
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

function Timeline({ events, latestCount, stageKey }: { events: TimelineEvent[]; latestCount?: number; stageKey: string }) {
  if (!events.length) {
    return <div className="empty-state" key={stageKey}>
      {stageKey === 'capture' ? '抓取阶段：帧已进入缓冲区，还没有解析事件。' : '还没有事件记录。'}
    </div>;
  }
  const activeFrom = events.length - (latestCount ?? 0);
  return (
    <div className="timeline" key={stageKey}>
      {events.map((event, index) => {
        const state = index < activeFrom ? 'done' : index < events.length ? 'active' : 'pending';
        return (
          <div className={`timeline-event ${state}`} key={event.id}>
            <div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div>
            <div className="timeline-content">
              <div><strong>{event.label}</strong><time>{event.timestamp}</time></div>
              <p>{event.detail}</p>
              <span className={`phase phase-${event.phase}`}>{event.phase}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HexView({ rows, revealedBytes }: { rows: SimulatedPacket['hex']; revealedBytes: number | null }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  const totalBytes = countBytes(rows);
  const dimming = revealedBytes !== null && revealedBytes < totalBytes;
  let globalIndex = 0;
  return (
    <div className="hex-wrap">
      {dimming && (
        <div className="hex-legend"><span className="legend-decoded">■ 已解码</span><span className="legend-pending">■ 尚未解析</span></div>
      )}
      <div className="hex-view">
        <div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>
        {rows.map((row) => {
          const rowStart = globalIndex;
          globalIndex += row.bytes.length;
          return (
            <div className="hex-row" key={row.offset}>
              <code>{row.offset}</code>
              <div className="hex-cells">
                {row.bytes.map((byte, index) => (
                  <code key={index} className={rowStart + index < (revealedBytes ?? totalBytes) ? '' : 'pending'}>{byte}</code>
                ))}
              </div>
              <div className="hex-ascii">
                {row.ascii.split('').map((char, index) => (
                  <code key={index} className={`ascii ${rowStart + index < (revealedBytes ?? totalBytes) ? '' : 'pending'}`}>{char}</code>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function countBytes(rows: SimulatedPacket['hex']): number {
  return rows.reduce((total, row) => total + row.bytes.length, 0);
}

export default App;
