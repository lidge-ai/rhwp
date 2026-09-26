import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { VirtualScroll } from '../view/virtual-scroll.ts';
import type { ViewportManager } from '../view/viewport-manager.ts';
import type { AgentCell } from './agent-ops.ts';
import { LidgeAgentError } from './errors.ts';

export class AgentHighlight {
  private layer: HTMLDivElement;
  private timer: number | undefined;
  constructor(private container: HTMLElement, private wasm: WasmBridge,
      private pages: VirtualScroll, private viewport: ViewportManager) {
    this.layer = document.createElement('div');
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:7;';
    container.querySelector('#scroll-content')?.appendChild(this.layer);
  }
  highlightCells(cells: AgentCell[], ms: number): { highlighted: number } {
    this.clear();
    const content = this.container.querySelector('#scroll-content');
    if (!content) throw new LidgeAgentError('SCROLL_CONTENT_MISSING');
    content.appendChild(this.layer);
    const zoom = this.viewport.getZoom();
    for (const cell of cells) {
      const a = cell.resolved;
      const box = this.wasm.getTableCellBboxes(a.section, a.para, a.control).find(b => b.cellIdx === a.cell);
      if (!box) throw new LidgeAgentError('CELL_BBOX_MISSING');
      const mark = document.createElement('div');
      mark.style.cssText = `position:absolute;left:${(content.clientWidth - this.pages.getPageWidth(box.pageIndex)) / 2 + box.x * zoom}px;top:${this.pages.getPageOffset(box.pageIndex) + box.y * zoom}px;width:${box.w * zoom}px;height:${box.h * zoom}px;background:rgba(255,186,0,.28);outline:2px solid #b56a00;box-sizing:border-box;`;
      this.layer.appendChild(mark);
    }
    this.timer = window.setTimeout(() => this.clear(), Math.max(1000, Math.min(ms, 30000)));
    return { highlighted: cells.length };
  }
  clear(): void { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; this.layer.replaceChildren(); }
  dispose(): void { this.clear(); this.layer.remove(); }
}
