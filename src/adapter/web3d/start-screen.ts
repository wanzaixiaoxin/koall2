/**
 * 开始画面：标题 + 操作说明 + 开始按钮（点击后创建 AudioContext，满足浏览器手势要求）。
 */
export class StartScreen {
  private root: HTMLDivElement;
  onStart: (() => void) | null = null;

  constructor(levelName: string) {
    this.root = document.createElement('div');
    this.root.style.cssText = `
      position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;
      gap:22px;background:radial-gradient(ellipse 60% 40% at 50% 30%, rgba(53,224,195,.08), transparent), #07080F;
      font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#F5F5FA;`;
    this.root.innerHTML = `
      <div style="font-size:46px;font-weight:800;letter-spacing:.3em;text-indent:.3em;color:#35E0C3;text-shadow:0 0 40px rgba(53,224,195,.35);">英雄守卫战</div>
      <div style="font-size:12px;letter-spacing:.5em;text-indent:.5em;color:rgba(245,245,250,.45);">3 D &nbsp;版 · ${levelName}</div>
      <div style="width:120px;height:1px;background:linear-gradient(90deg,transparent,#3D4470,transparent);"></div>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;color:rgba(245,245,250,.75);text-align:center;line-height:1.9;">
        <div><b style="color:#35E0C3;">WASD / 方向键</b> 或 <b style="color:#35E0C3;">按住拖拽</b> —— 移动</div>
        <div>武器自动开火 · <b style="color:#FFD54F;">数字键 1~3</b> 选升级卡</div>
        <div>怪物从地平线裂隙涌来 · <b style="color:#FF3D71;">守住城墙</b></div>
        <div style="font-size:12px;color:rgba(245,245,250,.4);">左下雷达看漏怪 · M 键静音</div>
      </div>
      <button id="start3dbtn" style="margin-top:8px;padding:14px 60px;font-size:19px;border:none;border-radius:999px;
        background:#35E0C3;color:#0B0C1D;font-weight:700;cursor:pointer;letter-spacing:.2em;">开 始 守 城</button>`;
    document.body.appendChild(this.root);
    this.root.querySelector('#start3dbtn')!.addEventListener('click', () => {
      this.root.remove();
      this.onStart?.();
    });
  }
}
