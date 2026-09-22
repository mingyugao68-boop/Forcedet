// miniprogram/utils/painters/MMTPainter.ts

import { MeasureEngine } from "../core/MeasureEngine";
import { RawPoint, DrawConfig } from "../shared/types";
import { DrawUtils } from "../shared/DrawUtils";
import { BasePainter } from "./BasePainter";

/**绘制力值的实时曲线，即MMT曲线 */
export class MMTPainter extends BasePainter {
  private engine = MeasureEngine.getInstance();
  //处理屏幕触摸事件：
  private currentOffsetX: number = 0; // 拖拽平移距离
  private isDragging: boolean = false; //是否在拖拽（双指拖动）
  private lastTouchX: number = 0;

  //处理双指放缩操作：
  private currentScaleX: number = 1.0; // 当前缩放比例
  private startDistance: number = 0; // 双指初始距离
  private startScaleX: number = 1.0;
  private startOffsetX: number = 0; // 双指操作时的初始偏移量
  private startCenterX: number = 0; // 双指中心点X坐标

  constructor(canvasId: string, pageContext: any) {
    super(canvasId, pageContext);
  }

  //重写基类抽象方法
  /** 每一帧的绘制逻辑 */
  drawFrame() {
    if (!this.ctx) return;
    const data1 = this.engine.getFirstLoopPoints(); // 第一轮历史数据
    const data2 = this.engine.getDrawingPoints(); // 当前（第二轮）数据

    this.ctx.clearRect(0, 0, this.width, this.height); // 1. 先清空

    // 计算动态Y轴范围（合并两条曲线的数据）
    // 不允许负值，只显示正半轴
    const yAxisConfig = DrawUtils.calculateMultiCurveYAxis(
      [data1 || [], data2 || []],
      "f",
      40, // 最小范围40N
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

    const baseConfig: DrawConfig = {
      width: this.width,
      height: this.height,
      paddingL: 28,
      paddingT: 20,
      paddingB: 30,
      maxY: yAxisConfig.yMax, // 使用动态计算的最大值
      offsetX: this.currentOffsetX,
      scaleX: this.currentScaleX,
      startTime: this.engine.getStartTime(),
      maxDuration: maxDuration > 0 ? maxDuration : undefined, // 传递最大持续时间
    };

    //this.ctx.save();
    // 1. 绘制背景刻度（使用动态Y轴范围）
    DrawUtils.drawGridsCommon(
      this.ctx,
      baseConfig,
      "kg",
      yAxisConfig.yMin,
      yAxisConfig.yMax,
    );

    // 2. 绘制第一轮曲线 (对比色：浅灰色虚线)
    if (data1 && data1.length >= 2) {
      DrawUtils.drawCurve(
        this.ctx,
        data1,
        {
          ...baseConfig,
          color: "#cccccc",
          isDash: true,
          startTime: startTime1, // 使用第一轮的起始时间
        },
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
    }

    // 3. 绘制当前曲线
    if (data2 && data2.length >= 2) {
      DrawUtils.drawCurve(
        this.ctx,
        data2,
        {
          ...baseConfig,
          color: "#07c160",
          isDash: false,
        },
        yAxisConfig.yMin,
        yAxisConfig.yMax,
      );
      // 绘制X轴时间：传入第一轮数据用于对比显示
      DrawUtils.drawXAxis(this.ctx, data2, baseConfig, data1, startTime1);
    } else {
      DrawUtils.drawXAxis(this.ctx, data1, baseConfig);
    }
  }
  /** 暴露给 Page 的触摸处理函数 */
  public onTouchStart(e: any) {
    if (e.touches.length === 2) {
      // 模式 A: 双指操作（缩放+拖动）
      this.isDragging = true;
      this.startDistance = DrawUtils.getDistance(e.touches[0], e.touches[1]);
      this.startScaleX = this.currentScaleX;
      this.startOffsetX = this.currentOffsetX;
      // 计算双指中心点
      this.startCenterX = (e.touches[0].x + e.touches[1].x) / 2;
      this.lastTouchX = this.startCenterX;
    } else if (e.touches.length === 1) {
      // 模式 B: 单指滑动（非全屏模式不处理）
      this.isDragging = false;
      this.lastTouchX = e.touches[0].x;
    }
  }

  public onTouchMove(e: any) {
    if (e.touches.length === 2 && this.isDragging) {
      // 双指操作：同时支持缩放和拖动
      const curDistance = DrawUtils.getDistance(e.touches[0], e.touches[1]);
      const curCenterX = (e.touches[0].x + e.touches[1].x) / 2;

      if (this.startDistance > 0) {
        // 1. 处理缩放
        const ratio = curDistance / this.startDistance;
        const newScaleX = Math.max(0.5, Math.min(5, this.startScaleX * ratio));

        // 2. 处理拖动（以双指中心点为基准）
        const deltaX = curCenterX - this.startCenterX;

        // 缩放时保持中心点不变，同时应用拖动偏移
        this.currentScaleX = newScaleX;
        this.currentOffsetX = this.startOffsetX + deltaX;
      }
    } else if (e.touches.length === 1 && !this.isDragging) {
      // 单指滑动（非全屏模式不处理）
      const x = e.touches[0].x;
    }
  }

  public onTouchEnd() {
    this.isDragging = false;
    this.startDistance = 0;
  }

  /** 重置图表状态（平移、缩放） */
  public resetView() {
    this.currentOffsetX = 0;
    this.currentScaleX = 1.0;
  }
}
