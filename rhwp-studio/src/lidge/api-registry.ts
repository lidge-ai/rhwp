// lib/api-registry.mjs의 변경 메서드와 같아야 한다(이름→인자 수). test/api.test.mjs가 두 목록을 비교한다.
// Node 26이 이 파일을 직접 import하므로 enum·namespace 같은 지울 수 없는 TS 문법을 쓰지 않는다.
export const LIDGE_MUTATE_METHODS: Readonly<Record<string, number>> = Object.freeze({
  applyCharFormat: 5, applyCharFormatInCell: 8, applyCharFormatInCellByPath: 6, applyParaFormat: 3, applyParaFormatInCell: 6,
  applyStyle: 3, applyCellStyle: 6, findOrCreateFontId: 1,
  insertText: 4, insertTextInCell: 7, replaceText: 5, replaceAll: 3, deleteText: 4, deleteTextInCell: 7,
  deleteRange: 5, deleteRangeInCell: 8, insertParagraph: 2, deleteParagraph: 2, splitParagraph: 3,
  mergeParagraph: 2, splitParagraphInCell: 6, mergeParagraphInCell: 5,
  createTable: 5, insertTableRow: 5, insertTableColumn: 5, deleteTableRow: 4, deleteTableColumn: 4,
  mergeTableCells: 7, splitTableCell: 5, setTableProperties: 4,
});
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export function normalizeResult(raw: unknown): string {
  if (typeof raw === 'string') { try { return canonical(JSON.parse(raw)); } catch { return canonical(raw); } }
  return canonical(raw);
}
export type ReplayCallOp = { args: { method: string; args: unknown[] }; resultSha256: string };
export class ReplayCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
// call op 하나를 문서에 재생하고 반환값이 Node가 기록한 것과 같은지 본다. 탭(agent-ops.ts)과 테스트가 같은 함수를 쓴다.
export function replayCall(doc: Record<string, unknown>, op: ReplayCallOp, hash: (s: string) => string): unknown {
  const arity = LIDGE_MUTATE_METHODS[op.args.method];
  if (!Object.hasOwn(LIDGE_MUTATE_METHODS, op.args.method) || op.args.args.length !== arity)
    throw new ReplayCallError('API_METHOD_DENIED', op.args.method);
  const fn = doc[op.args.method];
  if (typeof fn !== 'function') throw new ReplayCallError('API_METHOD_MISSING', op.args.method);
  const raw = (fn as (...a: unknown[]) => unknown).apply(doc, op.args.args);
  if (hash(normalizeResult(raw)) !== op.resultSha256) throw new ReplayCallError('RESULT_MISMATCH', `${op.args.method} 반환값이 Node와 다릅니다.`);
  return raw;
}
