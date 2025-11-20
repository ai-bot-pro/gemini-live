export enum LiveStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface LogMessage {
  id: string;
  timestamp: Date;
  role: 'user' | 'system' | 'model';
  text: string;
}

export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

export interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  isListening: boolean;
}