// embed runtime은 DocumentAgentError만 code·recovered를 응답에 싣는다(embed/runtime.ts:95-106).
// lidge 메서드의 확정 오류도 같은 모양으로 보내려고 둔 최소 클래스다.
export class LidgeAgentError extends Error {
  readonly code: string;
  readonly recovered?: boolean;
  constructor(code: string, message: string = code, recovered?: boolean) {
    super(message);
    this.name = 'LidgeAgentError';
    this.code = code;
    if (recovered !== undefined) this.recovered = recovered;
  }
}

export const isLidgeAgentError = (value: unknown): value is LidgeAgentError =>
  value instanceof LidgeAgentError;
