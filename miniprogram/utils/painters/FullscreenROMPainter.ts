// miniprogram/utils/painters/FullscreenROMPainter.ts

import { BasePainter } from "./BasePainter";
import { MeasureEngine } from "../core/MeasureEngine";
import { DrawUtils } from "../shared/DrawUtils";
import { DrawConfig, RawPoint } from "../shared/types";

/**全屏模式的ROM曲线绘制器，复用ROMRealtimePainter的绘制逻辑 */
export class FullscreenROMPainter extends BasePainter {
  private engine = MeasureEngine.getInstance();
  private selectedIndex: number | null = null;
  private touchX: number | null = null; // 保存触摸位置
  private relativeTime: number | undefined = undefined; // 保存相对时间（用于双曲线模式）
  private dismissTimer: number | null = null;

  // 交互状态
  private isDragging: boolean = false;
  private lastTouchX: number = 0;

  // 平移和缩放
  private currentOffsetX: number = 0;
  private currentScaleX: number = 1.0;
  private startDistance: number = 0;
  private startScaleX: number = 1.0;
  private startOffsetX: number = 0;
  private startCenterX: number = 0;

  constructor(canvasId: string, pageContext: any) {
    super(canvasId, pageContext);
  }

  drawFrame() {
    if (!this.ctx) return;

    const data = this.engine.getDrawingPoints();
    const data1 = this.engine.getFirstLoopPoints();
    const data2 = this.engine.getDrawingPoints();
    const startTime = this.engine.getStartTime();
    this.ctx.clearRect(0, 0, this.width, this.height);

    const yAxisConfig = DrawUtils.calculateMultiCurveYAxis(
      [data1 || [], data2 || []],
      "a",
      30,
      0.15,
      false,
    );

    // 计算最大持续时间（用于统一两条曲线的时间轴）
    let maxDuration = 0;
    const startTime1 = this.engine.getFirstLoopStartTime();
    const startTime2 = this.engine.getStartTime();

    if (data1 && data1.length >= 2 && startTime1) {
      const duration1 = data1[data1.length - 1].t - startTime1;
      maxDuration = Math.max(maxDuration, duration1);
    }
    if (data2 && data2.length >= 2 && startTime2) {
      const duration2 = data2[data2.length - 1].t - startTime2;
      maxDuration = Math.max(maxDuration, duration2);
    }

    const config: DrawConfig = {
      width: this.width,
      height: this.height,
      paddingL: 30, // 全屏模式下左侧留更多空间，确保Y轴标尺数字完整显示
      paddingT: 20,
      paddingB: 40, // 全屏模式下底部留更多空间
      maxY: yAxisConfig.yMax,
      offsetX: this.currentOffsetX,
      scaleX: this.currentScaleX,
      startTime: startTime,
      maxDuration: maxDuration > 0 ? maxDuration : undefined,
    };

    this.ctx.save();

    // 绘制标题 "ROM"
    this.ctx.fillStyle = "#333";
    this.ctx.font = "bold 16px Arial";
    this.ctx.textAlign = "center";
    this.ctx.fillText("ROM", this.width / 2, 15);

    DrawUtils.drawGridsCommon(
      this.ctx,
      config,
      "°",
      yAxisConfig.yMin,
      yAxisConfig.yMax,
    );

    if (data1 && data1.length >= 2) {
      this.drawAngleCurve(
        data1,
        {
          ...config,
          startTime: startTime1,
        },
        "#cccccc",
        true,
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
    }

    if (data2 && data2.length >= 2) {
      this.drawAngleCurve(
        data2,
        config,
        "#07c160",
        false,
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
      DrawUtils.drawXAxis(this.ctx, data2, config, data1, startTime1);
    } else {
      DrawUtils.drawXAxis(this.ctx, data1, config);
    }

    DrawUtils.drawInteractionLayer(
      this.ctx,
      this.selectedIndex,
      data1,
      data2,
      config,
      this.engine.getCurrentLoopIndex(),
      "angle",
      yAxisConfig.yMin,
      yAxisConfig.yMax,
      this.touchX !== null ? this.touchX : undefined,
      startTime1, // 传递第一轮的开始时间
      this.relativeTime, // 传递相对时间
      this.engine.getCurrentLabel(), // 传递当前测量标签
    );
  }

  /** 绘制角度曲线  */
  private drawAngleCurve(
    data: RawPoint[],
    config: DrawConfig,
    color: string,
    isDash: boolean,
    yMin: number = 0,
    yMax?: number,
  ) {
    const drawHeight = config.height - config.paddingB - config.paddingT;
    const actualYMax = yMax ?? config.maxY;
    const rangeY = actualYMax - yMin;

    if (rangeY <= 0) return;

    let xScale: number;
    let startTime: number;

    if (config.maxDuration && config.startTime) {
      xScale = (config.width * config.scaleX) / config.maxDuration;
      startTime = config.startTime;
    } else {
      xScale = DrawUtils.getStepX(this.width, data.length) * config.scaleX;
      startTime = config.startTime || data[0]?.t || 0;
    }

    this.ctx.save();
    this.ctx.translate(config.offsetX, 0);
    this.ctx.beginPath();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.lineJoin = "round";
    if (isDash) this.ctx.setLineDash([5, 5]);

    data.forEach((p, i) => {
      let x: number;
      if (config.maxDuration && config.startTime) {
        const relativeTime = p.t - startTime;
        x = relativeTime * xScale;
      } else {
        x = i * xScale;
      }

      const y =
        config.paddingT + drawHeight - ((p.a - yMin) / rangeY) * drawHeight;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();
    this.ctx.restore();
  }

  private _updateSelection(screenX: number) {
    const data1 = this.engine.getFirstLoopPoints();
    const data2 = this.engine.getDrawingPoints();
    const currentLoop = this.engine.getCurrentLoopIndex();

    // 计算最大持续时间
    let maxDuration = 0;
    const startTime1 = this.engine.getFirstLoopStartTime();
    const startTime2 = this.engine.getStartTime();

    let duration1 = 0;
    let duration2 = 0;

    if (data1 && data1.length >= 2 && startTime1) {
      duration1 = data1[data1.length - 1].t - startTime1;
      maxDuration = Math.max(maxDuration, duration1);
    }
    if (data2 && data2.length >= 2 && startTime2) {
      duration2 = data2[data2.length - 1].t - startTime2;
      maxDuration = Math.max(maxDuration, duration2);
    }

    // 双曲线模式下，使用时间更长的曲线来计算索引，这样才能覆盖整个时间范围
    // 单曲线模式下，优先使用 data2，其次使用 data1
    let activeData: RawPoint[];
    let activeStartTime: number;

    if (
      currentLoop === 2 &&
      data1 &&
      data1.length >= 2 &&
      data2 &&
      data2.length >= 2
    ) {
      // 双曲线模式：使用时间更长的曲线
      if (duration1 >= duration2) {
        activeData = data1;
        activeStartTime = startTime1 || 0;
      } else {
        activeData = data2;
        activeStartTime = startTime2 || 0;
      }
    } else if (data2 && data2.length >= 2) {
      activeData = data2;
      activeStartTime = startTime2 || 0;
    } else if (data1 && data1.length >= 2) {
      activeData = data1;
      activeStartTime = startTime1 || 0;
    } else {
      activeData = [];
      activeStartTime = 0;
    }

    const result = DrawUtils.calculateSelectedIndex(screenX, activeData, {
      width: this.width,
      height: this.height,
      paddingL: 0,
      paddingT: 0,
      paddingB: 0,
      maxY: 0,
      offsetX: this.currentOffsetX,
      scaleX: this.currentScaleX,
      startTime: activeStartTime,
      maxDuration: maxDuration > 0 ? maxDuration : undefined,
    });

    if (result) {
      this.selectedIndex = result.index;
      this.touchX = result.touchX;
      this.relativeTime = result.relativeTime;
    } else {
      this.selectedIndex = null;
      this.touchX = null;
      this.relativeTime = undefined;
    }
  }

  public onTouchStart(e: any) {
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    if (e.touches.length === 2) {
      this.isDragging = true;
      this.startDistance = DrawUtils.getDistance(e.touches[0], e.touches[1]);
      this.startScaleX = this.currentScaleX;
      this.startOffsetX = this.currentOffsetX;
      this.startCenterX = (e.touches[0].x + e.touches[1].x) / 2;
      this.lastTouchX = this.startCenterX;
    } else if (e.touches.length === 1) {
      this.isDragging = false;
      this.lastTouchX = e.touches[0].x;
      this._updateSelection(e.touches[0].x);
    }
  }

  public onTouchMove(e: any) {
    if (e.touches.length === 2 && this.isDragging) {
      const curDistance = DrawUtils.getDistance(e.touches[0], e.touches[1]);
      const curCenterX = (e.touches[0].x + e.touches[1].x) / 2;

      if (this.startDistance > 0) {
        const ratio = curDistance / this.startDistance;
        const newScaleX = Math.max(0.5, Math.min(5, this.startScaleX * ratio));
        const deltaX = curCenterX - this.startCenterX;

        this.currentScaleX = newScaleX;
        this.currentOffsetX = this.startOffsetX + deltaX;
      }
    } else if (e.touches.length === 1 && !this.isDragging) {
      const x = e.touches[0].x;
      this._updateSelection(x);
    }
  }

  public onTouchEnd() {
    this.isDragging = false;
    this.startDistance = 0;
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      this.selectedIndex = null;
      this.touchX = null;
      this.relativeTime = undefined;
    }, 2000) as any;
  }

  /** 重置图表状态 */
  public resetView() {
    this.currentOffsetX = 0;
    this.currentScaleX = 1.0;
    this.selectedIndex = null;
    this.touchX = null;
    this.relativeTime = undefined;
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }
}
