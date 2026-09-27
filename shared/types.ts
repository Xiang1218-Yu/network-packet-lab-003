export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
  highlight?: boolean;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}

export type TraceStageId = 'capture' | 'identify' | 'decode' | 'payload' | 'output';

export interface TraceStageSnapshot {
  summary: string;
  fields: ProtocolField[];
  hex: HexRow[];
  timeline: TimelineEvent[];
  activeEventId: string | null;
  metadata: SimulatedPacket['metadata'];
}

export interface TraceStage {
  id: TraceStageId;
  index: number;
  label: string;
  caption: string;
  snapshot: TraceStageSnapshot;
}

export interface ParseTrace {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  generatedAt: string;
  stages: TraceStage[];
  packet: SimulatedPacket;
}
