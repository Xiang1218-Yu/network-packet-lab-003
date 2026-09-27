import type {
  HexRow,
  PacketScenario,
  Protocol,
  ProtocolField,
  ReplayStageId,
  ReplayTrajectory,
  SimulatedPacket,
  StageSnapshot,
  TimelineEvent
} from '../shared/types.js';

const HTTP_SAMPLES: Record<PacketScenario, string> = {
  request: 'GET /api/devices?status=online HTTP/1.1\r\nHost: lab.local\r\nAccept: application/json\r\nUser-Agent: PacketLab/1.0\r\nX-Trace-Id: 7f3a9c\r\n\r\n',
  response: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}',
  handshake: 'GET / HTTP/1.1\r\nHost: lab.local\r\nConnection: keep-alive\r\n\r\n'
};

const TCP_SAMPLES: Record<PacketScenario, string> = {
  request: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=18492031 Ack=77120102 | Flags=ACK,PSH | Win=64240 | Len=128',
  response: 'TCP 10.0.0.8:443 > 10.0.0.24:51842 | Seq=77120102 Ack=18492159 | Flags=ACK,PSH | Win=28960 | Len=512',
  handshake: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7'
};

export function sampleFor(protocol: Protocol, scenario: PacketScenario): string {
  return protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario];
}

export function hexDump(value: string): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    });
  }
  return rows;
}

export function field(
  id: string,
  key: string,
  value: string,
  description: string,
  children?: ProtocolField[]
): ProtocolField {
  return { id, key, value, description, ...(children ? { children } : {}) };
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

export function buildTimeline(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps: Array<[TimelineEvent['phase'], string, string]> = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Start line identified', 'Request target / response status located'],
        ['transport', 'Headers indexed', 'Header fields split out and decoded'],
        ['application', 'Payload formed', scenario === 'response' ? 'Response body is ready for inspection' : 'Body segment attached to the message'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['parse', 'Route identified', 'Source and destination endpoints parsed'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['application', 'Payload formed', 'Segment data attached as the transport payload'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase,
    detail
  }));
}

/* ------------------------------------------------------------------ */
/* HTTP parsing                                                        */
/* ------------------------------------------------------------------ */

interface HttpSplit {
  raw: string;
  startLine: string;
  headerLines: string[];
  body: string;
  headBytes: number;
  bodyBytes: number;
  isResponse: boolean;
  parts: [string | undefined, string | undefined, string | undefined];
}

function splitHttp(raw: string): HttpSplit {
  const separatorMatch = raw.match(/\r?\n\r?\n/);
  const separatorLength = separatorMatch ? separatorMatch[0].length : 0;
  const headEnd = separatorMatch ? separatorMatch.index! : raw.length;
  const head = raw.slice(0, headEnd);
  const body = separatorMatch ? raw.slice(headEnd + separatorLength) : '';
  const lines = head.split(/\r?\n/);
  const startLine = lines[0] ?? '';
  const headerLines = lines.slice(1).filter((line) => line.trim().length > 0);
  const startParts = startLine.split(' ');
  return {
    raw,
    startLine,
    headerLines,
    body,
    headBytes: Buffer.byteLength(head, 'utf8'),
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    isResponse: startLine.startsWith('HTTP/'),
    parts: [startParts[0], startParts[1], startParts[2]]
  };
}

function httpStartLineNode(split: HttpSplit): ProtocolField {
  const { isResponse, parts } = split;
  const [first, second, third] = parts;
  return field(
    'http-start-line',
    isResponse ? 'Status-Line' : 'Request-Line',
    split.startLine || '(empty)',
    isResponse ? 'HTTP version and response status' : 'HTTP method, target and version',
    [
      field('http-part-1', isResponse ? 'Version' : 'Method', first ?? '—', isResponse ? 'Protocol version' : 'HTTP request method'),
      field('http-part-2', isResponse ? 'Status' : 'Target', second ?? '—', isResponse ? 'Status code' : 'Request target'),
      field('http-part-3', isResponse ? 'Reason' : 'Version', third ?? '—', isResponse ? 'Reason phrase' : 'Protocol version')
    ]
  );
}

function httpHeadersNode(split: HttpSplit): ProtocolField {
  const headers = split.headerLines.map((line, index) => {
    const separator = line.indexOf(':');
    const key = separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`;
    const value = separator > -1 ? line.slice(separator + 1).trim() : line.trim();
    return field(`header-${index}`, key, value || '(empty)', 'HTTP header field');
  });
  return field('http-headers', 'Headers', `${headers.length} fields`, 'Metadata carried by the application layer', headers);
}

export function parseHttpFields(raw: string): ProtocolField[] {
  const split = splitHttp(raw);
  return [
    httpStartLineNode(split),
    httpHeadersNode(split),
    field('http-body', 'Payload', split.body || '(empty)', 'Application payload after the header terminator')
  ];
}

/* ------------------------------------------------------------------ */
/* TCP parsing                                                         */
/* ------------------------------------------------------------------ */

interface TcpSplit {
  raw: string;
  source: string;
  destination: string;
  values: Map<string, string>;
  routeBytes: number;
  headerBytes: number;
  len: number | null;
}

function splitTcp(raw: string): TcpSplit {
  const [route = '', ...parts] = raw.split(' | ');
  const [, source = '—', , destination = '—'] = route.split(' ');
  const values = new Map(
    parts.map((part) => {
      const separator = part.indexOf('=');
      return separator > -1 ? [part.slice(0, separator), part.slice(separator + 1)] as const : [part, 'true'] as const;
    })
  );
  const lenToken = raw.match(/Len=(\d+)/);
  const len = lenToken ? Number(lenToken[1]) : null;
  const routeBytes = Buffer.byteLength(route, 'utf8');
  const headerSection = lenToken && lenToken.index !== undefined ? raw.slice(0, lenToken.index).replace(/\s*\|\s*$/, '') : raw;
  return {
    raw,
    source,
    destination,
    values,
    routeBytes,
    headerBytes: Buffer.byteLength(headerSection, 'utf8'),
    len
  };
}

function ethernetNode(): ProtocolField {
  return field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', [
    field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address'),
    field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address'),
    field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier')
  ]);
}

function ipv4Node(source: string, destination: string): ProtocolField {
  return field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', [
    field('ipv4-source', 'Source', source, 'Origin IP and port'),
    field('ipv4-destination', 'Destination', destination, 'Target IP and port'),
    field('ipv4-protocol', 'Next Protocol', 'TCP', 'Transport protocol')
  ]);
}

function tcpHeaderNode(values: Map<string, string>, lengthValue: string): ProtocolField {
  return field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', [
    field('tcp-seq', 'Sequence', values.get('Seq') ?? '—', 'Byte sequence position'),
    field('tcp-ack', 'Acknowledgement', values.get('Ack') ?? '—', 'Next expected byte'),
    field('tcp-flags', 'Flags', values.get('Flags') ?? '—', 'Control bits'),
    field('tcp-window', 'Window', values.get('Win') ?? '—', 'Receive window size'),
    field('tcp-length', 'Payload Length', lengthValue, 'TCP segment data length')
  ]);
}

export function parseTcpFields(raw: string): ProtocolField[] {
  const split = splitTcp(raw);
  return [
    ethernetNode(),
    ipv4Node(split.source, split.destination),
    tcpHeaderNode(split.values, split.len === null ? '0' : String(split.len)),
    field('tcp-payload', 'Payload', split.len === 0 ? '(empty)' : 'Encrypted application data', 'Data carried by the segment')
  ];
}

/* ------------------------------------------------------------------ */
/* Packet assembly                                                     */
/* ------------------------------------------------------------------ */

function metadataFor(protocol: Protocol, raw: string, source: string, destination: string): SimulatedPacket['metadata'] {
  const isHttp = protocol === 'HTTP';
  return {
    capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
    source: isHttp ? '10.0.0.24:51842' : source,
    destination: isHttp ? '10.0.0.8:443' : destination,
    length: Buffer.byteLength(raw, 'utf8'),
    checksum: checksum(raw)
  };
}

function summaryFor(protocol: Protocol, scenario: PacketScenario, raw: string): string {
  return protocol === 'HTTP'
    ? `${raw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
    : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${raw.split(' | ')[0]}`;
}

export function buildPacket(protocol: Protocol, scenario: PacketScenario, rawInput: string): SimulatedPacket {
  const raw = rawInput.trim() ? rawInput : sampleFor(protocol, scenario);
  const isHttp = protocol === 'HTTP';
  const split = isHttp ? splitHttp(raw) : splitTcp(raw);
  return {
    id: `${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: summaryFor(protocol, scenario, raw),
    raw,
    hex: hexDump(raw),
    fields: isHttp ? parseHttpFields(raw) : parseTcpFields(raw),
    timeline: buildTimeline(protocol, scenario),
    metadata: metadataFor(protocol, raw, 'source' in split ? split.source : '—', 'destination' in split ? split.destination : '—')
  };
}

/* ------------------------------------------------------------------ */
/* Step-by-step replay trajectory                                      */
/* ------------------------------------------------------------------ */

const STAGE_TITLES: Record<ReplayStageId, string> = {
  capture: '① 抓取 · Capture',
  identify: '② 起始行 / 路由识别 · Identify',
  decode: '③ Header / TCP 层解码 · Decode',
  payload: '④ Payload 形成 · Payload',
  complete: '⑤ 最终输出 · Inspector Ready'
};

const STAGE_NARRATION: Record<Protocol, Record<ReplayStageId, string>> = {
  HTTP: {
    capture: '网卡收到一个应用层帧，原始字节进入缓冲区。此时还没有任何结构化信息——十六进制区是唯一可信的事实来源。',
    identify: '按 CRLF 切出第一条起始行：识别 HTTP 版本，以及请求的方法与目标（或响应的状态码与原因短语）。',
    decode: '继续逐行解析起始行之后的头部块，每一个 “Key: Value” 成为一个 Header 字段，挂到应用层节点下。',
    payload: '遇到空行（头部终止符），其后的字节作为消息体形成 Payload；没有消息体时标记为 (empty)。',
    complete: '全部层级组装完毕，校验和与元数据落定，结构化结果由解析 API 输出——与普通解析结果完全一致。'
  },
  TCP: {
    capture: '从模拟链路收到一个 TCP 段，原始字节进入缓冲区，尚未区分网络层与传输层。',
    identify: '解析首段路由表达式：定位源 / 目的 IP 与端口，装入 IPv4 逻辑寻址节点。',
    decode: '逐个解码 “Key=Value” 形式的 TCP 头部：序列号、确认号、标志位、窗口与载荷长度。',
    payload: '依据 Len 把段数据附加为传输层 Payload；Len=0（如纯握手段）时标记为 (empty)。',
    complete: 'Ethernet → IPv4 → TCP → Payload 层级树组装完毕，结构化结果由解析 API 输出。'
  }
};

function pendingMetadata(): SimulatedPacket['metadata'] {
  return { capturedAt: '— pending —', source: '—', destination: '—', length: 0, checksum: '0x----' };
}

export function buildTrajectory(protocol: Protocol, scenario: PacketScenario, rawInput: string): ReplayTrajectory {
  if (!rawInput.trim()) throw new Error('raw is required');
  const raw = rawInput;
  const hex = hexDump(raw);
  const timeline = buildTimeline(protocol, scenario);
  const totalBytes = Buffer.byteLength(raw, 'utf8');
  const isHttp = protocol === 'HTTP';

  let stages: StageSnapshot[];

  if (isHttp) {
    const split = splitHttp(raw);
    const finalFields = parseHttpFields(raw);
    const fullMeta = metadataFor(protocol, raw, '—', '—');

    stages = [
      {
        stage: 'capture',
        index: 0,
        title: STAGE_TITLES.capture,
        narration: STAGE_NARRATION.HTTP.capture,
        raw,
        summary: `${split.startLine || '原始字节流'} · 等待解析`,
        fields: [],
        hex,
        revealedBytes: 0,
        timeline: [],
        metadata: pendingMetadata()
      },
      {
        stage: 'identify',
        index: 1,
        title: STAGE_TITLES.identify,
        narration: STAGE_NARRATION.HTTP.identify,
        raw,
        summary: `${split.startLine} · 起始行已识别`,
        fields: [httpStartLineNode(split)],
        hex,
        revealedBytes: Buffer.byteLength(split.startLine, 'utf8'),
        timeline: timeline.slice(0, 2),
        metadata: { ...pendingMetadata(), length: totalBytes }
      },
      {
        stage: 'decode',
        index: 2,
        title: STAGE_TITLES.decode,
        narration: STAGE_NARRATION.HTTP.decode,
        raw,
        summary: `${split.startLine} · ${split.headerLines.length} headers`,
        fields: [httpStartLineNode(split), httpHeadersNode(split)],
        hex,
        revealedBytes: split.headBytes,
        timeline: timeline.slice(0, 3),
        metadata: { ...pendingMetadata(), length: totalBytes }
      },
      {
        stage: 'payload',
        index: 3,
        title: STAGE_TITLES.payload,
        narration: STAGE_NARRATION.HTTP.payload,
        raw,
        summary: summaryFor(protocol, scenario, raw),
        fields: finalFields,
        hex,
        revealedBytes: totalBytes,
        timeline: timeline.slice(0, 4),
        metadata: { ...fullMeta, capturedAt: '— pending —', checksum: '0x----' }
      },
      {
        stage: 'complete',
        index: 4,
        title: STAGE_TITLES.complete,
        narration: STAGE_NARRATION.HTTP.complete,
        raw,
        summary: summaryFor(protocol, scenario, raw),
        fields: finalFields,
        hex,
        revealedBytes: totalBytes,
        timeline,
        metadata: fullMeta
      }
    ];
  } else {
    const split = splitTcp(raw);
    const finalFields = parseTcpFields(raw);
    const fullMeta = metadataFor(protocol, raw, split.source, split.destination);
    const lengthText = split.len === null ? '0' : String(split.len);

    stages = [
      {
        stage: 'capture',
        index: 0,
        title: STAGE_TITLES.capture,
        narration: STAGE_NARRATION.TCP.capture,
        raw,
        summary: `${scenario === 'handshake' ? 'TCP 握手段' : 'TCP 数据段'} · 等待解析`,
        fields: [],
        hex,
        revealedBytes: 0,
        timeline: [],
        metadata: pendingMetadata()
      },
      {
        stage: 'identify',
        index: 1,
        title: STAGE_TITLES.identify,
        narration: STAGE_NARRATION.TCP.identify,
        raw,
        summary: `${split.source} → ${split.destination} · 路由已识别`,
        fields: [ethernetNode(), ipv4Node(split.source, split.destination)],
        hex,
        revealedBytes: split.routeBytes,
        timeline: timeline.slice(0, 2),
        metadata: { ...pendingMetadata(), source: split.source, destination: split.destination, length: totalBytes }
      },
      {
        stage: 'decode',
        index: 2,
        title: STAGE_TITLES.decode,
        narration: STAGE_NARRATION.TCP.decode,
        raw,
        summary: `${split.source} → ${split.destination} · TCP header`,
        fields: [ethernetNode(), ipv4Node(split.source, split.destination), tcpHeaderNode(split.values, '—')],
        hex,
        revealedBytes: split.headerBytes,
        timeline: timeline.slice(0, 3),
        metadata: { ...pendingMetadata(), source: split.source, destination: split.destination, length: totalBytes }
      },
      {
        stage: 'payload',
        index: 3,
        title: STAGE_TITLES.payload,
        narration: STAGE_NARRATION.TCP.payload,
        raw,
        summary: summaryFor(protocol, scenario, raw),
        fields: [ethernetNode(), ipv4Node(split.source, split.destination), tcpHeaderNode(split.values, lengthText), finalFields[3]],
        hex,
        revealedBytes: totalBytes,
        timeline: timeline.slice(0, 4),
        metadata: { ...fullMeta, capturedAt: '— pending —', checksum: '0x----' }
      },
      {
        stage: 'complete',
        index: 4,
        title: STAGE_TITLES.complete,
        narration: STAGE_NARRATION.TCP.complete,
        raw,
        summary: summaryFor(protocol, scenario, raw),
        fields: finalFields,
        hex,
        revealedBytes: totalBytes,
        timeline,
        metadata: fullMeta
      }
    ];
  }

  if (stages.length !== 5 || stages.some((stage, index) => stage.index !== index)) {
    throw new Error('trajectory stage generation failed');
  }

  const final: SimulatedPacket = {
    id: `replay-${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: stages[4].summary,
    raw,
    hex,
    fields: stages[4].fields,
    timeline,
    metadata: stages[4].metadata
  };

  return {
    id: final.id,
    protocol,
    scenario,
    stages,
    final
  };
}
