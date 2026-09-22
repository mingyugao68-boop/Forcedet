// miniprogram/utils/shared/DrawUtils.ts
import { RawPoint, DrawConfig, MeasurementResult } from "./types";

/** 动态Y轴配置接口 */
export interface DynamicYAxisConfig {
  yMin: number; // Y轴最小值
  yMax: number; // Y轴最大值
  rangeY: number; // Y轴范围
}

export class DrawUtils {
  private static readonly MIN_POINTS = 300;

  /**
   * 计算动态Y轴范围
   * @param data 数据点数组
   * @param valueField 取值字段 'f' 或 'a'
   * @param minRange 最小范围（防止范围过小）
   * @param paddingRatio 上下留白比例（默认20%）
   * @param allowNegative 是否允许负值（默认true）
   * @returns 动态Y轴配置
   */
  static calculateDynamicYAxis(
    data: RawPoint[],
    valueField: "f" | "a" = "f",
    minRange: number = 50,
    paddingRatio: number = 0.2,
    allowNegative: boolean = true,
  ): DynamicYAxisConfig {
    if (!data || data.length === 0) {
      return { yMin: 0, yMax: minRange, rangeY: minRange };
    }

    // 提取所有值
    const values = data.map((p) => (valueField === "f" ? p.f : p.a));
    const maxVal = Math.max(...values);
    const minVal = Math.min(...values);
    const range = maxVal - minVal;

    let yMin: number, yMax: number;

    if (range < minRange) {
      // 数据范围很小，使用最小范围
      const center = (maxVal + minVal) / 2;
      yMin = center - minRange / 2;
      yMax = center + minRange / 2;
    } else {
      // 数据范围较大，按比例留白
      const padding = range * paddingRatio;
      yMin = minVal - padding;
      yMax = maxVal + padding;
    }

    // 如果不允许负值，则限制yMin >= 0
    if (!allowNegative) {
      yMin = Math.max(0, yMin);
    }

    // 向上取整到好看的数字
    yMax = Math.ceil(yMax / 10) * 10;
    yMin = Math.floor(yMin / 10) * 10;

    return {
      yMin,
      yMax,
      rangeY: yMax - yMin,
    };
  }

  /**
   * 合并多条曲线的Y轴范围
   * @param dataArray 多条数据数组
   * @param valueField 取值字段
   * @param minRange 最小范围
   * @param paddingRatio 留白比例
   * @param allowNegative 是否允许负值（默认true）
   */
  static calculateMultiCurveYAxis(
    dataArray: RawPoint[][],
    valueField: "f" | "a" = "f",
    minRange: number = 50,
    paddingRatio: number = 0.2,
    allowNegative: boolean = true,
  ): DynamicYAxisConfig {
    let allValues: number[] = [];

    dataArray.forEach((data) => {
      if (data && data.length > 0) {
        const values = data.map((p) => (valueField === "f" ? p.f : p.a));
        allValues = allValues.concat(values);
      }
    });

    if (allValues.length === 0) {
      return { yMin: 0, yMax: minRange, rangeY: minRange };
    }

    const maxVal = Math.max(...allValues);
    const minVal = Math.min(...allValues);
    const range = maxVal - minVal;

    let yMin: number, yMax: number;

    if (range < minRange) {
      const center = (maxVal + minVal) / 2;
      yMin = center - minRange / 2;
      yMax = center + minRange / 2;
    } else {
      const padding = range * paddingRatio;
      yMin = minVal - padding;
      yMax = maxVal + padding;
    }

    // 如果不允许负值，则限制yMin >= 0
    if (!allowNegative) {
      yMin = Math.max(0, yMin);
    }

    // 向上取整
    yMax = Math.ceil(yMax / 10) * 10;
    yMin = Math.floor(yMin / 10) * 10;

    // 防止 rangeY 为 0 的情况
    if (yMax <= yMin) {
      yMax = yMin + minRange;
    }

    return { yMin, yMax, rangeY: yMax - yMin };
  }

  /** 绘制圆角矩形背景 (类似 QPainterPath) */
  static fillRoundRect(
    ctx: any,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    color: string,
  ) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
    ctx.restore();
  }

  /** 通用网格绘制 */
  static drawGridsCommon(
    ctx: any,
    config: DrawConfig,
    unit: string = "kg",
    yMin: number = 0,
    yMax?: number,
  ) {
    const drawHeight = config.height - config.paddingB - config.paddingT;
    const actualYMax = yMax ?? config.maxY;
    const rangeY = actualYMax - yMin;

    ctx.save();
    ctx.strokeStyle = "#f0f0f0";
    ctx.fillStyle = "#999";
    ctx.font = "10px Arial";
    ctx.lineWidth = 1;

    // 计算最宽标签宽度，动态调整左侧空间防止大数值被裁剪
    let maxLabelWidth = 0;
    for (let i = 0; i <= 5; i++) {
      const val = yMin + (rangeY / 5) * i;
      const label = `${Math.floor(val)}${unit}`;
      const metrics = ctx.measureText(label);
      if (metrics.width > maxLabelWidth) maxLabelWidth = metrics.width;
    }
    const labelX = Math.max(config.paddingL - 5, maxLabelWidth + 5);

    // 分 5 档刻度
    for (let i = 0; i <= 5; i++) {
      const val = yMin + (rangeY / 5) * i;
      const y =
        config.paddingT + drawHeight - ((val - yMin) / rangeY) * drawHeight;

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(config.width, y);
      ctx.stroke();

      // 显示刻度值 - 使用动态计算的锚点，确保数字不被裁剪
      ctx.textAlign = "right";
      ctx.fillText(`${Math.floor(val)}${unit}`, labelX, y - 2);
    }
    ctx.restore();
  }
  //MMT卡片用：------------------------------------------------------------
  /** 格式化时间戳 (秒.毫秒) */
  static formatRelativeTime(absoluteTs: number, startTs?: number): string {
    if (!startTs || absoluteTs < startTs) return "0.0s";

    // 计算毫秒差值
    const diff = absoluteTs - startTs;

    // 转换为 秒.毫秒 格式
    const seconds = Math.floor(diff / 1000);
    const ms = Math.floor((diff % 1000) / 100);

    return `${seconds}.${ms}s`;
  }

  /**统一步长计算逻辑 ，确保绘图和判定永远同步*/
  static getStepX(canvasWidth: number, dataLength: number): number {
    const minPoints = this.MIN_POINTS; // 必须和 Page 逻辑一致
    return canvasWidth / Math.max(minPoints, dataLength);
  }

  /** 计算两点间的距离 (勾股定理) */
  static getDistance(p1: any, p2: any): number {
    const x = p2.x - p1.x;
    const y = p2.y - p1.y;
    return Math.sqrt(x * x + y * y);
  }

  /** 封装的通用绘图函数 (支持动态Y轴范围，支持基于时间的X轴映射) */
  static drawCurve(
    ctx: any,
    points: RawPoint[],
    config: DrawConfig,
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
      xScale = this.getStepX(config.width, points.length) * config.scaleX;
      startTime = config.startTime || points[0]?.t || 0;
    }

    ctx.save();
    ctx.translate(config.offsetX, 0);
    ctx.beginPath();
    ctx.strokeStyle = config.color || "#07c160";
    ctx.lineWidth = 2;
    if (config.isDash) ctx.setLineDash([5, 5]);

    for (let i = 0; i < points.length; i++) {
      let x: number;
      if (config.maxDuration && config.startTime) {
        // 基于时间计算X坐标
        const relativeTime = points[i].t - startTime;
        x = relativeTime * xScale;
      } else {
        // 基于索引计算X坐标
        x = i * xScale;
      }

      // Y坐标映射：支持动态范围
      const y =
        config.paddingT +
        drawHeight -
        ((points[i].f - yMin) / rangeY) * drawHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 绘制X轴坐标、起始时间戳及结束时间戳
   * @param ctx Canvas 2D绘图上下文对象
   * @param data 原始数据点数组，用于获取最后一个点的时间
   * @param config 绘制配置对象，包含起始时间、宽度、高度及缩放比例等参数
   * @param data1 第一轮测量数据（可选，用于双曲线对比模式）
   * @param startTime1 第一轮测量的起始时间（可选）
   */
  static drawXAxis(
    ctx: any,
    data: RawPoint[],
    config: DrawConfig,
    data1?: RawPoint[],
    startTime1?: number,
  ) {
    const startTime = config.startTime; // 获取本次测量的起点

    ctx.save();
    ctx.fillStyle = "#999";
    ctx.font = "10px Arial";
    ctx.textAlign = "left";

    // 计算X坐标映射方式
    let xScale: number;
    if (config.maxDuration && config.startTime) {
      // 基于时间的映射
      xScale = (config.width * config.scaleX) / config.maxDuration;
    } else {
      // 基于数据点索引的映射
      xScale = this.getStepX(config.width, data.length) * config.scaleX;
    }

    // 绘制当前曲线的结束时间
    const last = data[data.length - 1];
    if (last) {
      let lastPointX: number;
      if (config.maxDuration && config.startTime) {
        // 基于时间计算X坐标
        const relativeTime = last.t - startTime;
        lastPointX = relativeTime * xScale;
      } else {
        // 基于索引计算X坐标
        lastPointX = (data.length - 1) * xScale;
      }

      const endStr = this.formatRelativeTime(last.t, startTime);
      const displayX = Math.min(lastPointX, config.width - 10);

      ctx.textAlign = "right";
      ctx.fillText(endStr, displayX, config.height - 10);
    }

    // 如果有第一轮数据，也显示第一轮的结束时间
    if (data1 && data1.length >= 2 && startTime1) {
      const last1 = data1[data1.length - 1];
      if (last1) {
        let lastPointX1: number;
        if (config.maxDuration && config.startTime) {
          // 基于时间计算X坐标（使用第一轮的起始时间）
          const relativeTime1 = last1.t - startTime1;
          lastPointX1 = relativeTime1 * xScale;
        } else {
          // 基于索引计算X坐标
          const stepX1 =
            this.getStepX(config.width, data1.length) * config.scaleX;
          lastPointX1 = (data1.length - 1) * stepX1;
        }

        const endStr1 = this.formatRelativeTime(last1.t, startTime1);
        const displayX1 = Math.min(lastPointX1, config.width - 10);

        // 使用灰色显示第一轮的时间
        ctx.fillStyle = "#cccccc";
        ctx.textAlign = "right";
        ctx.fillText(endStr1, displayX1, config.height - 22);
      }
    }

    ctx.restore();
  }

  /** 画背景网格线（采用多档刻度逻辑，参考drawGridsCommon） */
  static drawGridsHistory(
    ctx: any,
    maxVal: number,
    minVal: number,
    yMax: number,
    yMin: number,
    config: DrawConfig,
    unit: string = "kg",
  ) {
    ctx.save();
    ctx.strokeStyle = "#e0e0e0";
    ctx.fillStyle = "#999";
    ctx.font = "9px Arial";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;

    const drawHeight = config.height - config.paddingB - config.paddingT;
    const rangeY = yMax - yMin;

    // 计算最宽标签宽度，动态调整左侧空间
    let maxLabelWidth = 0;
    for (let i = 0; i <= 4; i++) {
      const val = yMin + (rangeY / 4) * i;
      const label = `${Math.floor(val)}${unit}`;
      const metrics = ctx.measureText(label);
      if (metrics.width > maxLabelWidth) maxLabelWidth = metrics.width;
    }
    const labelX = Math.max(config.paddingL - 5, maxLabelWidth + 5);

    // 采用4档刻度逻辑（0%, 25%, 50%, 75%, 100%）
    for (let i = 0; i <= 4; i++) {
      const val = yMin + (rangeY / 4) * i;
      const y =
        config.paddingT + drawHeight - ((val - yMin) / rangeY) * drawHeight;

      ctx.beginPath();
      ctx.moveTo(config.paddingL, y);
      ctx.lineTo(config.paddingL + (config.width - config.paddingL - 10), y);
      ctx.stroke();

      // 显示数值，如 156° 或 598N
      ctx.fillText(`${Math.floor(val)}${unit}`, labelX, y + 3);
    }
    ctx.restore();
  }

  /**绘制x轴时间戳 */
  static drawXAxisHistory(ctx: any, res: any, x: number, y: number) {
    // 获取第一次测量的时间戳
    const timestamp = res.points[0]?.t || Date.now();
    const dateStr = DrawUtils.formatShortDate(timestamp);

    ctx.save();
    ctx.fillStyle = "#999";
    ctx.font = "9px Arial";
    ctx.textAlign = "center";
    ctx.fillText(dateStr, x, y);
    ctx.restore();
  }

  /** 绘制趋势图的数据节点 (小圆点)，选中态切换为橙色，并描白边逻辑*/
  static drawHistoryNodes(
    ctx: any,
    data: any[],
    config: {
      paddingL: number;
      paddingT: number;
      chartH: number;
      yMin: number;
      yMax: number;
      stepX: number;
      selectedIndex: number | null;
      valueField: string; //指定读取哪个字段
    },
  ) {
    const rangeY = config.yMax - config.yMin;

    data.forEach((res, i) => {
      const x = config.paddingL + i * config.stepX;
      // Y 坐标映射公式
      const val = res[config.valueField] || 0;
      const y =
        config.paddingT +
        config.chartH -
        ((val - config.yMin) / rangeY) * config.chartH;

      ctx.save();
      ctx.beginPath();

      // 1. 设置颜色逻辑：选中为绿色，普通为蓝色
      ctx.fillStyle = config.selectedIndex === i ? "#07c160" : "#2f80ed";

      // 2. 绘制圆心（选中时稍微大一点）
      const radius = config.selectedIndex === i ? 5 : 4;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      // 3. 在圆圈外面画一圈白边 (增加层次感)
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.restore();
    });
  }

  /** 绘制趋势图的X轴日期（FeatureNote版本） */
  static drawXAxisHistoryForFeatureNote(
    ctx: any,
    res: any,
    x: number,
    y: number,
  ) {
    // FeatureNote 中使用 timestamp 字段
    const timestamp = res.timestamp || Date.now();
    const dateStr = DrawUtils.formatShortDate(timestamp);

    ctx.save();
    ctx.fillStyle = "#999";
    ctx.font = "9px Arial";
    ctx.textAlign = "center";
    ctx.fillText(dateStr, x, y);
    ctx.restore();
  }

  /** 绘制趋势图的数据节点（FeatureNote版本） */
  static drawHistoryNodesForFeatureNote(
    ctx: any,
    data: any[],
    config: {
      paddingL: number;
      paddingT: number;
      chartH: number;
      yMin: number;
      yMax: number;
      stepX: number;
      selectedIndex: number | null;
      valueField: string;
    },
  ) {
    const rangeY = config.yMax - config.yMin;

    data.forEach((res, i) => {
      const x = config.paddingL + i * config.stepX;
      const val = res[config.valueField] || 0;
      const y =
        config.paddingT +
        config.chartH -
        ((val - config.yMin) / rangeY) * config.chartH;

      ctx.save();
      ctx.beginPath();

      // 微信绿色：#07C160
      ctx.fillStyle = config.selectedIndex === i ? "#07C160" : "#2f80ed";
      const radius = config.selectedIndex === i ? 5 : 4;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });
  }

  /** 格式化日期为 YY-MM-DD */
  static formatDate(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const y = d.getFullYear().toString().slice(-2); // 取年份后两位
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** 格式化日期为 MM-DD */
  static formatShortDate(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    return `${m}-${day}`;
  }

  /**  自动计算历史趋势图的 Y 轴量程 */
  static calculateHistoryRange(values: number[], minThreshold: number = 10) {
    const maxVal = Math.max(...values);
    const minVal = Math.min(...values);
    const range = maxVal - minVal;

    let yMin: number, yMax: number;

    if (range < minThreshold) {
      // 差异极小，使用绝对差值拉伸 (上下各留 2 个单位)
      yMin = minVal - 2;
      yMax = maxVal + 2;
    } else {
      // 差异较大，按百分比留白 (上下各留 20%)
      yMin = Math.max(0, minVal - range * 0.2);
      yMax = maxVal + range * 0.2;
    }

    return {
      yMin, //绘图的最大y值
      yMax,
      rangeY: yMax - yMin,
      realMax: maxVal, //真实的最大y值
      realMin: minVal,
    };
  }

  /** 统一生成历史趋势图的布局参数 */
  static getHistoryLayout(
    width: number,
    height: number,
    dataLength: number,
    yMax: number,
  ) {
    const paddingL = 35; // 左侧留出画 Y 轴刻度
    const paddingB = 20; // 底部留出画 X 轴日期
    const paddingT = 10; // 顶部间距
    const paddingR = 15; // 右侧间距

    const config: DrawConfig = {
      width,
      height,
      paddingL,
      paddingB,
      paddingT,
      maxY: yMax,
      offsetX: 0,
      scaleX: 1.0,
    };

    const chartW = width - paddingL - paddingR;
    const chartH = height - paddingB - paddingT;
    const stepX = dataLength > 1 ? chartW / (dataLength - 1) : 0;

    return { config, chartW, chartH, stepX };
  }

  /**
   * 计算触摸点对应的数据索引
   * @param screenX 屏幕X坐标
   * @param data 数据点数组
   * @param config 绘制配置
   * @returns 包含数据索引、触摸位置和相对时间的对象，如果没有匹配则返回null
   */
  static calculateSelectedIndex(
    screenX: number,
    data: RawPoint[],
    config: DrawConfig,
  ): { index: number; touchX: number; relativeTime?: number } | null {
    if (!data || data.length < 2) return null;

    // 计算X轴映射方式
    let xScale: number;
    let startTime: number;

    if (config.maxDuration && config.startTime) {
      // 基于时间的映射
      xScale = (config.width * config.scaleX) / config.maxDuration;
      startTime = config.startTime;
    } else {
      // 基于数据点索引的映射
      xScale = this.getStepX(config.width, data.length) * config.scaleX;
      startTime = config.startTime || data[0]?.t || 0;
    }

    // 将屏幕坐标转换为数据坐标（考虑偏移）
    const dataX = screenX - config.offsetX;

    // 找到最近的数据点
    let closestIndex = -1;
    let minDistance = Infinity;

    for (let i = 0; i < data.length; i++) {
      let pointX: number;
      if (config.maxDuration && config.startTime) {
        const relativeTime = data[i].t - startTime;
        pointX = relativeTime * xScale;
      } else {
        pointX = i * xScale;
      }

      const distance = Math.abs(pointX - dataX);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    // 如果距离太远，返回null
    if (minDistance > 30) return null;

    // 计算相对时间（用于双曲线模式下的索引转换）
    let relativeTime: number | undefined;
    if (config.maxDuration && config.startTime && closestIndex >= 0) {
      relativeTime = data[closestIndex].t - startTime;
    }

    return closestIndex >= 0
      ? { index: closestIndex, touchX: screenX, relativeTime }
      : null;
  }

  /**
   * 绘制交互层（气泡提示）
   * @param ctx Canvas上下文
   * @param selectedIndex 选中的数据索引
   * @param data1 第一轮数据（可选）
   * @param data2 第二轮数据（可选）
   * @param config 绘制配置
   * @param currentLoop 当前轮次（1或2）
   * @param mode 模式：'force'表示力值，'angle'表示角度
   * @param yMin Y轴最小值（可选，默认为0）
   * @param yMax Y轴最大值（可选，默认使用config.maxY）
   * @param touchX 触摸的屏幕X坐标（可选，用于绘制垂直线）
   * @param startTime1 第一轮测量的开始时间（可选）
   * @param relativeTime 相对时间（可选，用于双曲线模式下正确查找数据点）
   * @param currentLabel 当前测量标签（可选，用于单次测量时显示侧别）
   */
  static drawInteractionLayer(
    ctx: any,
    selectedIndex: number | null,
    data1: RawPoint[] | null,
    data2: RawPoint[] | null,
    config: DrawConfig,
    currentLoop: number,
    mode: "force" | "angle" = "force",
    yMin: number = 0,
    yMax?: number,
    touchX?: number,
    startTime1?: number,
    relativeTime?: number,
    currentLabel?: string,
  ) {
    if (selectedIndex === null) return;

    // 确定使用哪条曲线的数据
    let point1: RawPoint | null = null;
    let point2: RawPoint | null = null;

    // 双曲线模式下，使用相对时间来查找两条曲线对应的数据点
    if (config.maxDuration && config.startTime && relativeTime !== undefined) {
      // 基于相对时间查找两条曲线上最接近的点
      const targetTime = config.startTime + relativeTime;

      if (data1 && startTime1) {
        // 在data1中查找最接近targetTime的点
        const targetTime1 = startTime1 + relativeTime;

        // 检查目标时间是否在data1的时间范围内
        const data1StartTime = data1[0].t;
        const data1EndTime = data1[data1.length - 1].t;

        if (targetTime1 >= data1StartTime && targetTime1 <= data1EndTime) {
          // 目标时间在范围内，查找最接近的点
          let closestIdx1 = -1;
          let minDist1 = Infinity;
          for (let i = 0; i < data1.length; i++) {
            const dist = Math.abs(data1[i].t - targetTime1);
            if (dist < minDist1) {
              minDist1 = dist;
              closestIdx1 = i;
            }
          }
          if (closestIdx1 >= 0) {
            point1 = data1[closestIdx1];
          }
        }
        // 如果目标时间不在范围内，point1 保持为 null
      }

      if (data2) {
        // 在data2中查找最接近targetTime的点

        // 检查目标时间是否在data2的时间范围内
        const data2StartTime = data2[0].t;
        const data2EndTime = data2[data2.length - 1].t;

        if (targetTime >= data2StartTime && targetTime <= data2EndTime) {
          // 目标时间在范围内，查找最接近的点
          let closestIdx2 = -1;
          let minDist2 = Infinity;
          for (let i = 0; i < data2.length; i++) {
            const dist = Math.abs(data2[i].t - targetTime);
            if (dist < minDist2) {
              minDist2 = dist;
              closestIdx2 = i;
            }
          }
          if (closestIdx2 >= 0) {
            point2 = data2[closestIdx2];
          }
        }
        // 如果目标时间不在范围内，point2 保持为 null
      }
    } else {
      // 单曲线模式或基于索引的模式，使用原有逻辑
      if (data1 && selectedIndex < data1.length) {
        point1 = data1[selectedIndex];
      }
      if (data2 && selectedIndex < data2.length) {
        point2 = data2[selectedIndex];
      }
    }

    // 如果没有数据点，直接返回
    if (!point1 && !point2) return;

    // 计算选中点的屏幕坐标
    // 双曲线模式下，使用当前轮数据(data2)计算坐标，因为 config.startTime 是当前轮的开始时间
    // 单曲线模式下，优先使用 data2，其次使用 data1
    let activeData: RawPoint[] | null = null;

    if (currentLoop === 2 && data2 && selectedIndex < data2.length) {
      // 双曲线模式：使用当前轮数据
      activeData = data2;
    } else if (data2 && selectedIndex < data2.length) {
      activeData = data2;
    } else if (data1 && selectedIndex < data1.length) {
      activeData = data1;
    }

    if (!activeData) return;

    const point = activeData[selectedIndex];

    // 计算X坐标
    let xScale: number;
    let startTime: number;

    if (config.maxDuration && config.startTime) {
      xScale = (config.width * config.scaleX) / config.maxDuration;
      startTime = config.startTime;
    } else {
      xScale = this.getStepX(config.width, activeData.length) * config.scaleX;
      startTime = config.startTime || activeData[0]?.t || 0;
    }

    let pointX: number;
    if (config.maxDuration && config.startTime) {
      const relativeT = point.t - startTime;
      pointX = relativeT * xScale;
    } else {
      pointX = selectedIndex * xScale;
    }

    // 应用偏移
    pointX += config.offsetX;

    // 计算Y坐标（使用当前点的值）
    const drawHeight = config.height - config.paddingB - config.paddingT;
    const value = mode === "force" ? point.f : point.a;

    // 使用传入的Y轴范围
    const actualYMax = yMax ?? config.maxY;
    const rangeY = actualYMax - yMin;

    const pointY =
      config.paddingT + drawHeight - ((value - yMin) / rangeY) * drawHeight;

    // 使用触摸位置绘制垂直线，如果没有提供则使用数据点位置
    const verticalLineX = touchX !== undefined ? touchX : pointX;

    // 绘制气泡
    this.drawTooltip(
      ctx,
      verticalLineX,
      pointY,
      point1,
      point2,
      currentLoop,
      mode,
      config,
      startTime1,
      currentLabel,
    );
  }

  /**
   * 绘制气泡提示框
   * @param ctx Canvas上下文
   * @param x 气泡指向的X坐标（选中位置的X坐标）
   * @param y 气泡指向的Y坐标（未使用，保留参数兼容性）
   * @param point1 第一轮数据点（可选）
   * @param point2 第二轮数据点（可选）
   * @param currentLoop 当前轮次
   * @param mode 模式
   * @param config 绘制配置
   * @param startTime1 第一轮测量的开始时间（可选）
   * @param currentLabel 当前测量标签（可选，用于单次测量时显示侧别）
   */
  private static drawTooltip(
    ctx: any,
    x: number,
    y: number,
    point1: RawPoint | null,
    point2: RawPoint | null,
    currentLoop: number,
    mode: "force" | "angle",
    config: DrawConfig,
    startTime1?: number,
    currentLabel?: string,
  ) {
    // 准备气泡内容
    const lines: string[] = [];
    const unit = mode === "force" ? "kg" : "°";

    // 判断是否为两次测量模式：只有 currentLoop === 2 时才显示"左/右"
    const isTwoLoops = currentLoop === 2;

    // 从标签中提取侧别（格式：侧别_部位_动作-时间）
    let sideLabel = "单次";
    if (currentLabel) {
      const parts = currentLabel.split("_");
      if (parts.length >= 1) {
        sideLabel = parts[0]; // 提取侧别（左/右）
      }
    }

    // 第一行：时间 - 根据实际使用的数据点选择正确的开始时间
    // 优先使用实际存在的数据点来计算时间
    let timePoint: RawPoint | null = null;
    let startTime: number = 0;

    if (isTwoLoops) {
      // 双曲线模式：根据实际存在的数据点来决定使用哪个时间
      if (point1 && point2) {
        // 两条曲线都有数据，使用触摸位置对应的点（优先使用point2，因为它是当前轮）
        timePoint = point2;
        startTime = config.startTime || 0;
      } else if (point1) {
        // 只有左侧曲线有数据（点击的是左侧多出的部分）
        timePoint = point1;
        startTime = startTime1 || 0;
      } else if (point2) {
        // 只有右侧曲线有数据（点击的是右侧多出的部分）
        timePoint = point2;
        startTime = config.startTime || 0;
      }
    } else {
      // 单曲线模式
      timePoint = point2 || point1;
      if (point2) {
        startTime = config.startTime || 0;
      } else if (point1) {
        startTime = startTime1 || 0;
      }
    }

    if (timePoint) {
      const relativeTime = Math.max(
        0,
        (timePoint.t - startTime) / 1000,
      ).toFixed(1);
      lines.push(`时间: ${relativeTime}s`);
    }

    // 第二行和第三行：数值
    if (!isTwoLoops) {
      // 单次测量 - 使用侧别标签
      if (point2) {
        const value = mode === "force" ? point2.f : point2.a;
        lines.push(`${sideLabel}: ${value.toFixed(1)}${unit}`);
      } else if (point1) {
        const value = mode === "force" ? point1.f : point1.a;
        lines.push(`${sideLabel}: ${value.toFixed(1)}${unit}`);
      }
    } else {
      // 两次测量 - 只有当数据点存在时才显示对应的数值
      if (point1) {
        const value1 = mode === "force" ? point1.f : point1.a;
        lines.push(`左: ${value1.toFixed(1)}${unit}`);
      }
      if (point2) {
        const value2 = mode === "force" ? point2.f : point2.a;
        lines.push(`右: ${value2.toFixed(1)}${unit}`);
      }
    }

    if (lines.length === 0) return;

    // 先绘制垂直灰色虚线（选中标记）- 确保在最底层
    ctx.save();
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]); // 虚线样式：5像素实线，5像素空白
    ctx.beginPath();
    ctx.moveTo(x, config.paddingT); // 从顶部padding开始
    ctx.lineTo(x, config.height - config.paddingB); // 到底部padding结束
    ctx.stroke();
    ctx.setLineDash([]); // 重置虚线样式
    ctx.restore();

    // 计算气泡尺寸
    ctx.save();
    ctx.font = "11px Arial";

    const padding = 4;
    const lineHeight = 14;
    const maxWidth = Math.max(
      ...lines.map((line) => {
        const metrics = ctx.measureText(line);
        return metrics.width;
      }),
    );

    const bubbleWidth = maxWidth + padding * 2;
    const bubbleHeight = lines.length * lineHeight + padding * 2;

    // 气泡跟随触摸位置，但不超出屏幕边界
    const margin = 10; // 距离屏幕边缘的最小距离

    // 计算气泡X坐标：优先显示在触摸点右侧，如果超出则显示在左侧
    let bubbleX = x + 15; // 默认在触摸点右侧15像素
    if (bubbleX + bubbleWidth + margin > config.width) {
      // 右侧空间不足，显示在左侧
      bubbleX = x - bubbleWidth - 15;
    }
    // 确保不超出左边界
    bubbleX = Math.max(margin, bubbleX);
    // 确保不超出右边界
    bubbleX = Math.min(config.width - bubbleWidth - margin, bubbleX);

    // 气泡Y坐标：固定在顶部，向下偏移15像素
    const bubbleY = margin + 15;

    // 绘制气泡背景
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    this.fillRoundRect(
      ctx,
      bubbleX,
      bubbleY,
      bubbleWidth,
      bubbleHeight,
      6,
      "rgba(0, 0, 0, 0.75)",
    );

    // 绘制气泡边框
    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bubbleX + 6, bubbleY);
    ctx.arcTo(
      bubbleX + bubbleWidth,
      bubbleY,
      bubbleX + bubbleWidth,
      bubbleY + bubbleHeight,
      6,
    );
    ctx.arcTo(
      bubbleX + bubbleWidth,
      bubbleY + bubbleHeight,
      bubbleX,
      bubbleY + bubbleHeight,
      6,
    );
    ctx.arcTo(bubbleX, bubbleY + bubbleHeight, bubbleX, bubbleY, 6);
    ctx.arcTo(bubbleX, bubbleY, bubbleX + bubbleWidth, bubbleY, 6);
    ctx.stroke();

    // 绘制文本
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      const textX = bubbleX + padding;
      const textY = bubbleY + padding + i * lineHeight;
      ctx.fillText(line, textX, textY);
    });

    ctx.restore();
  }
}
