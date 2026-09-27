export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
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

export type ReplayStageId = 'capture' | 'identify' | 'decode' | 'payload' | 'complete';

export interface StageSnapshot {
  stage: ReplayStageId;
  index: number;
  title: string;
  narration: string;
  raw: string;
  summary: string;
  fields: ProtocolField[];
  hex: HexRow[];
  revealedBytes: number;
  timeline: TimelineEvent[];
  metadata: SimulatedPacket['metadata'];
}

export interface ReplayTrajectory {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  stages: StageSnapshot[];
  final: SimulatedPacket;
}
