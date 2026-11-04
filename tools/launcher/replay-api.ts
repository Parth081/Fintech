// M6: the launcher's view of the record/replay library (tools/booth/replay.ts). Kept as a thin adapter so
// the launcher is tested with a local fake, and so a missing recorder gives a clear error instead of a crash.
import path from 'node:path';
import type { EventBus } from '@ct/event-bus';
import type { RecordingMeta } from '@ct/contracts';
import * as realReplay from '../booth/replay';

export interface ReplayPublisher {
  stop(): Promise<void>;
  done: Promise<void>;
}

export interface ReplayApi {
  /** Publishes the recording's events into the bus with original relative timing, first event = now. */
  startReplayPublisher(options: {
    bus: EventBus;
    file: string;
    loop?: boolean;
    onLoop?: () => void;
    now?: () => number;
  }): Promise<ReplayPublisher>;
  listRecordings(dataDir: string): RecordingMeta[] | Promise<RecordingMeta[]>;
  newestRecording(dataDir: string): RecordingMeta | null | undefined | Promise<RecordingMeta | null | undefined>;
}

/** The real library. */
export async function loadReplayApi(): Promise<ReplayApi> {
  return realReplay as unknown as ReplayApi;
}

/** `<dataDir>/recordings/<name>.jsonl` (the contract's layout; the .meta.json sits next to it). */
export function recordingFile(dataDir: string, name: string): string {
  return path.join(dataDir, 'recordings', `${name}.jsonl`);
}
