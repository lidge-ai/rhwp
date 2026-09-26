import { LidgeAgentError } from './errors.ts';

export class AgentInputLock {
  private token: string | null = null;
  private readonly banner: HTMLDivElement;

  constructor(doc: Document = document) {
    this.banner = doc.createElement('div');
    this.banner.setAttribute('role', 'status');
    this.banner.setAttribute('aria-live', 'polite');
    this.banner.setAttribute('aria-atomic', 'true');
    this.banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;display:none;padding:8px 12px;background:#fff4d6;border-bottom:2px solid #b56a00;color:#5a3a00;font:600 14px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none;';
    doc.body.appendChild(this.banner);
  }

  get locked(): boolean { return this.token !== null; }

  lockInput(on: boolean, reason: string, token: string): { locked: boolean } {
    if (!token) throw new LidgeAgentError('LOCK_TOKEN_REQUIRED');
    const root = this.banner.ownerDocument.documentElement;
    if (on) {
      if (this.token && this.token !== token) throw new LidgeAgentError('LOCK_HELD');
      this.token = token;
      this.banner.textContent = reason || 'AI가 문서를 편집 중입니다';
      this.banner.style.display = 'block';
      root.dataset.lidgeAgentLocked = 'true';
    } else {
      if (this.token !== token) throw new LidgeAgentError('LOCK_TOKEN_MISMATCH');
      this.token = null;
      this.banner.style.display = 'none';
      this.banner.textContent = '';
      delete root.dataset.lidgeAgentLocked;
    }
    return { locked: this.locked };
  }

  assertAgent(token: unknown): void {
    if (typeof token !== 'string' || this.token !== token) {
      throw new LidgeAgentError('AGENT_LOCK_REQUIRED', 'AGENT_LOCK_REQUIRED', true);
    }
  }
}
