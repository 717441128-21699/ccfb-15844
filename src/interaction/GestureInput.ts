/**
 * 手势输入：
 * - 桌面调试：指针（鼠标/触屏）模拟三种手势
 * - 大屏正式：MediaPipe Hands 摄像头识别
 *   张掌吹气、食指戳泡、捏合后张开吹泡
 * 输出统一的 GestureEvent，屏幕坐标归一化到 0..1。
 */

export type GestureKind = 'blow' | 'poke' | 'breath' | 'none';

export interface GestureEvent {
  kind: GestureKind;
  /** 归一化屏幕坐标 x/y，0..1（左上角原点） */
  x: number;
  y: number;
  /** 手势强度 0..1（张开幅度/移动速度映射） */
  strength: number;
  source: 'pointer' | 'hands';
}

export type GestureCallback = (e: GestureEvent) => void;

export class GestureInput {
  private cb: GestureCallback;
  private el: HTMLElement;
  private pointerDown = false;
  private pointerKind: GestureKind = 'poke';
  private hands: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private lastVideoTime = -1;
  private prevPinch = false;
  private running = false;

  constructor(el: HTMLElement, cb: GestureCallback) {
    this.el = el;
    this.cb = cb;
    this.attachPointer();
  }

  private attachPointer(): void {
    this.el.addEventListener('pointerdown', (e) => {
      this.pointerDown = true;
      const norm = this.toNorm(e);
      // 左键戳泡，右键/双指吹气，Shift+点击吹泡
      if (e.shiftKey) this.pointerKind = 'blow';
      else if (e.button === 2) this.pointerKind = 'breath';
      else this.pointerKind = 'poke';
      this.cb({ kind: this.pointerKind, ...norm, strength: 1, source: 'pointer' });
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.pointerDown) return;
      const norm = this.toNorm(e);
      this.cb({ kind: this.pointerKind, ...norm, strength: 0.6, source: 'pointer' });
    });
    const up = () => { this.pointerDown = false; };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private toNorm(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  /** 启动 MediaPipe Hands（本地 WASM，离线可用） */
  async startCamera(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks('./mediapipe');
    this.hands = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: './mediapipe/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
    });
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    this.running = true;
    this.loop();
  }

  private loop = (): void => {
    if (!this.running || !this.hands || !this.video) return;
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const result = this.hands.detectForVideo(this.video, performance.now());
      if (result.landmarks.length > 0) {
        this.interpretHands(result.landmarks);
      } else {
        this.cb({ kind: 'none', x: 0.5, y: 0.5, strength: 0, source: 'hands' });
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  /**
   * 21 个手部关键点手势判定：
   * - 食指伸直、其余握拳 -> 戳泡（食指指尖位置）
   * - 五指张开 -> 吹气（掌心位置）
   * - 捏合（拇指食指距离近）-> 标记，张开瞬间触发吹泡
   */
  private interpretHands(hands: NormalizedLandmark[][]): void {
    const lm = hands[0];
    const tip = lm[8]; // 食指指尖
    const wrist = lm[0];
    const indexMcp = lm[5];
    const pinkyMcp = lm[17];
    const thumbTip = lm[4];
    const pinchDist = Math.hypot(thumbTip.x - tip.x, thumbTip.y - tip.y);
    const isPinch = pinchDist < 0.06;

    // 手指伸直判定：指尖到腕距离 > 掌指关节到腕距离
    const extended = (tipIdx: number, mcpIdx: number) => {
      const dTip = Math.hypot(lm[tipIdx].x - wrist.x, lm[tipIdx].y - wrist.y);
      const dMcp = Math.hypot(lm[mcpIdx].x - wrist.x, lm[mcpIdx].y - wrist.y);
      return dTip > dMcp * 1.1;
    };
    const fingers = [8, 12, 16, 20].map((t, i) => extended(t, [5, 9, 13, 17][i]));
    const openPalm = fingers.filter(Boolean).length >= 3;
    const indexOnly = fingers[0] && !fingers[1] && !fingers[2] && !fingers[3];

    // 镜像 x（摄像头是自拍镜像）
    const x = 1 - tip.x;
    const y = tip.y;
    void indexMcp; void pinkyMcp;

    if (isPinch) {
      this.prevPinch = true;
      return;
    }
    if (this.prevPinch && !isPinch) {
      this.prevPinch = false;
      this.cb({ kind: 'blow', x, y, strength: 1, source: 'hands' });
      return;
    }
    if (indexOnly) {
      this.cb({ kind: 'poke', x, y, strength: 1, source: 'hands' });
    } else if (openPalm) {
      const cx = 1 - (indexMcp.x + pinkyMcp.x) / 2;
      const cy = (indexMcp.y + pinkyMcp.y) / 2;
      this.cb({ kind: 'breath', x: cx, y: cy, strength: 0.7, source: 'hands' });
    } else {
      this.cb({ kind: 'none', x, y, strength: 0, source: 'hands' });
    }
  }

  stopCamera(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.video?.srcObject &&
      (this.video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
    this.hands?.close();
    this.hands = null;
  }
}

// MediaPipe 类型在动态导入后由其包提供，这里声明最小结构避免硬依赖
interface NormalizedLandmark { x: number; y: number; z: number }
interface HandLandmarker {
  detectForVideo(video: HTMLVideoElement, ts: number): { landmarks: NormalizedLandmark[][] };
  close(): void;
}
