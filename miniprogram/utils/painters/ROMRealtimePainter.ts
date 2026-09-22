// miniprogram/utils/painters/ROMRealtimePainter.ts

import { BasePainter } from "./BasePainter";
import { MeasureEngine } from "../core/MeasureEngine";
import { DrawUtils } from "../shared/DrawUtils";
import { DrawConfig, RawPoint } from "../shared/types";

/**绘制角度的实时曲线 */
export class ROMRealtimePainter extends BasePainter {
  private engine = MeasureEngine.getInstance();

  // 交互状态
  private isDragging: boolean = false; // 是否在拖拽（双指拖动）
  private lastTouchX: number = 0;

  // 平移和缩放
  private currentOffsetX: number = 0;
  private currentScaleX: number = 1.0;
  private startDistance: number = 0;
  private startScaleX: number = 1.0;
  private startOffsetX: number = 0;
  private startCenterX: number = 0;

  drawFrame() {
    if (!this.ctx) return;

    const data = this.engine.getDrawingPoints();
    const data1 = this.engine.getFirstLoopPoints(); // 第一轮数据
    const data2 = this.engine.getDrawingPoints(); // 第二轮数据
    const startTime = this.engine.getStartTime();
    this.ctx.clearRect(0, 0, this.width, this.height);

    // 计算动态Y轴范围（合并两条曲线的角度数据）
    // 不允许负值，只显示正半轴
    const yAxisConfig = DrawUtils.calculateMultiCurveYAxis(
      [data1 || [], data2 || []],
      "a", // 使用角度字段
      30, // 最小范围30度
      0.15, // 上下留白15%
      false, // 不允许负值，只显示正半轴
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

    // 2. 定义 ROM 专属配置
    const config: DrawConfig = {
      width: this.width,
      height: this.height,
      paddingL: 28,
      paddingT: 15,
      paddingB: 25,
      maxY: yAxisConfig.yMax, // 使用动态计算的最大值
      offsetX: this.currentOffsetX,
      scaleX: this.currentScaleX,
      startTime: startTime,
      maxDuration: maxDuration > 0 ? maxDuration : undefined, // 传递最大持续时间
    };

    // 3. 绘制背景网格（使用动态Y轴范围）
    DrawUtils.drawGridsCommon(
      this.ctx,
      config,
      "°",
      yAxisConfig.yMin,
      yAxisConfig.yMax,
    );

    // 4. 绘制第一轮曲线 (对比色：浅灰色虚线)
    if (data1 && data1.length >= 2) {
      this.drawAngleCurve(
        data1,
        {
          ...config,
          startTime: startTime1, // 使用第一轮的起始时间
        },
        "#cccccc",
        true,
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
    }

    // 5. 绘制当前曲线
    if (data2 && data2.length >= 2) {
      this.drawAngleCurve(
        data2,
        config,
        "#07c160",
        false,
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
      // 绘制X轴时间：传入第一轮数据用于对比显示
      DrawUtils.drawXAxis(this.ctx, data2, config, data1, startTime1);
    } else {
      DrawUtils.drawXAxis(this.ctx, data1, config);
    }
  }

  /** 绘制角度曲线 (支持动态Y轴范围，支持基于时间的X轴映射) */
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

    // 防止 rangeY 为 0 导致除以 0
    if (rangeY <= 0) return;

    // 计算X轴映射方式
    let xScale: number;
    let startTime: number;

    if (config.maxDuration && config.startTime) {
      // 基于时间的映射：用于双曲线对比模式
      xScale = (config.width * config.scaleX) / config.maxDuration;
      startTime = config.startTime;
    } else {
      // 基于数据点索引的映射：用于单曲线模式
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
        // 基于时间计算X坐标
        const relativeTime = p.t - startTime;
        x = relativeTime * xScale;
      } else {
        // 基于索引计算X坐标
        x = i * xScale;
      }

      // Y 坐标映射：支持动态范围
      const y =
        config.paddingT + drawHeight - ((p.a - yMin) / rangeY) * drawHeight;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** 内部状态更新函数 */
  private _updateSelection(screenX: number) {
    const data1 = this.engine.getFirstLoopPoints();
    const data2 = this.engine.getDrawingPoints();
    const currentLoop = this.engine.getCurrentLoopIndex();

    // 确定使用哪条曲线来计算索引
    let activeData: RawPoint[];
    if (
      currentLoop === 2 &&
      data1 &&
      data1.length >= 2 &&
      data2 &&
      data2.length >= 2
    ) {
      // 双曲线对比模式：使用较长的曲线作为基准
      activeData = data1.length >= data2.length ? data1 : data2;
    } else {
      // 单曲线模式：优先使用当前曲线，否则使用历史曲线
      activeData =
        data2.length >= 2 ? data2 : data1 && data1.length >= 2 ? data1 : [];
    }

    // 调用 DrawUtils 进行计算
    this.selectedIndex = DrawUtils.calculateSelectedIndex(screenX, activeData, {
      width: this.width,
      height: this.height,
      paddingL: 0,
      paddingT: 0,
      paddingB: 0,
      maxY: 0,
      offsetX: this.currentOffsetX,
      scaleX: this.currentScaleX,
      startTime: this.engine.getStartTime(),
      maxDuration: undefined,
    });
  }

  /** 暴露给页面：处理触摸开始 */
  public onTouchStart(e: any) {
    if (e.touches.length === 2) {
      // 双指操作：缩放+拖动
      this.isDragging = true;
      this.startDistance = DrawUtils.getDistance(e.touches[0], e.touches[1]);
      this.startScaleX = this.currentScaleX;
      this.startOffsetX = this.currentOffsetX;
      this.startCenterX = (e.touches[0].x + e.touches[1].x) / 2;
      this.lastTouchX = this.startCenterX;
    } else if (e.touches.length === 1) {
      // 单指滑动
      this.isDragging = false;
      this.lastTouchX = e.touches[0].x;
    }
  }

  /** 暴露给页面：处理触摸移动 */
  public onTouchMove(e: any) {
    if (e.touches.length === 2 && this.isDragging) {
      // 双指操作：缩放+拖动
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
      // 单指滑动
      const x = e.touches[0].x;
    }
  }

  /** 暴露给页面：处理触摸结束 */
  public onTouchEnd() {
    this.isDragging = false;
    this.startDistance = 0;
  }

  /** 兼容旧接口 */
  public onTouch(e: any) {
    this.onTouchStart(e);
  }

  /** 重置图表状态 */
  public resetView() {
    this.currentOffsetX = 0;
    this.currentScaleX = 1.0;
  }
}
