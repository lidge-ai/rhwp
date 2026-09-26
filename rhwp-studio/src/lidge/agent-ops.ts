import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { EventBus } from '../core/event-bus.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { DocumentAgentController } from '../document-agent/controller.ts';
import { isDocumentAgentError } from '../document-agent/types.ts';
import { LidgeAgentError, isLidgeAgentError } from './errors.ts';
import type { AgentInputLock } from './input-lock.ts';
import { LIDGE_MUTATE_METHODS, replayCall, ReplayCallError } from './api-registry.ts';

type Address = { section: number; para: number; control: number; cell: number };
export type AgentCell = { table: number; row: number; col: number; resolved: Address };
// wp2 lib/ops.mjs:38-40, 52-54, 69-72가 남기는 모양(+ wp3의 parentPara).
type CellOp = {
  kind: 'setCell' | 'insertTextInCell';
  logical: { table: number; row: number; col: number };
  resolved: Address; beforeSha256: string;
  args: { table: number; row: number; col: number; text: string; paragraph?: number; offset?: number };
};
type ReplaceOp = {
  kind: 'replaceText';
  logical: { find: string; occurrence: number };
  resolved: { section: number; para: number; control: null; cell: null; offset: number; length: number };
  beforeSha256: string; args: { find: string; replace: string };
};
type CheckboxOp = {
  kind: 'setCheckbox';
  logical: { occurrence: number };
  resolved: { section: number; para: number; parentPara: number | null; control: number | null;
    cell: number | null; cellPara: number | null; offset: number; length: 1 };
  beforeSha256: string; args: { occurrence: number };
};
type InsertOp = {
  kind: 'insertText';
  logical: { section: number; paragraph: number };
  resolved: { section: number; para: number; control: null; cell: null; offset: number; length: 0 };
  beforeSha256: string; args: { section: number; paragraph: number; offset: number; text: string };
};
// hwp.api 변경 호출(lib/ops.mjs applyCall). 탭은 같은 메서드를 같은 인자로 부르고 반환값 해시를 비교한다.
type CallOp = {
  kind: 'call'; logical: { method: string };
  resolved: { method: string; args: unknown[] };
  beforeSha256: string; resultSha256: string; args: { method: string; args: unknown[] };
};
type Op = CellOp | ReplaceOp | CheckboxOp | InsertOp | CallOp;
type Base = { diskSha256: string; documentEpoch: number; changeSeq: number; exportSha256: string };
type Control = { ctrlId: string; list: number; para: number; controlIndex: number };
export type AgentBatch = { schemaVersion: 1; commandId: string; token: string; base: Base; ops: Op[] };
export type AgentOpsDeps = {
  wasm: WasmBridge; input: InputHandler; controller: DocumentAgentController;
  eventBus: EventBus; lock: AgentInputLock; render: () => Promise<void>;
};
export type AgentApplyReceipt = {
  commandId: string; changedCells: AgentCell[]; beforeDocumentSha256: string;
  afterChangeSeq: number; exportSha256: string;
};
export type AgentRollbackResult = { ok: boolean; code?: string; changeSeq?: number };

// rollbackOps가 확인하는 마지막 lidge 배치. 문서를 다시 열면 documentEpoch가 달라져 무효가 된다.
let lastApplied: { commandId: string; documentEpoch: number; afterChangeSeq: number } | null = null;
const HEX64 = /^[a-f0-9]{64}$/;
const hash = (s: string): string => bytesToHex(sha256(new TextEncoder().encode(s)));
const nat = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const plain = (s: unknown): s is string => typeof s === 'string' && !/[\u0000-\u001f\u007f]/u.test(s);
const same = (a: Address, b: Address): boolean =>
  a.section === b.section && a.para === b.para && a.control === b.control && a.cell === b.cell;
const fail = (code: string, message: string = code): never => { throw new LidgeAgentError(code, message); };
const mustOk = (result: { ok?: boolean } | undefined, code: string): void => { if (result?.ok === false) fail(code); };
const sameBase = (s: { documentEpoch: number; changeSeq: number; documentSha256: string }, b: Base): boolean =>
  s.documentEpoch === b.documentEpoch && s.changeSeq === b.changeSeq && s.documentSha256 === b.exportSha256;

function assertBatch(batch: AgentBatch): void {
  const invalid = (why: string): never => { throw new LidgeAgentError('INVALID_BATCH', why, true); };
  if (batch?.schemaVersion !== 1 || typeof batch.commandId !== 'string' || !batch.commandId || !batch.base
      || !nat(batch.base.documentEpoch) || !nat(batch.base.changeSeq)
      || !HEX64.test(batch.base.exportSha256) || !HEX64.test(batch.base.diskSha256)
      || !Array.isArray(batch.ops) || batch.ops.length === 0 || batch.ops.length > 4096) invalid('INVALID_BATCH');
  for (const op of batch.ops) {
    if (op?.kind === 'call') {
      const c = op as CallOp, method = c.args?.method;
      if (typeof method !== 'string' || !Object.hasOwn(LIDGE_MUTATE_METHODS, method)) invalid('API_METHOD_DENIED');
      if (!Array.isArray(c.args.args) || c.args.args.length !== LIDGE_MUTATE_METHODS[method]
          || !HEX64.test(c.resultSha256) || !HEX64.test(c.beforeSha256)
          || c.args.args.some(a => !(typeof a === 'string' || typeof a === 'boolean' || nat(a)))) invalid('INVALID_CALL_OP');
      continue;
    }
    const r = op?.resolved as Record<string, unknown> | undefined;
    if (!r || !HEX64.test(op.beforeSha256) || !nat(r.section) || !nat(r.para)) invalid(`INVALID_OP:${String(op?.kind)}`);
    if (op.kind === 'setCell' || op.kind === 'insertTextInCell') {
      if (!nat(r!.control) || !nat(r!.cell) || !plain(op.args?.text)
          || (op.kind === 'insertTextInCell' && (!nat(op.args.paragraph) || !nat(op.args.offset)))) invalid('INVALID_CELL_OP');
    } else if (op.kind === 'replaceText') {
      if (r!.control !== null || r!.cell !== null || !nat(r!.offset) || !nat(r!.length)
          || !plain(op.args?.find) || op.args.find === '' || !plain(op.args?.replace)) invalid('INVALID_REPLACE_OP');
    } else if (op.kind === 'setCheckbox') {
      const inCell = r!.control !== null;
      if (!nat(r!.offset) || r!.length !== 1 || (inCell
          ? !nat(r!.control) || !nat(r!.cell) || !nat(r!.cellPara) || !nat(r!.parentPara)
          : r!.cell !== null || r!.cellPara !== null)) invalid('INVALID_CHECKBOX_OP');
    } else if (op.kind === 'insertText') {
      if (r!.control !== null || r!.cell !== null || !nat(r!.offset) || r!.length !== 0
          || !plain(op.args?.text) || op.args.text === '' || op.args.section !== r!.section
          || op.args.paragraph !== r!.para || op.args.offset !== r!.offset) invalid('INVALID_INSERT_OP');
    } else invalid('UNKNOWN_OP');
  }
}

function topTables(wasm: WasmBridge): Control[] {
  return (wasm.getControls() as Control[]).filter(c => c.ctrlId === 'tbl' && c.list === 0);
}

function sectionOf(wasm: WasmBridge, globalPara: number): { section: number; para: number } {
  let section = 0, para = globalPara;
  while (section < wasm.getSectionCount() && para >= wasm.getParagraphCount(section)) {
    para -= wasm.getParagraphCount(section);
    section += 1;
  }
  if (section >= wasm.getSectionCount()) fail('TARGET_NOT_FOUND');
  return { section, para };
}

function resolve(wasm: WasmBridge, target: CellOp['logical']): Address {
  const table = topTables(wasm)[target.table];
  if (!table) fail('TARGET_NOT_FOUND');
  const { section, para } = sectionOf(wasm, table.para);
  const control = table.controlIndex;
  const size = wasm.getTableDimensions(section, para, control);
  if (target.row >= size.rowCount || target.col >= size.colCount) fail('TARGET_NOT_FOUND');
  for (let cell = 0; cell < size.cellCount; cell += 1) {
    const info = wasm.getCellInfo(section, para, control, cell);
    if (info.row === target.row && info.col === target.col) return { section, para, control, cell };
  }
  return fail('MERGED_OR_ABSENT_CELL'); // wp2 cells.mjs:20-28처럼 병합으로 가려진 칸은 앵커 좌표만 허용
}

function cellText(wasm: WasmBridge, a: Address): string {
  const parts: string[] = [];
  const n = wasm.getCellParagraphCount(a.section, a.para, a.control, a.cell);
  for (let p = 0; p < n; p += 1) {
    const len = wasm.getCellParagraphLength(a.section, a.para, a.control, a.cell, p);
    parts.push(wasm.getTextInCell(a.section, a.para, a.control, a.cell, p, 0, len));
  }
  return parts.join('\n').trim();
}

function cellFromAddress(wasm: WasmBridge, a: Address): AgentCell {
  let globalPara = a.para;
  for (let s = 0; s < a.section; s += 1) globalPara += wasm.getParagraphCount(s);
  const table = topTables(wasm).findIndex(c => c.para === globalPara && c.controlIndex === a.control);
  if (table < 0) fail('TARGET_NOT_FOUND');
  const info = wasm.getCellInfo(a.section, a.para, a.control, a.cell);
  return { table, row: info.row, col: info.col, resolved: a };
}

function mutateCell(wasm: WasmBridge, op: CellOp, a: Address): void {
  const { section, para, control, cell } = a;
  if (op.kind === 'setCell') {
    const n = wasm.getCellParagraphCount(section, para, control, cell);
    for (let p = 0; p < n; p += 1) {
      const len = wasm.getCellParagraphLength(section, para, control, cell, p);
      if (len) mustOk(wasm.deleteTextInCellDeferredPagination(section, para, control, cell, p, 0, len), 'CELL_DELETE_FAILED');
    }
    if (op.args.text) mustOk(wasm.insertTextInCellDeferredPagination(section, para, control, cell, 0, 0, op.args.text), 'CELL_INSERT_FAILED');
    if (cellText(wasm, a) !== op.args.text.trim()) fail('CELL_POSTIMAGE_MISMATCH');
    return;
  }
  // wp2 인자 이름 그대로(ops.mjs:31-36). args.p 같은 별칭은 없다.
  const paragraph = op.args.paragraph as number, offset = op.args.offset as number;
  if (paragraph >= wasm.getCellParagraphCount(section, para, control, cell)
      || offset > wasm.getCellParagraphLength(section, para, control, cell, paragraph)) fail('INVALID_OFFSET');
  mustOk(wasm.insertTextInCellDeferredPagination(section, para, control, cell, paragraph, offset, op.args.text), 'CELL_INSERT_FAILED');
}

function mutateReplace(wasm: WasmBridge, op: ReplaceOp): void {
  const a = op.resolved;
  const before = wasm.getTextRange(a.section, a.para, a.offset, a.length);
  if (before !== op.args.find || hash(before) !== op.beforeSha256) fail('TARGET_PREIMAGE_MISMATCH', '본문 문자열이 다릅니다.');
  mustOk(wasm.replaceText(a.section, a.para, a.offset, a.length, op.args.replace), 'REPLACE_FAILED');
  if (wasm.getTextRange(a.section, a.para, a.offset, Array.from(op.args.replace).length) !== op.args.replace) fail('REPLACE_POSTIMAGE_MISMATCH');
}

// 본문 문단 끼워 넣기(lib/ops.mjs insertText). 서버가 본 문단 전체 글의 해시가 같을 때만 넣는다.
function mutateInsert(wasm: WasmBridge, op: InsertOp): void {
  const a = op.resolved;
  if (a.section >= wasm.getSectionCount() || a.para >= wasm.getParagraphCount(a.section)) fail('TARGET_NOT_FOUND');
  const length = wasm.getParagraphLength(a.section, a.para);
  if (a.offset > length) fail('INVALID_OFFSET');
  if (hash(wasm.getTextRange(a.section, a.para, 0, length)) !== op.beforeSha256) fail('TARGET_PREIMAGE_MISMATCH', '본문 문단이 다릅니다.');
  const result = JSON.parse(wasm.insertText(a.section, a.para, a.offset, op.args.text)) as { ok?: boolean };
  mustOk(result, 'INSERT_FAILED');
  if (wasm.getTextRange(a.section, a.para, a.offset, Array.from(op.args.text).length) !== op.args.text) fail('INSERT_POSTIMAGE_MISMATCH');
}

// 셀 안 체크박스는 wp2가 편집에 쓴 주소(cellContext.parentPara, ops.mjs:66-67)를 그대로 쓴다.
// hwp.api 변경 호출 재생. 빌린 문서 핸들은 이 snapshot 콜백 안에서만 쓰고 세대를 확인한다(wasm-bridge.ts:608-620).
function mutateCall(deps: AgentOpsDeps, generation: number, op: CallOp): void {
  const doc = deps.wasm.borrowDocumentHandle() as unknown as Record<string, unknown> | null;
  if (!doc || deps.wasm.documentGeneration !== generation) fail('DOCUMENT_GENERATION_CHANGED');
  try { replayCall(doc!, op, hash); }
  catch (e) { if (e instanceof ReplayCallError) fail(e.code, e.message); throw e; }
}

function mutateCheckbox(wasm: WasmBridge, op: CheckboxOp): AgentCell | null {
  const a = op.resolved;
  if (a.control === null) {
    const before = wasm.getTextRange(a.section, a.para, a.offset, 1);
    if (before !== '□' || hash(before) !== op.beforeSha256) fail('TARGET_PREIMAGE_MISMATCH', 'checkbox glyph가 다릅니다.');
    mustOk(wasm.replaceText(a.section, a.para, a.offset, 1, '☑'), 'CHECKBOX_EDIT_FAILED');
    if (wasm.getTextRange(a.section, a.para, a.offset, 1) !== '☑') fail('CHECKBOX_POSTIMAGE_MISMATCH');
    return null;
  }
  const at = [a.section, a.parentPara as number, a.control, a.cell as number, a.cellPara as number] as const;
  const before = wasm.getTextInCell(...at, a.offset, 1);
  if (before !== '□' || hash(before) !== op.beforeSha256) fail('TARGET_PREIMAGE_MISMATCH', 'checkbox glyph가 다릅니다.');
  mustOk(wasm.deleteTextInCellDeferredPagination(...at, a.offset, 1), 'CHECKBOX_EDIT_FAILED');
  mustOk(wasm.insertTextInCellDeferredPagination(...at, a.offset, '☑'), 'CHECKBOX_EDIT_FAILED');
  if (wasm.getTextInCell(...at, a.offset, 1) !== '☑') fail('CHECKBOX_POSTIMAGE_MISMATCH');
  return cellFromAddress(wasm, { section: a.section, para: a.parentPara as number, control: a.control, cell: a.cell as number });
}

// controller.ts:876-889처럼 관측자 실패가 이미 끝난 transaction을 뒤집지 않게 한다.
function emitChanged(deps: AgentOpsDeps, event: { schemaVersion: 1; reason: 'agent_apply' | 'agent_revert';
    documentEpoch: number; changeSeq: number; commandId: string }): void {
  try {
    deps.eventBus.emit('document-agent-changed', event);
  } catch (error) {
    console.error('[lidge] document-agent-changed observer 실패:', error);
  }
}

export async function applyOps(batch: AgentBatch, deps: AgentOpsDeps): Promise<AgentApplyReceipt> {
  deps.lock.assertAgent(batch?.token);
  assertBatch(batch);
  const state = deps.controller.getDocumentState();
  if (!sameBase(state, batch.base)) throw new LidgeAgentError('DOCUMENT_SHA_MISMATCH', '탭 기준 상태가 바뀌었습니다.', true);
  const changedCells: AgentCell[] = [];
  try {
    await deps.input.executeDocumentAgentOperation({
      kind: 'snapshot', operationType: 'lidge-agent-batch',
      operation: (wasm: WasmBridge) => {
        const generation = deps.wasm.documentGeneration;
        if (!sameBase(deps.controller.getDocumentState(), batch.base)) fail('DOCUMENT_SHA_MISMATCH', '적용 직전 상태가 바뀌었습니다.');
        let deferred = false;
        let lastPosition = deps.input.getCursorPosition();
        try {
          mustOk(wasm.beginDeferredPagination(), 'DEFERRED_PAGINATION_FAILED');
          deferred = true;
          for (const op of batch.ops) {
            if (op.kind === 'call') {
              mutateCall(deps, generation, op);
            } else if (op.kind === 'setCell' || op.kind === 'insertTextInCell') {
              const a = resolve(wasm, op.logical);
              if (!same(a, op.resolved) || hash(cellText(wasm, a)) !== op.beforeSha256)
                fail('TARGET_PREIMAGE_MISMATCH', '셀 주소 또는 이전 내용이 다릅니다.');
              mutateCell(wasm, op, a);
              changedCells.push({ ...op.logical, resolved: a });
              lastPosition = { sectionIndex: a.section, paragraphIndex: a.para, charOffset: 0 };
            } else if (op.kind === 'replaceText') {
              mutateReplace(wasm, op);
              lastPosition = { sectionIndex: op.resolved.section, paragraphIndex: op.resolved.para, charOffset: op.resolved.offset };
            } else if (op.kind === 'insertText') {
              mutateInsert(wasm, op);
              lastPosition = { sectionIndex: op.resolved.section, paragraphIndex: op.resolved.para,
                charOffset: op.resolved.offset + Array.from(op.args.text).length };
            } else {
              // CellOp.kind가 두 값 유니온이라 TS가 else에서 CellOp를 좁혀 없애지 못한다. assertBatch가 이미 kind를 검증했다.
              const box = op as CheckboxOp;
              const cell = mutateCheckbox(wasm, box);
              if (cell) changedCells.push(cell);
              lastPosition = { sectionIndex: box.resolved.section, paragraphIndex: box.resolved.para, charOffset: box.resolved.offset };
            }
          }
          const flushed = wasm.flushDeferredPagination();
          deferred = false;
          mustOk(flushed, 'DEFERRED_PAGINATION_FAILED');
          return lastPosition;
        } catch (error) {
          if (deferred) { try { wasm.cancelDeferredPagination(); } catch { /* snapshot 복구가 최종 원복한다 */ } }
          throw error;
        }
      },
      meta: { actionId: 'lidge-agent-batch', domain: 'text', refresh: 'full', dirtyScope: 'paragraph', selection: 'moveToResult' },
    }, deps.render);
  } catch (error) {
    // render 실패: RENDER_FAILED + recovered(input-handler.ts:3174-3192). 그대로 넘긴다.
    if (isDocumentAgentError(error) && typeof error.recovered === 'boolean') throw error;
    // op 실패 뒤 before snapshot 복구까지 실패(engine/command.ts:2833-2838): 상태 불명.
    if (error instanceof AggregateError) throw new LidgeAgentError('TRANSACTION_FAILED', 'op 실패 뒤 snapshot 복구도 실패했습니다.', false);
    // 나머지 op 오류는 SnapshotCommand가 before snapshot으로 원복한 뒤 다시 던진 것이다(engine/command.ts:2825-2841).
    const code = isDocumentAgentError(error) || isLidgeAgentError(error) ? error.code : 'TRANSACTION_FAILED';
    throw new LidgeAgentError(code, error instanceof Error ? error.message : String(error), true);
  }
  const after = deps.controller.getDocumentState();
  if (after.changeSeq !== batch.base.changeSeq + 1) {
    throw new LidgeAgentError('TRANSACTION_FAILED', '배치 changeSeq 증가량이 1이 아닙니다.', false);
  }
  lastApplied = { commandId: batch.commandId, documentEpoch: after.documentEpoch, afterChangeSeq: after.changeSeq };
  emitChanged(deps, { schemaVersion: 1, reason: 'agent_apply', documentEpoch: after.documentEpoch,
    changeSeq: after.changeSeq, commandId: batch.commandId });
  return { commandId: batch.commandId, changedCells, beforeDocumentSha256: state.documentSha256,
    afterChangeSeq: after.changeSeq, exportSha256: after.documentSha256 };
}

// 적용 뒤 저장 전 실패에서만 쓴다. 사람 경로의 edit:undo는 잠금 중 막히므로(dispatcher) 토큰을 확인하는
// 이 전용 RPC가 InputHandler.performUndo()를 한 번 부른다(command/commands/edit.ts:21-29와 같은 내부 호출).
export async function rollbackOps(
  deps: AgentOpsDeps,
  req: { token: string; commandId: string; beforeDocumentSha256: string },
): Promise<AgentRollbackResult> {
  deps.lock.assertAgent(req.token);
  if (!lastApplied || lastApplied.commandId !== req.commandId) return { ok: false, code: 'NOT_LAST_BATCH' };
  const before = deps.controller.getDocumentState();
  if (before.documentEpoch !== lastApplied.documentEpoch || before.changeSeq !== lastApplied.afterChangeSeq) {
    return { ok: false, code: 'HISTORY_MOVED' };
  }
  deps.input.performUndo();
  await deps.render();
  const after = deps.controller.getDocumentState();
  if (after.documentSha256 !== req.beforeDocumentSha256) return { ok: false, code: 'ROLLBACK_STATE_MISMATCH' };
  lastApplied = null;
  emitChanged(deps, { schemaVersion: 1, reason: 'agent_revert', documentEpoch: after.documentEpoch,
    changeSeq: after.changeSeq, commandId: req.commandId });
  return { ok: true, changeSeq: after.changeSeq };
}
