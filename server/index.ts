import express, { type Request, type Response } from 'express';
import type {
  HexRow,
  PacketScenario,
  ParseRequest,
  ParseTrace,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent,
  TraceStage,
  TraceStageId
} from '../shared/types.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  response.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

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

function hexDump(value: string, highlight?: { from: number; to: number }): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    const highlighted = highlight !== undefined && index < highlight.to && index + slice.length > highlight.from;
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join(''),
      ...(highlighted ? { highlight: true } : {})
    });
  }
  return rows;
}

function field(id: string, key: string, value: string, description: string, children?: ProtocolField[]): ProtocolField {
  return { id, key, value, description, ...(children ? { children } : {}) };
}

function parseHttpFields(raw: string): ProtocolField[] {
  const [head, body = ''] = raw.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const headers = lines.map((line, index) => {
    const separator = line.indexOf(':');
    const key = separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`;
    const value = separator > -1 ? line.slice(separator + 1).trim() : line.trim();
    return field(`header-${index}`, key, value || '(empty)', 'HTTP header field');
  });
  const isResponse = startLine.startsWith('HTTP/');
  const [first, second, third] = startLine.split(' ');
  return [
    field('http-start-line', isResponse ? 'Status-Line' : 'Request-Line', startLine, isResponse ? 'HTTP version and response status' : 'HTTP method, target and version', [
      field('http-part-1', isResponse ? 'Version' : 'Method', first ?? '—', isResponse ? 'Protocol version' : 'HTTP request method'),
      field('http-part-2', isResponse ? 'Status' : 'Target', second ?? '—', isResponse ? 'Status code' : 'Request target'),
      field('http-part-3', isResponse ? 'Reason' : 'Version', isResponse ? (third ?? '—') : (third ?? '—'), isResponse ? 'Reason phrase' : 'Protocol version')
    ]),
    field('http-headers', 'Headers', `${headers.length} fields`, 'Metadata carried by the application layer', headers),
    field('http-body', 'Payload', body || '(empty)', 'Application payload after the header terminator')
  ];
}

function parseTcpFields(raw: string): ProtocolField[] {
  const [route = '', ...parts] = raw.split(' | ');
  const [protocol, source = '—', arrow = '>', destination = '—'] = route.split(' ');
  const values = new Map(parts.map((part) => {
    const separator = part.indexOf('=');
    return separator > -1 ? [part.slice(0, separator), part.slice(separator + 1)] : [part, 'true'];
  }));
  return [
    field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', [
      field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address'),
      field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address'),
      field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier')
    ]),
    field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', [
      field('ipv4-source', 'Source', source, 'Origin IP and port'),
      field('ipv4-destination', 'Destination', destination, 'Target IP and port'),
      field('ipv4-protocol', 'Next Protocol', protocol || 'TCP', 'Transport protocol')
    ]),
    field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', [
      field('tcp-seq', 'Sequence', values.get('Seq') ?? '—', 'Byte sequence position'),
      field('tcp-ack', 'Acknowledgement', values.get('Ack') ?? '—', 'Next expected byte'),
      field('tcp-flags', 'Flags', values.get('Flags') ?? '—', 'Control bits'),
      field('tcp-window', 'Window', values.get('Win') ?? '—', 'Receive window size'),
      field('tcp-length', 'Payload Length', values.get('Len') ?? '0', 'TCP segment data length')
    ]),
    field('tcp-payload', 'Payload', values.get('Len') === '0' ? '(empty)' : 'Encrypted application data', 'Data carried by the segment')
  ];
}

function timelineFor(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Start line identified', 'Request or status line tokenized into parts'],
        ['parse', 'Headers decoded', 'Header fields indexed up to the blank line'],
        ['application', `${prefix} payload formed`, scenario === 'response' ? 'Response body is ready for inspection' : 'Request body reconstructed after the header terminator'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['parse', 'Route identified', 'Source and destination endpoints parsed'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['application', 'Payload assembled', scenario === 'handshake' ? 'Handshake segment carries no payload' : 'Segment payload length recorded for inspection'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase: phase as TimelineEvent['phase'],
    detail
  }));
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

function buildPacket(protocol: Protocol, scenario: PacketScenario, raw: string): SimulatedPacket {
  const safeRaw = raw.trim() ? raw : (protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario]);
  const isHttp = protocol === 'HTTP';
  return {
    id: `${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: isHttp
      ? `${safeRaw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
      : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${safeRaw.split(' | ')[0]}`,
    raw: safeRaw,
    hex: hexDump(safeRaw),
    fields: isHttp ? parseHttpFields(safeRaw) : parseTcpFields(safeRaw),
    timeline: timelineFor(protocol, scenario),
    metadata: {
      capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      source: isHttp ? '10.0.0.24:51842' : safeRaw.split(' > ')[0].replace('TCP ', ''),
      destination: isHttp ? '10.0.0.8:443' : (safeRaw.split(' > ')[1]?.split(' | ')[0] ?? '10.0.0.8:443'),
      length: Buffer.byteLength(safeRaw, 'utf8'),
      checksum: checksum(safeRaw)
    }
  };
}

const TRACE_STAGE_LABELS: Array<{ id: TraceStageId; label: string }> = [
  { id: 'capture', label: '抓取 · Capture' },
  { id: 'identify', label: '识别 · Identify' },
  { id: 'decode', label: '解码 · Decode' },
  { id: 'payload', label: 'Payload · 组装' },
  { id: 'output', label: '输出 · Output' }
];

function buildTrace(protocol: Protocol, scenario: PacketScenario, raw: string): ParseTrace {
  const packet = buildPacket(protocol, scenario, raw);
  const safeRaw = packet.raw;
  const isHttp = protocol === 'HTTP';
  const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
  const totalBytes = byteLength(safeRaw);

  // 各阶段已覆盖的字节范围，用于十六进制视图高亮与处理进度
  let identifyEnd: number;
  let decodeEnd: number;
  if (isHttp) {
    const lineBreak = /\r?\n/.exec(safeRaw);
    const blankLine = /\r?\n\r?\n/.exec(safeRaw);
    identifyEnd = byteLength(safeRaw.slice(0, lineBreak ? lineBreak.index + lineBreak[0].length : safeRaw.length));
    decodeEnd = byteLength(safeRaw.slice(0, blankLine ? blankLine.index + blankLine[0].length : safeRaw.length));
  } else {
    identifyEnd = byteLength(safeRaw.split(' | ')[0]);
    decodeEnd = totalBytes;
  }

  const highlights: Array<{ from: number; to: number } | undefined> = isHttp
    ? [undefined, { from: 0, to: identifyEnd }, { from: identifyEnd, to: decodeEnd }, decodeEnd < totalBytes ? { from: decodeEnd, to: totalBytes } : undefined, undefined]
    : [undefined, { from: 0, to: identifyEnd }, { from: identifyEnd, to: totalBytes }, undefined, undefined];

  const allFields = packet.fields;
  const stageFields: ProtocolField[][] = isHttp
    ? [[], allFields.slice(0, 1), allFields.slice(0, 2), allFields, allFields]
    : [[], allFields.slice(1, 2), allFields.slice(0, 3), allFields, allFields];

  const processedBytes = [totalBytes, identifyEnd, decodeEnd, totalBytes, totalBytes];

  const startLine = safeRaw.split(/\r?\n/)[0];
  const route = safeRaw.split(' | ')[0];
  const tcpValue = (key: string) => safeRaw.split(' | ').slice(1).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1) ?? '—';
  const headerCount = isHttp ? Math.max(safeRaw.split(/\r?\n\r?\n/)[0].split(/\r?\n/).length - 1, 0) : 0;
  const bodyBytes = isHttp ? totalBytes - decodeEnd : 0;

  const summaries = isHttp
    ? [
        `已抓取 ${totalBytes} 字节 · 等待解析`,
        `起始行：${startLine}`,
        `已解码 ${headerCount} 个 Header 字段`,
        `Payload 就绪 · ${bodyBytes} 字节`,
        packet.summary
      ]
    : [
        `已抓取 ${totalBytes} 字节 · 等待解析`,
        `路由：${route}`,
        `TCP 头部解码 · Flags=${tcpValue('Flags')}`,
        `Payload 记录 · Len=${tcpValue('Len')}`,
        packet.summary
      ];

  const captions = isHttp
    ? [
        '网卡抓取到原始字节流，此时尚未应用任何协议知识。',
        `定位第一行起始行 “${startLine}”，并拆分为方法、目标与版本。`,
        `逐行解析 ${headerCount} 个 Header 字段，直到遇到空行为止。`,
        bodyBytes > 0 ? `空行之后的 ${bodyBytes} 字节组成应用层 Payload。` : '空行之后没有 Body，本包 Payload 为空。',
        '全部层级解析完成，输出与“解析数据包”接口一致的结构化结果。'
      ]
    : [
        '网卡抓取到原始字节流，此时尚未应用任何协议知识。',
        `识别路由 “${route}”，确定通信的源与目的端点。`,
        `解码 TCP 头部：Seq=${tcpValue('Seq')} Ack=${tcpValue('Ack')} Flags=${tcpValue('Flags')} Win=${tcpValue('Win')}。`,
        `段内声明 Payload 长度 Len=${tcpValue('Len')}，内容为模拟的应用数据。`,
        '全部层级解析完成，输出与“解析数据包”接口一致的结构化结果。'
      ];

  const stages: TraceStage[] = TRACE_STAGE_LABELS.map((stage, index) => ({
    id: stage.id,
    index,
    label: stage.label,
    caption: captions[index],
    snapshot: {
      summary: summaries[index],
      fields: stageFields[index],
      hex: hexDump(safeRaw, highlights[index]),
      timeline: packet.timeline.slice(0, index + 1),
      activeEventId: packet.timeline[index]?.id ?? null,
      metadata: {
        ...packet.metadata,
        length: processedBytes[index],
        checksum: index === TRACE_STAGE_LABELS.length - 1 ? packet.metadata.checksum : '—'
      }
    }
  }));

  return {
    id: `trace-${packet.id}`,
    protocol,
    scenario,
    raw: safeRaw,
    generatedAt: packet.metadata.capturedAt,
    stages,
    packet
  };
}

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

app.post('/api/parse/trace', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  try {
    response.json({ data: buildTrace(protocol, scenario, raw) });
  } catch {
    response.status(500).json({ error: 'failed to build parse trace' });
  }
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
