// web/app.ts

installGlobalErrorHooks();

type Mode = "select" | "connect" | "delete";
type SaveFormat = "yb" | "sqlite";
type ImageRenderMode = "optimized" | "high";

/* ---------------------------- Debug + storage shim ---------------------------- */

const DEBUG = true;

async function pyLog(message: string): Promise<void> {
  const msg = `[JS] ${message}`;
  if (DEBUG) console.log(msg);
  try {
    const api = (window as any).pywebview?.api;
    if (api?.log) await api.log(msg);
  } catch {
    // ignore
  }
}

function installGlobalErrorHooks(): void {
  window.addEventListener("error", (e) => {
    void pyLog(`WINDOW ERROR: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    void pyLog(`UNHANDLED REJECTION: ${String((e as any).reason)}`);
  });
}

class StorageShim {
  private mem = new Map<string, string>();
  private enabled = false;
  private reason = "unknown";

  constructor() { this.enabled = this.detect(); }

  private detect(): boolean {
    try {
      const ls = (window as any).localStorage as Storage | null | undefined;
      if (!ls) { this.reason = "localStorage is null/undefined"; return false; }
      const k = "__yb_test__";
      ls.setItem(k, "1"); ls.removeItem(k);
      this.reason = "ok";
      return true;
    } catch (e) {
      this.reason = `exception: ${String(e)}`;
      return false;
    }
  }

  info(): { enabled: boolean; reason: string } { return { enabled: this.enabled, reason: this.reason }; }

  getItem(key: string): string | null {
    if (this.enabled) {
      try { return ((window as any).localStorage as Storage).getItem(key); }
      catch { this.enabled = false; this.reason = "localStorage began failing at runtime"; }
    }
    return this.mem.has(key) ? (this.mem.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    if (this.enabled) {
      try { ((window as any).localStorage as Storage).setItem(key, value); return; }
      catch { this.enabled = false; this.reason = "localStorage began failing at runtime"; }
    }
    this.mem.set(key, value);
  }

  removeItem(key: string): void {
    if (this.enabled) {
      try { ((window as any).localStorage as Storage).removeItem(key); return; }
      catch { this.enabled = false; this.reason = "localStorage began failing at runtime"; }
    }
    this.mem.delete(key);
  }
}

const storage = new StorageShim();

interface KeyItem { id: string; name: string; color: string; }

interface PhotoState {
  id: string;
  name: string;

  // Full-fidelity original (runtime only; not saved)
  fullDataUrl: string;

  // Source path (saved). If present, image is loaded via Python bridge.
  path?: string;
  missing?: boolean;

  // Optional downscaled variants (generated at import / lazily on load)
  medDataUrl?: string;  // ~1024 max dim
  tinyDataUrl?: string; // ~512 max dim

  x: number; y: number; w: number; h: number;
  ar: number;

  el: HTMLDivElement;
  pinEl: HTMLDivElement;
}

interface RopeState {
  id: string;
  aId: string;
  bId: string;
  colorId: string;
  sim: RopeSim;
  lastAx: number; lastAy: number; lastBx: number; lastBy: number;
}

interface BoardObject {
  version: number;
  zoom: number;
  panX: number;
  panY: number;
  locked: boolean;
  showCanvasKey: boolean;
  activeColorId: string | null;
  renderMode?: ImageRenderMode;

  key: Array<{ id: string; name: string; color: string }>;
  photos: Array<{
    id: string;
    name: string;
    dataUrl?: string;      // legacy (embedded full data URL)
    path?: string;         // preferred (filesystem path)
    medDataUrl?: string;
    tinyDataUrl?: string;
    x: number; y: number; w: number; h: number; ar?: number;
  }>;
  ropes: Array<{ id: string; aId: string; bId: string; colorId: string }>;
}

interface PickedImage { name?: string; dataUrl?: string; path?: string; error?: string; }


const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el as unknown as T;
};

function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function clamp(v: number, a: number, b: number): number { return Math.max(a, Math.min(b, v)); }

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 === 0 ? 0 : clamp((apx * abx + apy * aby) / ab2, 0, 1);
  const cx = ax + t * abx, cy = ay + t * aby;
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/* ---------------------------- Path helpers ---------------------------- */

function isAbsoluteFsPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/")) return true;
  if (p.startsWith("\\\\")) return true; // UNC
  // Windows drive
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function dirnameFs(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? "" : p.slice(0, i);
}

function joinFs(baseDir: string, rel: string): string {
  const sep = baseDir.includes("\\") ? "\\" : "/";
  if (!baseDir) return rel;
  if (baseDir.endsWith(sep)) return baseDir + rel;
  return baseDir + sep + rel;
}

function yarnPattern(ctx: CanvasRenderingContext2D, color: string): CanvasPattern {
  const anyCtx = ctx as any;
  if (!anyCtx.__yarnPatterns) anyCtx.__yarnPatterns = new Map<string, CanvasPattern>();
  const cache: Map<string, CanvasPattern> = anyCtx.__yarnPatterns;

  const existing = cache.get(color);
  if (existing) return existing;

  const c = document.createElement("canvas");
  c.width = 48; c.height = 48;
  const g = c.getContext("2d");
  if (!g) throw new Error("No 2D context");

  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);

  for (let i = 0; i < 40; i++) {
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    const len = 6 + Math.random() * 14;
    const ang = (Math.random() * 0.7 - 0.35);
    const x2 = x + Math.cos(ang) * len;
    const y2 = y + Math.sin(ang) * len;

    g.globalAlpha = 0.10 + Math.random() * 0.08;
    g.lineWidth = 0.8 + Math.random() * 0.6;
    g.strokeStyle = "#ffffff";
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x2, y2);
    g.stroke();
  }

  g.globalAlpha = 0.18;
  g.lineWidth = 1.2;
  g.strokeStyle = "#000000";
  for (let i = -12; i < 72; i += 12) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 26, 48);
    g.stroke();
  }
  g.globalAlpha = 1.0;

  const pattern = ctx.createPattern(c, "repeat");
  if (!pattern) throw new Error("Failed to create pattern");
  cache.set(color, pattern);
  return pattern;
}

/* ---------------------------- Modal confirm ---------------------------- */

function confirmDialog(opts: {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const { title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false } = opts;

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.tabIndex = -1;

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    modal.innerHTML = `
      <div class="modal__title">${escapeHtml(title)}</div>
      <div class="modal__body">${escapeHtml(message)}</div>
      <div class="modal__actions">
        <button type="button" class="modal__btn">${escapeHtml(cancelText)}</button>
        <button type="button" class="modal__btn ${danger ? "danger" : "primary"}">${escapeHtml(confirmText)}</button>
      </div>
    `;

    const btns = Array.from(modal.querySelectorAll("button")) as HTMLButtonElement[];
    const cancelBtn = btns[0];
    const confirmBtn = btns[1];

    const cleanup = (val: boolean) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(val);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup(false);
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    window.addEventListener("keydown", onKey);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // focus confirm by default
    confirmBtn.focus();
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tight rope: minimal droop + fast settle */
class RopeSim {
  segments: number;
  points: Array<{ x: number; y: number }> = [];
  prev: Array<{ x: number; y: number }> = [];

  sagFactor = 1.002;
  gravity = 220;
  damping = 0.55;
  iterations = 24;

  asleep = false;
  sleepFrames = 0;
  restLen = 10;

  constructor(segments = 18) { this.segments = segments; }

  reset(ax: number, ay: number, bx: number, by: number) {
    const n = this.segments;
    const dx = (bx - ax) / n;
    const dy = (by - ay) / n;

    this.points = [];
    this.prev = [];
    for (let i = 0; i <= n; i++) {
      const px = ax + dx * i;
      const py = ay + dy * i;
      this.points.push({ x: px, y: py });
      this.prev.push({ x: px, y: py });
    }

    const total = Math.sqrt(dist2(ax, ay, bx, by));
    this.restLen = (total / n) * this.sagFactor;
    this.asleep = false;
    this.sleepFrames = 0;
  }

  wake() { this.asleep = false; this.sleepFrames = 0; }

  step(dt: number, ax: number, ay: number, bx: number, by: number) {
    if (this.points.length === 0) this.reset(ax, ay, bx, by);

    const total = Math.sqrt(dist2(ax, ay, bx, by));
    this.restLen = (total / this.segments) * this.sagFactor;

    this.points[0].x = ax; this.points[0].y = ay;
    this.points[this.points.length - 1].x = bx;
    this.points[this.points.length - 1].y = by;

    if (this.asleep) return;

    const substeps = 2;
    const subDt = dt / substeps;
    let maxMove = 0;

    for (let s = 0; s < substeps; s++) {
      const g = this.gravity * subDt * subDt;

      for (let i = 1; i < this.points.length - 1; i++) {
        const p = this.points[i];
        const pr = this.prev[i];
        const vx = (p.x - pr.x) * this.damping;
        const vy = (p.y - pr.y) * this.damping;
        this.prev[i] = { x: p.x, y: p.y };
        p.x += vx;
        p.y += vy + g;
        const mv = Math.abs(vx) + Math.abs(vy);
        if (mv > maxMove) maxMove = mv;
      }

      for (let k = 0; k < this.iterations; k++) {
        this.points[0].x = ax; this.points[0].y = ay;
        this.points[this.points.length - 1].x = bx;
        this.points[this.points.length - 1].y = by;

        for (let i = 0; i < this.points.length - 1; i++) {
          const p1 = this.points[i];
          const p2 = this.points[i + 1];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
          const diff = (d - this.restLen) / d;

          if (i !== 0) { p1.x += dx * diff * 0.5; p1.y += dy * diff * 0.5; }
          if (i + 1 !== this.points.length - 1) { p2.x -= dx * diff * 0.5; p2.y -= dy * diff * 0.5; }
        }
      }
    }

    if (maxMove < 0.01) {
      this.sleepFrames++;
      if (this.sleepFrames > 8) this.asleep = true;
    } else {
      this.sleepFrames = 0;
    }
  }
}

async function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = dataUrl;
  });
}

/** Downscale a dataUrl to a maximum pixel dimension (keeps aspect ratio). */
async function downscaleDataUrl(dataUrl: string, maxDim: number, mime: string = "image/jpeg", quality = 0.85): Promise<string> {
  const img = await loadImageFromDataUrl(dataUrl);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return dataUrl;

  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  if (scale >= 1) return dataUrl;

  const tw = Math.max(1, Math.round(sw * scale));
  const th = Math.max(1, Math.round(sh * scale));

  const c = document.createElement("canvas");
  c.width = tw;
  c.height = th;
  const g = c.getContext("2d");
  if (!g) return dataUrl;

  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, tw, th);

  try {
    return c.toDataURL(mime, quality);
  } catch {
    // fallback to PNG if jpeg fails for some reason
    return c.toDataURL("image/png");
  }
}



/* -------------------------- Drop Down Select -------------------------- */
/**
 * Replaces a native <select> with a custom dropdown UI for consistent styling across OSes.
 * The original <select> remains in the DOM (hidden) and receives value + change events.
 * There is probably a much better way of doing this but it works for now
 */
class CustomSelectProxy {
  private select: HTMLSelectElement;
  private root: HTMLDivElement;
  private button: HTMLButtonElement;
  private label: HTMLSpanElement;
  private swatch: HTMLSpanElement | null;
  private menu: HTMLDivElement;
  private isOpen = false;
  private showSwatch: boolean;
  private mo: MutationObserver;

  constructor(select: HTMLSelectElement, opts?: { showSwatch?: boolean }) {
    this.select = select;
    this.showSwatch = !!opts?.showSwatch;

    // Hide native select (no OS-controlled popup)
    // Remove any prior proxy for this select (prevents duplicate empty dropdowns)
    const prev = this.select.parentElement?.querySelector(`.cselect[data-for="${this.select.id}"]`) as HTMLDivElement | null;
    if (prev) prev.remove();

    this.select.classList.add("native-select-hidden");

    // Build UI
    this.root = document.createElement("div");
    this.root.className = "cselect";
    this.root.dataset.for = this.select.id;

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "cselect__btn";

    this.swatch = null;
    if (this.showSwatch) {
      const sw = document.createElement("span");
      sw.className = "cselect__swatch";
      this.swatch = sw;
      this.button.appendChild(sw);
    }

    this.label = document.createElement("span");
    this.label.className = "cselect__label";
    this.button.appendChild(this.label);

    const arrow = document.createElement("span");
    arrow.className = "cselect__arrow";
    arrow.textContent = "▾";
    this.button.appendChild(arrow);

    this.menu = document.createElement("div");
    this.menu.className = "cselect__menu";

    this.root.appendChild(this.button);
    this.root.appendChild(this.menu);

    // Insert after select
    this.select.insertAdjacentElement("afterend", this.root);

    // Events
    this.button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });

    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (!this.root.contains(t) && t !== this.select) this.close();
    });
    window.addEventListener("blur", () => this.close());

    this.select.addEventListener("change", () => this.syncFromSelect());

    // Watch option mutations (app rebuilds options)
    this.mo = new MutationObserver(() => this.rebuild());
    this.mo.observe(this.select, { childList: true, subtree: true, characterData: true, attributes: true });

    this.rebuild();
    this.syncFromSelect();
  }

  private toggle() {
    this.isOpen ? this.close() : this.open();
  }

  private open() {
    this.isOpen = true;
    this.root.classList.add("is-open");
  }

  private close() {
    this.isOpen = false;
    this.root.classList.remove("is-open");
  }

  private rebuild() {
    this.menu.innerHTML = "";
    const opts = Array.from(this.select.options);

    for (const o of opts) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cselect__item";
      item.dataset.value = o.value;

      if (this.showSwatch) {
        const sw = document.createElement("span");
        sw.className = "cselect__swatch";
        const c = (o as any).dataset?.color as string | undefined;
        if (c) sw.style.background = c;
        item.appendChild(sw);
      }

      const t = document.createElement("span");
      t.className = "cselect__itemLabel";
      t.textContent = o.textContent || o.value;
      item.appendChild(t);

      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select.value = o.value;
        this.select.dispatchEvent(new Event("change", { bubbles: true }));
        this.close();
      });

      this.menu.appendChild(item);
    }

    this.syncFromSelect();
  }

  private syncFromSelect() {
    const cur = this.select.selectedOptions?.[0] || this.select.options[0];
    if (!cur) {
      this.label.textContent = "";
      if (this.swatch) this.swatch.style.background = "transparent";
      return;
    }
    this.label.textContent = cur.textContent || cur.value;
    if (this.swatch) {
      const c = (cur as any).dataset?.color as string | undefined;
      this.swatch.style.background = c || "transparent";
    }

    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>(".cselect__item"));
    for (const it of items) it.classList.toggle("is-selected", it.dataset.value === cur.value);
  }
}

class YarnBoard {
  app = $("#app") as HTMLDivElement;

  btnToggleSidebar = $("#btnToggleSidebar") as HTMLButtonElement;
  btnAddPhotos = $("#btnAddPhotos") as HTMLButtonElement;
  yarnSelect = $("#yarnSelect") as HTMLSelectElement;

  imageQuality = $("#imageQuality") as HTMLSelectElement;

  modeBtns = {
    select: $("#modeSelect") as HTMLButtonElement,
    connect: $("#modeConnect") as HTMLButtonElement,
    delete: $("#modeDelete") as HTMLButtonElement,
  };

  keyPanelSidebar = $("#keyPanelSidebar") as HTMLDivElement;
  keyListSidebar = $("#keyListSidebar") as HTMLDivElement;
  btnAddKeyItem = $("#btnAddKeyItem") as HTMLButtonElement;

  btnSave = $("#btnSave") as HTMLButtonElement;
  btnLoad = $("#btnLoad") as HTMLButtonElement;
  saveFormat = $("#saveFormat") as HTMLSelectElement;
  statusLine = $("#statusLine") as HTMLDivElement;
  bridgeHint = $("#bridgeHint") as HTMLDivElement;

  fileInputImages = $("#fileInputImages") as HTMLInputElement;
  fileInputBoard = $("#fileInputBoard") as HTMLInputElement;

  board = $("#board") as HTMLDivElement;
  canvas = $("#yarnCanvas") as HTMLCanvasElement;
  ctx = this.canvas.getContext("2d")!;
  photosLayer = $("#photosLayer") as HTMLDivElement;
  pinsLayer = $("#pinsLayer") as HTMLDivElement;
  empty = $("#emptyState") as HTMLDivElement;

  canvasKey = $("#canvasKey") as HTMLDivElement;
  canvasKeyList = $("#canvasKeyList") as HTMLDivElement;

  zoomSlider = $("#zoomSlider") as HTMLInputElement;
  zoomLabel = $("#zoomLabel") as HTMLDivElement;
  zoomInBtn = $("#zoomIn") as HTMLButtonElement;
  zoomOutBtn = $("#zoomOut") as HTMLButtonElement;

  btnCenter = $("#btnCenter") as HTMLButtonElement;
  btnLock = $("#btnLock") as HTMLButtonElement;
  btnToggleCanvasKey = $("#btnToggleCanvasKey") as HTMLButtonElement;
  btnClearCanvas = $("#btnClearCanvas") as HTMLButtonElement;
  lockIconWrap = $("#lockIconWrap") as HTMLSpanElement;
  lockLabel = $("#lockLabel") as HTMLSpanElement;

  mode: Mode = "select";
  zoom = 1.0;
  panX = 0;
  panY = 0;
  locked = false;
  showCanvasKey = false;

  renderMode: ImageRenderMode = "optimized";

  // When opening/saving via the Python bridge we remember the board's folder so
  // relative image paths can be resolved.
  boardFilePath: string | null = null;
  boardDir: string | null = null;

  photos = new Map<string, PhotoState>();
  ropes: RopeState[] = [];

  key: KeyItem[] = [];
  activeColorId: string | null = null;

  selectedPhotoId: string | null = null;
  selectedRopeId: string | null = null;

  connectStartPhotoId: string | null = null;
  connectMouseWorld: { x: number; y: number } | null = null;
  previewSim = new RopeSim(18);

  drag: null | { pid: string; startX: number; startY: number; origX: number; origY: number; pointerId: number } = null;
  resize: null | { pid: string; corner: "tl" | "tr" | "bl" | "br"; fixedX: number; fixedY: number; pointerId: number } = null;
  panDrag: null | { startClientX: number; startClientY: number; origPanX: number; origPanY: number; pointerId: number } = null;

  pyApi: any = null;
  lastT = performance.now();

  ro: ResizeObserver;

  constructor() {
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    this.initDefaults();
    this.bindUI();

    // Replace native selects with custom dropdowns for consistent styling
    new CustomSelectProxy(this.yarnSelect, { showSwatch: true });
    new CustomSelectProxy(this.imageQuality, { showSwatch: false });
    new CustomSelectProxy(this.saveFormat, { showSwatch: false });

    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());

    this.ro = new ResizeObserver(() => this.resizeCanvas());
    this.ro.observe(this.board);

    requestAnimationFrame((t) => this.tick(t));
  }

  setStatus(text: string) { this.statusLine.textContent = text; }

  applyViewport() {
    const tf = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.photosLayer.style.transform = tf;
    this.pinsLayer.style.transform = tf;
    this.canvasKey.hidden = !this.showCanvasKey;
  }

  setZoom(z: number, { persist = true } = {}) {
    this.zoom = clamp(z, 0.25, 2.0);
    const pct = Math.round(this.zoom * 100);
    this.zoomSlider.value = String(pct);
    this.zoomLabel.textContent = `${pct}%`;

    this.applyViewport();
    this.refreshAllPhotoBackgrounds(); // important for optimized mode
    for (const r of this.ropes) r.sim.wake();
    this.previewSim.wake();

    if (persist) this.persist();
  }

  setPan(px: number, py: number, { persist = true } = {}) {
    this.panX = px; this.panY = py;
    this.applyViewport();
    if (persist) this.persist();
  }

  setLocked(v: boolean, { persist = true } = {}) {
    this.locked = v;

    const lockSvg = (locked: boolean) =>
      locked
        ? `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
             <path d="M7 11V8a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             <path d="M6 11h12v10H6z" fill="none" stroke="currentColor" stroke-width="2" />
           </svg>`
        : `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
             <path d="M9 11V8a5 5 0 0 1 9.5-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
             <path d="M6 11h12v10H6z" fill="none" stroke="currentColor" stroke-width="2" />
           </svg>`;

    this.lockIconWrap.innerHTML = lockSvg(v);
    this.lockLabel.textContent = v ? "Locked" : "Edit";
    this.setStatus(v ? "Editing locked." : "Editing unlocked.");
    if (persist) this.persist();
  }

  persist() { storage.setItem("yarnboard_state", JSON.stringify(this.toObject())); }

  toObject(): BoardObject {
    return {
      version: 3,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      locked: this.locked,
      showCanvasKey: this.showCanvasKey,
      activeColorId: this.activeColorId,
      renderMode: this.renderMode,
      key: this.key.map((k) => ({ id: k.id, name: k.name, color: k.color })),
      photos: Array.from(this.photos.values()).map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        x: p.x, y: p.y, w: p.w, h: p.h, ar: p.ar,
      })),
      ropes: this.ropes.map((r) => ({ id: r.id, aId: r.aId, bId: r.bId, colorId: r.colorId })),
    };
  }

  initDefaults() {
    const saved = safeJsonParse<BoardObject | null>(storage.getItem("yarnboard_state") || "null", null);
    if (saved) {
      this.loadFromObject(saved, { quiet: true });
      this.setStatus("Loaded from local cache.");
      return;
    }

    this.key = [
      { id: uid("col"), name: "Red", color: "#ff3b3b" },
      { id: uid("col"), name: "Blue", color: "#3b82f6" },
      { id: uid("col"), name: "Green", color: "#22c55e" },
      { id: uid("col"), name: "Yellow", color: "#facc15" },
      { id: uid("col"), name: "Black", color: "#111827" },
    ];
    this.activeColorId = this.key[0].id;

    this.renderMode = "optimized";
    this.imageQuality.value = this.renderMode;

    this.renderKeyUI();
    this.renderYarnSelect();
    this.renderCanvasKey();

    this.showCanvasKey = false;
    this.setLocked(false, { persist: false });
    this.setZoom(1.0, { persist: false });
    this.setPan(0, 0, { persist: false });
    this.applyViewport();
    this.updateEmptyState();
  }

  loadFromObject(obj: BoardObject, { quiet = false } = {}) {
    this.photosLayer.innerHTML = "";
    this.pinsLayer.innerHTML = "";
    this.photos.clear();
    this.ropes = [];
    this.selectNone();

    this.key = Array.isArray(obj.key) ? obj.key : [];
    this.activeColorId = obj.activeColorId || (this.key[0] && this.key[0].id) || null;

    this.renderMode = (obj.renderMode === "high" || obj.renderMode === "optimized") ? obj.renderMode : "optimized";
    this.imageQuality.value = this.renderMode;

    if (Array.isArray(obj.photos)) {
      for (const p of obj.photos) {
        const legacyDataUrl = (p as any).dataUrl as string | undefined;
        const path = (p as any).path as string | undefined;

        const pid = this.addPhotoFromData(
          p.name,
          legacyDataUrl ?? "",
          p.x, p.y, p.w, p.h,
          p.id,
          p.ar,
          (p as any).medDataUrl,
          (p as any).tinyDataUrl,
          path
        );

        if (!legacyDataUrl && path) {
          const abs = (!isAbsoluteFsPath(path) && this.boardDir) ? joinFs(this.boardDir, path) : path;
          void this.resolvePhotoImage(pid, abs);
        }
        if (!legacyDataUrl && !path) this.markPhotoMissing(pid, p.name);
      }
    }

    if (Array.isArray(obj.ropes)) {
      for (const r of obj.ropes) {
        const a = this.getAnchor(r.aId);
        const b = this.getAnchor(r.bId);
        if (!a || !b) continue;

        const sim = new RopeSim(18);
        sim.reset(a.x, a.y, b.x, b.y);

        this.ropes.push({
          id: r.id || uid("rope"),
          aId: r.aId,
          bId: r.bId,
          colorId: r.colorId || (this.activeColorId ?? ""),
          sim,
          lastAx: a.x, lastAy: a.y, lastBx: b.x, lastBy: b.y,
        });
      }
    }

    this.renderKeyUI();
    this.renderYarnSelect();
    this.renderCanvasKey();
    this.updateEmptyState();

    this.showCanvasKey = !!obj.showCanvasKey;
    this.setLocked(!!obj.locked, { persist: false });
    this.setZoom(obj.zoom ?? 1.0, { persist: false });
    this.setPan(obj.panX ?? 0, obj.panY ?? 0, { persist: false });
    this.applyViewport();
    this.refreshAllPhotoBackgrounds();

    if (!quiet) this.setStatus("Loaded board.");
    this.persist();
  }

  clearBoard() {
    // Keep key/colors + view settings; remove all board content.
    this.photosLayer.innerHTML = "";
    this.pinsLayer.innerHTML = "";
    this.photos.clear();
    this.ropes = [];
    this.selectNone();
    this.connectStartPhotoId = null;
    this.connectMouseWorld = null;
    this.updateEmptyState();
    this.persist();
  }

  async detectBridge() {
    await Promise.race<string>([
      new Promise((res) => window.addEventListener("pywebviewready", () => res("pywebview"), { once: true })),
      new Promise((res) => setTimeout(() => res("fallback"), 300)),
    ]);

    this.pyApi = (window as any).pywebview?.api ?? null;
    const st = storage.info();
    void pyLog(`Storage: ${st.enabled} (${st.reason})`);

    if (!this.pyApi) {
      this.bridgeHint.hidden = false;
      this.setStatus("Bridge not detected; fallback mode.");
    } else {
      this.setStatus("Bridge ready.");
    }
  }

  bindUI() {
    void this.detectBridge();

    this.btnToggleSidebar.addEventListener("click", () => {
      this.app.classList.toggle("is-collapsed");
      requestAnimationFrame(() => this.resizeCanvas());
    });

    this.btnAddKeyItem.addEventListener("click", () => {
      const item: KeyItem = { id: uid("col"), name: "New color", color: "#a78bfa" };
      this.key.push(item);
      this.activeColorId = item.id;
      this.renderKeyUI();
      this.renderYarnSelect();
      this.renderCanvasKey();
      this.persist();
    });

    // Image rendering mode
    this.imageQuality.addEventListener("change", () => {
      const v = this.imageQuality.value === "high" ? "high" : "optimized";
      this.renderMode = v;
      this.refreshAllPhotoBackgrounds();
      this.persist();
      this.setStatus(v === "high" ? "High resolution images enabled." : "Optimized image rendering enabled.");
    });

    // Add photos
    this.btnAddPhotos.addEventListener("click", async () => {
      if (this.pyApi?.pick_images) this.ingestPickedImages(await this.pyApi.pick_images());
      else this.fileInputImages.click();
    });

    this.fileInputImages.addEventListener("change", async () => {
      const files = Array.from(this.fileInputImages.files ?? []);
      const out: PickedImage[] = [];
      for (const f of files) {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(new Error("FileReader failed"));
          r.readAsDataURL(f);
        });
        out.push({ name: f.name, dataUrl });
      }
      this.ingestPickedImages(out);
      this.fileInputImages.value = "";
    });

    // Save / Open
    this.btnSave.addEventListener("click", async () => {
      const json = JSON.stringify(this.toObject(), null, 2);
      const fmt = (this.saveFormat.value as SaveFormat) || "yb";

      if (this.pyApi?.save_board) {
        const res = await this.pyApi.save_board(fmt, json);
        if (res?.ok) {
          if (res.path) {
            this.boardFilePath = String(res.path);
            this.boardDir = dirnameFs(this.boardFilePath);
          }
          this.setStatus("Saved board.");
        }
        else if (res?.cancelled) this.setStatus("Save cancelled.");
        else this.setStatus(`Save failed: ${res?.error ?? "unknown error"}`);
        return;
      }

      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "yarnboard.json";
      a.click();
      URL.revokeObjectURL(url);
      this.setStatus("Downloaded yarnboard.json (fallback).");
    });

    this.btnLoad.addEventListener("click", async () => {
      if (this.pyApi?.load_board) {
        const res = await this.pyApi.load_board();
        if (res?.ok && res.json) {
          if (res.path) {
            this.boardFilePath = String(res.path);
            this.boardDir = dirnameFs(this.boardFilePath);
          }
          const obj = safeJsonParse<BoardObject | null>(res.json, null);
          if (!obj) { this.setStatus("Invalid board file."); return; }
          this.loadFromObject(obj);
          this.setStatus(`Opened: ${res.path ?? "board"}`);
          return;
        }
        if (res?.cancelled) { this.setStatus("Open cancelled."); return; }
        this.setStatus(`Open failed: ${res?.error ?? "unknown error"}`);
        return;
      }
      this.fileInputBoard.click();
    });

    this.fileInputBoard.addEventListener("change", async () => {
      const f = (this.fileInputBoard.files ?? [])[0];
      if (!f) return;
      const text = await f.text();
      const obj = safeJsonParse<BoardObject | null>(text, null);
      if (!obj) this.setStatus("Invalid JSON.");
      else { this.loadFromObject(obj); this.setStatus("Opened JSON (fallback)."); }
      this.fileInputBoard.value = "";
    });

    // Mode buttons
    this.modeBtns.select.addEventListener("click", () => this.setMode("select"));
    this.modeBtns.connect.addEventListener("click", () => this.setMode("connect"));
    this.modeBtns.delete.addEventListener("click", () => this.setMode("delete"));

    // Yarn color
    this.yarnSelect.addEventListener("change", () => {
      this.activeColorId = this.yarnSelect.value;
      if (this.selectedRopeId) {
        const rope = this.ropes.find((r) => r.id === this.selectedRopeId);
        if (rope) rope.colorId = this.activeColorId ?? rope.colorId;
      }
      this.persist();
    });

    // Zoom
    this.zoomSlider.addEventListener("input", () => {
      const pct = clamp(parseInt(this.zoomSlider.value, 10), 25, 200);
      this.setZoom(pct / 100);
    });
    this.zoomInBtn.addEventListener("click", () => this.setZoom(this.zoom + 0.1));
    this.zoomOutBtn.addEventListener("click", () => this.setZoom(this.zoom - 0.1));

    this.board.addEventListener("wheel", (e) => {
      e.preventDefault();
      const step = 0.05;
      this.setZoom(this.zoom + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    // Bottom bar
    this.btnCenter.addEventListener("click", () => this.centerContent());
    this.btnLock.addEventListener("click", () => this.setLocked(!this.locked));
    this.btnToggleCanvasKey.addEventListener("click", () => {
      this.showCanvasKey = !this.showCanvasKey;
      this.applyViewport();
      this.persist();
    });

    this.btnClearCanvas.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Clear board",
        message: "Remove all photos, pins and yarn from this board? This cannot be undone.",
        confirmText: "Clear",
        cancelText: "Cancel",
        danger: true,
      });
      if (!ok) return;
      this.clearBoard();
      this.setStatus("Cleared board.");
    });

    // Pointer handlers
    this.board.addEventListener("pointerdown", (e) => this.onPointerDown(e), { capture: true });
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", () => this.onPointerUp());

    // Keyboard
    window.addEventListener("keydown", (e) => {
      if (e.key === "v" || e.key === "V") this.setMode("select");
      if (e.key === "c" || e.key === "C") this.setMode("connect");
      if (e.key === "Escape") { this.connectStartPhotoId = null; this.connectMouseWorld = null; this.setStatus("Connect cancelled."); }
      if (e.key === "Delete" || e.key === "Backspace") this.deleteSelection();
    });
  }

  setMode(mode: Mode) {
    this.mode = mode;
    (Object.keys(this.modeBtns) as Mode[]).forEach((k) => this.modeBtns[k].classList.toggle("is-active", k === mode));
    if (mode !== "connect") { this.connectStartPhotoId = null; this.connectMouseWorld = null; }
    this.persist();
  }

  ingestPickedImages(picked: PickedImage[]) {
    const good = (picked || []).filter((p) => p && p.dataUrl && !p.error) as Array<{ name?: string; dataUrl: string; path?: string }>;
    if (!good.length) { this.setStatus("No images selected."); return; }

    let x = 40, y = 70;
    for (const img of good) {
      this.addPhotoFromData(img.name || "photo", img.dataUrl, x, y, 240, 180, null, undefined, undefined, undefined, img.path);
      x += 260;
      if (x > 900) { x = 40; y += 220; }
    }

    this.updateEmptyState();
    this.persist();
    this.setStatus(`Added ${good.length} photo(s).`);
  }

  addPhotoFromData(
    name: string,
    fullDataUrl: string,
    x = 60,
    y = 60,
    w = 240,
    h = 180,
    fixedId: string | null = null,
    arFromFile?: number,
    medDataUrl?: string,
    tinyDataUrl?: string,
    sourcePath?: string
  ): string {
    const id = fixedId || uid("photo");

    const el = document.createElement("div");
    el.className = "photo";
    el.dataset.photoId = id;

    // handles
    const corners: Array<"tl" | "tr" | "bl" | "br"> = ["tl", "tr", "bl", "br"];
    for (const c of corners) {
      const hEl = document.createElement("div");
      hEl.className = "resize-handle";
      hEl.dataset.corner = c;
      hEl.title = "Resize";
      el.appendChild(hEl);
    }

    const title = document.createElement("div");
    title.className = "photo__title";
    title.textContent = name;
    el.appendChild(title);

    this.photosLayer.appendChild(el);

    const pinEl = document.createElement("div");
    pinEl.className = "pin";
    pinEl.dataset.photoId = id;
    pinEl.dataset.pin = "1";
    pinEl.title = "Pin (select / drag / connect)";
    this.pinsLayer.appendChild(pinEl);

    const arDefault = arFromFile && arFromFile > 0 ? arFromFile : (w > 0 && h > 0 ? w / h : 4 / 3);

    const p: PhotoState = {
      id,
      name,
      fullDataUrl,
      path: sourcePath,
      missing: false,
      medDataUrl,
      tinyDataUrl,
      x, y, w, h,
      ar: arDefault,
      el, pinEl
    };
    this.photos.set(id, p);

    // Generate AR + variants if needed (async, but safe)
    void this.ensureVariants(p);

    this.layoutPhoto(p);
    return id;
  }

  private async ensureVariants(p: PhotoState): Promise<void> {
    try {
      // Determine intrinsic AR first
      const img = await loadImageFromDataUrl(p.fullDataUrl);
      const sw = img.naturalWidth || img.width;
      const sh = img.naturalHeight || img.height;
      if (sw && sh) {
        const ar = sw / sh;
        if (isFinite(ar) && ar > 0) {
          p.ar = ar;
          // keep current width, adjust height to match AR (prevents stretch)
          p.h = Math.round(p.w / p.ar);
          this.layoutPhoto(p);
        }
      }

      // If variants already present (loaded from file), keep them
      if (!p.medDataUrl) p.medDataUrl = await downscaleDataUrl(p.fullDataUrl, 1024);
      if (!p.tinyDataUrl) p.tinyDataUrl = await downscaleDataUrl(p.fullDataUrl, 512);

      // Apply best background for current mode/size
      this.applyPhotoBackground(p);
      this.persist();
    } catch {
      // if variant generation fails, just use full
      this.applyPhotoBackground(p);
    }
  }

  private markPhotoMissing(photoId: string, name: string): void {
    const p = this.photos.get(photoId);
    if (!p) return;
    p.missing = true;
    p.el.style.backgroundImage = "none";
    p.el.style.background = "linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04))";
    p.el.style.outline = "1px dashed rgba(255,255,255,0.25)";
    const title = p.el.querySelector(".photo__title") as HTMLDivElement | null;
    if (title) title.textContent = `Missing: ${name}`;
  }

  async resolvePhotoImage(photoId: string, path: string): Promise<void> {
    const p = this.photos.get(photoId);
    if (!p) return;

    try {
      const api = (window as any).pywebview?.api;
      if (!api?.read_image_dataurl) {
        void pyLog("resolvePhotoImage: read_image_dataurl not available");
        this.markPhotoMissing(photoId, p.name);
        return;
      }

      const res = await api.read_image_dataurl(path);
      if (!res?.ok || !res?.dataUrl) {
        void pyLog(`resolvePhotoImage failed for ${path}: ${res?.error ?? "unknown"}`);
        this.markPhotoMissing(photoId, p.name);
        return;
      }

      p.fullDataUrl = res.dataUrl;
      p.missing = false;
      p.el.style.backgroundImage = `url("${this.getPhotoBackground(p)}")`;
      void this.ensureVariants(p);
    } catch (e) {
      void pyLog(`resolvePhotoImage exception: ${String(e)}`);
      this.markPhotoMissing(photoId, p.name);
    }
  }

  private getPhotoBackground(p: PhotoState): string {
    // Backwards-compatible alias used in some call sites
    return this.chooseDataUrlForDisplay(p);
  }


  private chooseDataUrlForDisplay(p: PhotoState): string {
    if (this.renderMode === "high") return p.fullDataUrl;

    // Optimized mode: choose based on on-screen pixel size
    const dpr = window.devicePixelRatio || 1;
    const onScreenMaxPx = Math.max(p.w, p.h) * this.zoom * dpr;

    // thresholds tuned for “tiny photos don’t need massive textures”
    if (onScreenMaxPx <= 520 && p.tinyDataUrl) return p.tinyDataUrl;
    if (onScreenMaxPx <= 1100 && p.medDataUrl) return p.medDataUrl;

    return p.fullDataUrl;
  }

  private applyPhotoBackground(p: PhotoState) {
    const url = this.chooseDataUrlForDisplay(p);
    p.el.style.backgroundImage = `url(${url})`;
  }

  private refreshAllPhotoBackgrounds() {
    for (const p of this.photos.values()) this.applyPhotoBackground(p);
  }

  layoutPhoto(p: PhotoState) {
    p.el.style.left = `${p.x}px`;
    p.el.style.top = `${p.y}px`;
    p.el.style.width = `${p.w}px`;
    p.el.style.height = `${p.h}px`;

    // update background choice (important after resize/zoom)
    this.applyPhotoBackground(p);

    const anchor = this.getAnchor(p.id);
    if (anchor) {
      p.pinEl.style.left = `${anchor.x}px`;
      p.pinEl.style.top = `${anchor.y}px`;
    }

    for (const r of this.ropes) if (r.aId === p.id || r.bId === p.id) r.sim.wake();
    this.previewSim.wake();
  }

  updateEmptyState() { this.empty.style.display = this.photos.size ? "none" : "grid"; }

  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.board.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  getAnchor(photoId: string): { x: number; y: number } | null {
    const p = this.photos.get(photoId);
    if (!p) return null;
    return { x: p.x + p.w / 2, y: p.y - 10 };
  }

  selectNone() {
    this.selectedPhotoId = null;
    this.selectedRopeId = null;
    for (const p of this.photos.values()) p.el.classList.remove("is-selected");
  }

  selectPhoto(id: string) {
    this.selectedPhotoId = id;
    this.selectedRopeId = null;
    for (const p of this.photos.values()) p.el.classList.toggle("is-selected", p.id === id);
  }

  selectRope(id: string) {
    this.selectedRopeId = id;
    this.selectedPhotoId = null;
    for (const p of this.photos.values()) p.el.classList.remove("is-selected");
  }

  private computeARRectFromFixed(
    fx: number, fy: number, dragX: number, dragY: number,
    corner: "tl" | "tr" | "bl" | "br",
    ar: number,
    minW: number, minH: number, maxW: number, maxH: number
  ): { x: number; y: number; w: number; h: number } {
    const dxAbs = Math.max(1, Math.abs(dragX - fx));
    const dyAbs = Math.max(1, Math.abs(dragY - fy));

    let wA = clamp(dxAbs, minW, maxW);
    let hA = wA / ar;
    if (hA < minH) { hA = minH; wA = hA * ar; }
    if (hA > maxH) { hA = maxH; wA = hA * ar; }

    let hB = clamp(dyAbs, minH, maxH);
    let wB = hB * ar;
    if (wB < minW) { wB = minW; hB = wB / ar; }
    if (wB > maxW) { wB = maxW; hB = wB / ar; }

    const cornerPos = (w: number, h: number) => {
      switch (corner) {
        case "br": return { cx: fx + w, cy: fy + h, x: fx, y: fy };
        case "tl": return { cx: fx - w, cy: fy - h, x: fx - w, y: fy - h };
        case "tr": return { cx: fx + w, cy: fy - h, x: fx, y: fy - h };
        case "bl": return { cx: fx - w, cy: fy + h, x: fx - w, y: fy };
      }
    };

    const a = cornerPos(wA, hA);
    const b = cornerPos(wB, hB);

    const dA = dist2(dragX, dragY, a.cx, a.cy);
    const dB = dist2(dragX, dragY, b.cx, b.cy);

    if (dA <= dB) return { x: a.x, y: a.y, w: Math.round(wA), h: Math.round(hA) };
    return { x: b.x, y: b.y, w: Math.round(wB), h: Math.round(hB) };
  }

  onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    if (target.closest(".ui-overlay") || target.closest(".sidebar") || target.closest(".canvas-key")) return;

    const world = this.clientToWorld(e.clientX, e.clientY);

    // resize handles first
    const handleEl = target.closest(".resize-handle") as HTMLElement | null;
    if (handleEl) {
      if (this.locked || this.mode !== "select") return;

      const photoEl = handleEl.closest(".photo") as HTMLDivElement | null;
      if (!photoEl) return;

      const pid = photoEl.dataset.photoId!;
      const corner = (handleEl.dataset.corner as any) as "tl" | "tr" | "bl" | "br";
      const p = this.photos.get(pid);
      if (!p) return;

      this.selectPhoto(pid);

      let fixedX = p.x, fixedY = p.y;
      if (corner === "tl") { fixedX = p.x + p.w; fixedY = p.y + p.h; }
      else if (corner === "tr") { fixedX = p.x; fixedY = p.y + p.h; }
      else if (corner === "bl") { fixedX = p.x + p.w; fixedY = p.y; }
      else if (corner === "br") { fixedX = p.x; fixedY = p.y; }

      this.resize = { pid, corner, fixedX, fixedY, pointerId: e.pointerId };
      handleEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // pin
    const pinEl = target.closest("[data-pin='1']") as HTMLElement | null;
    if (pinEl) {
      const pid = pinEl.dataset.photoId!;
      if (!pid) return;

      if (this.mode === "delete") {
        if (!this.locked) this.deletePhoto(pid);
        return;
      }

      if (this.mode === "connect") {
        if (this.locked) return;

        if (!this.connectStartPhotoId) {
          this.connectStartPhotoId = pid;
          this.connectMouseWorld = { x: world.x, y: world.y };
          const a = this.getAnchor(pid);
          if (a) this.previewSim.reset(a.x, a.y, world.x, world.y);
          this.setStatus("Click another pin to connect.");
        } else if (this.connectStartPhotoId !== pid) {
          this.createRope(this.connectStartPhotoId, pid, this.activeColorId ?? "");
          this.connectStartPhotoId = null;
          this.connectMouseWorld = null;
          this.persist();
          this.setStatus("Connected.");
        }
        return;
      }

      if (this.mode === "select") {
        if (this.locked) return;
        this.selectPhoto(pid);
        const p = this.photos.get(pid);
        if (!p) return;

        this.drag = { pid, startX: world.x, startY: world.y, origX: p.x, origY: p.y, pointerId: e.pointerId };
        pinEl.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }

    // rope hit-test
    const ropeHit = this.hitTestRope(world.x, world.y);
    if (ropeHit) {
      if (this.mode === "delete" && !this.locked) this.deleteRope(ropeHit.id);
      else { this.selectRope(ropeHit.id); this.setStatus("Rope selected. Press Delete to remove."); }
      return;
    }

    // clicking photo body
    const photoEl = target.closest(".photo") as HTMLDivElement | null;
    if (photoEl) {
      const pid = photoEl.dataset.photoId;

      // When in delete mode clicking the photo deletes it instead of clicking the pin above it
      if (this.mode === "delete") {
        if (!this.locked && pid) this.deletePhoto(pid);
        return;
      }

      if (this.selectedRopeId) this.selectNone();
      return;
    }

    // background pan (cursor changes via .is-panning)
    this.selectNone();
    this.panDrag = { startClientX: e.clientX, startClientY: e.clientY, origPanX: this.panX, origPanY: this.panY, pointerId: e.pointerId };
    this.board.classList.add("is-panning");
    this.board.setPointerCapture(e.pointerId);
  }

  onPointerMove(e: PointerEvent) {
    if (this.mode === "connect" && this.connectStartPhotoId) {
      const w = this.clientToWorld(e.clientX, e.clientY);
      this.connectMouseWorld = { x: w.x, y: w.y };
      this.previewSim.wake();
    }

    if (this.panDrag) {
      const dx = e.clientX - this.panDrag.startClientX;
      const dy = e.clientY - this.panDrag.startClientY;
      this.setPan(this.panDrag.origPanX + dx, this.panDrag.origPanY + dy, { persist: false });
      return;
    }

    if (this.drag) {
      const p = this.photos.get(this.drag.pid);
      if (!p) return;
      const w = this.clientToWorld(e.clientX, e.clientY);
      p.x = this.drag.origX + (w.x - this.drag.startX);
      p.y = this.drag.origY + (w.y - this.drag.startY);
      this.layoutPhoto(p);
      return;
    }

    if (this.resize) {
      const p = this.photos.get(this.resize.pid);
      if (!p) return;

      const w = this.clientToWorld(e.clientX, e.clientY);
      const fx = this.resize.fixedX;
      const fy = this.resize.fixedY;

      const rect = this.computeARRectFromFixed(
        fx, fy, w.x, w.y,
        this.resize.corner,
        p.ar || 4 / 3,
        140, 110, 1400, 1200
      );

      p.x = rect.x; p.y = rect.y; p.w = rect.w; p.h = rect.h;
      this.layoutPhoto(p);
      return;
    }
  }

  onPointerUp() {
    if (this.panDrag) { this.panDrag = null; this.persist(); }
    if (this.drag) { this.drag = null; this.persist(); }
    if (this.resize) { this.resize = null; this.persist(); }

    this.board.classList.remove("is-panning");
  }

  createRope(aId: string, bId: string, colorId: string) {
    const exists = this.ropes.some((r) => (r.aId === aId && r.bId === bId) || (r.aId === bId && r.bId === aId));
    if (exists) { this.setStatus("Already connected."); return; }

    const a = this.getAnchor(aId);
    const b = this.getAnchor(bId);
    if (!a || !b) return;

    const sim = new RopeSim(18);
    sim.reset(a.x, a.y, b.x, b.y);

    const rope: RopeState = {
      id: uid("rope"),
      aId, bId,
      colorId: colorId || (this.activeColorId ?? ""),
      sim,
      lastAx: a.x, lastAy: a.y, lastBx: b.x, lastBy: b.y,
    };
    this.ropes.push(rope);
    this.selectRope(rope.id);
  }

  deleteRope(ropeId: string) {
    this.ropes = this.ropes.filter((r) => r.id !== ropeId);
    if (this.selectedRopeId === ropeId) this.selectedRopeId = null;
    this.persist();
    this.setStatus("Rope deleted.");
  }

  deletePhoto(photoId: string) {
    const p = this.photos.get(photoId);
    if (!p) return;
    this.ropes = this.ropes.filter((r) => r.aId !== photoId && r.bId !== photoId);
    p.el.remove(); p.pinEl.remove();
    this.photos.delete(photoId);
    if (this.selectedPhotoId === photoId) this.selectedPhotoId = null;
    this.updateEmptyState();
    this.persist();
    this.setStatus("Photo deleted.");
  }

  deleteSelection() {
    if (this.locked) return;
    if (this.selectedPhotoId) this.deletePhoto(this.selectedPhotoId);
    else if (this.selectedRopeId) this.deleteRope(this.selectedRopeId);
  }

  hitTestRope(wx: number, wy: number): RopeState | null {
    let best: RopeState | null = null;
    let bestD = Infinity;
    const threshold = 10 / this.zoom;

    for (const r of this.ropes) {
      const pts = r.sim.points;
      if (!pts || pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const d = pointSegmentDistance(wx, wy, a.x, a.y, b.x, b.y);
        if (d < bestD) { bestD = d; best = r; }
      }
    }
    return best && bestD <= threshold ? best : null;
  }

  renderYarnSelect() {
    this.yarnSelect.innerHTML = "";
    for (const item of this.key) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name;
      opt.dataset.color = item.color;
      this.yarnSelect.appendChild(opt);
    }
    if (this.activeColorId) this.yarnSelect.value = this.activeColorId;
  }

  renderKeyUI() {
    this.keyListSidebar.innerHTML = "";

    for (const item of this.key) {
      const row = document.createElement("div");
      row.className = "key-item";

      const color = document.createElement("input");
      color.type = "color";
      color.value = item.color;
      color.addEventListener("input", () => {
        item.color = color.value;
        this.renderYarnSelect();
        this.renderCanvasKey();
        this.persist();
      });

      const name = document.createElement("input");
      name.type = "text";
      name.value = item.name;
      name.addEventListener("input", () => {
        item.name = name.value;
        this.renderYarnSelect();
        this.renderCanvasKey();
        this.persist();
      });

      const del = document.createElement("button");
      del.className = "trash";
      del.type = "button";
      del.textContent = "X";
      del.addEventListener("click", () => {
        if (this.key.length <= 1) return;

        const removedId = item.id;
        this.key = this.key.filter((k) => k.id !== removedId);

        const fallbackId = this.key[0].id;
        for (const r of this.ropes) if (r.colorId === removedId) r.colorId = fallbackId;
        if (this.activeColorId === removedId) this.activeColorId = fallbackId;

        this.renderKeyUI();
        this.renderYarnSelect();
        this.renderCanvasKey();
        this.persist();
      });

      row.appendChild(color);
      row.appendChild(name);
      row.appendChild(del);
      this.keyListSidebar.appendChild(row);
    }
  }

  renderCanvasKey() {
    this.canvasKeyList.innerHTML = "";
    for (const item of this.key) {
      const row = document.createElement("div");
      row.className = "canvas-key-item";

      const sw = document.createElement("div");
      sw.className = "canvas-key-swatch";
      sw.style.background = item.color;

      const txt = document.createElement("div");
      txt.textContent = item.name;

      row.appendChild(sw);
      row.appendChild(txt);
      this.canvasKeyList.appendChild(row);
    }
  }

  resizeCanvas() {
    const r = this.board.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(r.width * dpr);
    const h = Math.floor(r.height * dpr);

    if (this.canvas.width === w && this.canvas.height === h) return;

    this.canvas.width = w;
    this.canvas.height = h;

    for (const rope of this.ropes) rope.sim.wake();
    this.previewSim.wake();
  }

  tick(t: number) {
    const dt = clamp((t - this.lastT) / 1000, 0, 0.025);
    this.lastT = t;

    this.step(dt);
    this.draw();

    requestAnimationFrame((tt) => this.tick(tt));
  }

  step(dt: number) {
    for (const r of this.ropes) {
      const a = this.getAnchor(r.aId);
      const b = this.getAnchor(r.bId);
      if (!a || !b) continue;

      const moved =
        dist2(a.x, a.y, r.lastAx, r.lastAy) > 0.0001 ||
        dist2(b.x, b.y, r.lastBx, r.lastBy) > 0.0001;

      if (moved) {
        r.sim.wake();
        r.lastAx = a.x; r.lastAy = a.y; r.lastBx = b.x; r.lastBy = b.y;
      }

      r.sim.step(dt, a.x, a.y, b.x, b.y);
    }

    if (this.mode === "connect" && this.connectStartPhotoId && this.connectMouseWorld) {
      const a = this.getAnchor(this.connectStartPhotoId);
      const b = this.connectMouseWorld;
      if (a) {
        if (this.previewSim.points.length === 0) this.previewSim.reset(a.x, a.y, b.x, b.y);
        this.previewSim.step(dt, a.x, a.y, b.x, b.y);
      }
    } else {
      this.previewSim.points = [];
      this.previewSim.prev = [];
      this.previewSim.asleep = false;
      this.previewSim.sleepFrames = 0;
    }
  }

  draw() {
    const ctx = this.ctx;
    const rect = this.board.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    const ropeWidth = 3.4;
    const highlightWidth = 1.1;

    for (const rope of this.ropes) {
      const pts = rope.sim.points;
      if (!pts || pts.length < 2) continue;

      const keyItem = this.key.find((k) => k.id === rope.colorId) || this.key[0];
      const col = keyItem ? keyItem.color : "#ff3b3b";

      if (rope.id === this.selectedRopeId) {
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = ropeWidth + 12;
        ctx.strokeStyle = "#6ee7ff";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = ropeWidth;
      ctx.strokeStyle = yarnPattern(ctx, col);

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();

      ctx.globalAlpha = 0.26;
      ctx.lineWidth = highlightWidth;
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y - 0.35);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y - 0.35);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    if (this.previewSim.points.length > 1) {
      const pts = this.previewSim.points;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Centers the canvas around the images
  centerContent() {
    const rect = this.board.getBoundingClientRect();

    if (this.photos.size === 0) {
      this.setPan(0, 0);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.photos.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w);
      maxY = Math.max(maxY, p.y + p.h);
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const panX = rect.width / 2 - cx * this.zoom;
    const panY = rect.height / 2 - cy * this.zoom;

    this.setPan(panX, panY);
    this.setStatus("Centered.");
  }
}

// Boot
(() => {
  const app = new YarnBoard();
  app.setLocked(false, { persist: false });
})();

export {};
