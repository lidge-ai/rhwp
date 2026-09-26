import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { ContentLossReport } from '../core/export-content-loss.ts';

export type LidgeFormat = 'hwp' | 'hwpx';
export interface LidgeExport {
  bytes: Uint8Array;
  format: LidgeFormat;
  contentLoss: ContentLossReport;
}
export interface LidgeEvent {
  event: 'lidge.hostSaveRequested';
  payload: { schemaVersion: 1 };
}

let hostConnected = false;
const listeners = new Set<(event: LidgeEvent) => void>();

export function setLidgeHostConnected(connected: boolean): void {
  hostConnected = connected;
}

export function onLidgeHostEvent(listener: (event: LidgeEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestLidgeHostSave(): boolean {
  if (!hostConnected) return false;
  const event: LidgeEvent = { event: 'lidge.hostSaveRequested', payload: { schemaVersion: 1 } };
  for (const listener of listeners) listener(event);
  return true;
}

export function exportWithReport(wasm: WasmBridge, format: LidgeFormat): LidgeExport {
  if (wasm.requiresPasswordForSave) throw new Error('암호화 문서는 호스트 저장을 지원하지 않습니다');
  const artifact = format === 'hwp' ? wasm.exportHwpWithReport() : wasm.exportHwpxWithReport();
  return { bytes: artifact.bytes, format, contentLoss: artifact.contentLoss };
}
