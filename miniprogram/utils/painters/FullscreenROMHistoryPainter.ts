// miniprogram/utils/painters/FullscreenROMHistoryPainter.ts

import { BasePainter } from "./BasePainter";
import { FeatureNoteManager, FeatureNote } from "../storage/index";
import { DrawUtils } from "../shared/DrawUtils";

/**全屏模式的ROM趋势曲线绘制器 */
export class FullscreenROMHistoryPainter extends BasePainter {
  private historyData: FeatureNote[] = [];
  private isLoading: boolean = false;
  private hasLoaded: boolean = false;
  private selectedIndex: number | null = null;
  private touchX: number | null = null; // 保存触摸位置
  private layoutCache: any = null;
  private currentFilter: { bodyPart?: string; action?: string } = {};
  private currentLabel: string = ""; // 当前标签：侧别—部位—动作

  constructor(canvasId: string, pageContext: any) {
    super(canvasId, pageContext);
  }

  /** 设置筛选条件并刷新 */
  async setFilter(bodyPart?: string, action?: string, side?: string) {
    this.currentFilter = { bodyPart, action };
    // 构建标签：侧别—部位—动作
    if (side && bodyPart && action) {
      this.currentLabel = `${side}—${bodyPart}—${action}`;
    } else {
      this.currentLabel = "";
    }
    this.historyData = [];
    this.hasLoaded = false;
    this.selectedIndex = null;
    this.touchX = null;
    await this.drawFrame();
  }

  /** 获取当前标签 */
  getCurrentLabel(): string {
    return this.currentLabel;
  }

  async drawFrame() {
    if (!this.ctx) return;

    // 如果正在加载，直接返回
    if (this.isLoading) return;

    // 从云端数据库加载数据
    if (!this.hasLoaded) {
      await this.loadHistoryData();
      this.hasLoaded = true;
    }

    // 1. 获取最近 5 次数据并反转 (老数据在前，新数据在后)
    const data = [...this.historyData].reverse();
    this.ctx.clearRect(0, 0, this.width, this.height);

    // 如果没有数据，显示提示
    if (data.length === 0) {
      this.drawEmptyState();
      return;
    }

    // 2. 算量程
    const values = data.map((d) => d.romPeak);
    const rangeInfo = DrawUtils.calculateHistoryRange(values, 20);
    const { yMin, yMax, rangeY, realMax, realMin } = rangeInfo;

    // 3. 布局定义 - 全屏模式下使用更大的padding
    const paddingL = 50;
    const paddingT = 40;
    const paddingB = 50;
    const chartW = this.width - paddingL - 20;
    const chartH = this.height - paddingT - paddingB;
    const stepX = chartW / Math.max(1, data.length - 1);

    const config = {
      width: this.width,
      height: this.height,
      paddingL,
      paddingT,
      paddingB,
      maxY: yMax,
    };

    // 缓存布局信息用于点击检测
    this.layoutCache = { config, chartH, yMin, yMax, stepX };

    // 绘制标题
    this.ctx.save();
    this.ctx.fillStyle = "#333";
    this.ctx.font = "bold 18px Arial";
    this.ctx.textAlign = "center";
    this.ctx.fillText("ROM 趋势", this.width / 2, 25);
    this.ctx.restore();

    // 4. 绘制背景参考线 (单位 °)+x轴日期
    DrawUtils.drawGridsHistory(
      this.ctx,
      realMax,
      realMin,
      yMax,
      yMin,
      config,
      "°",
    );
    data.forEach((res, i) => {
      const x = config.paddingL + i * stepX;
      DrawUtils.drawXAxisHistoryForFeatureNote(
        this.ctx,
        res,
        x,
        this.height - 20,
      );
    });

    // 5. 绘制趋势折线
    this.ctx.beginPath();
    this.ctx.strokeStyle = "#2f80ed";
    this.ctx.lineWidth = 3;
    this.ctx.lineJoin = "round";

    data.forEach((res, i) => {
      const x = config.paddingL + i * stepX;
      const y =
        config.paddingT +
        chartH -
        ((res.romPeak - yMin) / (yMax - yMin)) * chartH;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();

    // 6. 绘制数据节点
    DrawUtils.drawHistoryNodesForFeatureNote(this.ctx, data, {
      paddingL: config.paddingL,
      paddingT: config.paddingT,
      chartH,
      yMin,
      yMax,
      stepX,
      selectedIndex: this.selectedIndex,
      valueField: "romPeak",
    });

    // 7. 如果有选中的点，绘制气泡
    if (this.selectedIndex !== null && data[this.selectedIndex]) {
      this.drawBubble(data[this.selectedIndex], this.selectedIndex, {
        config,
        chartH,
        yMin,
        yMax,
        stepX,
      });
    }
  }

  /** 处理触摸开始事件 */
  onTouchStart(e: any) {
    this.onTouch(e);
  }

  /** 处理触摸移动事件 */
  onTouchMove(e: any) {
    this.onTouch(e);
  }

  /** 处理触摸结束事件 */
  onTouchEnd() {
    // 触摸结束时不清除选中状态，保持气泡显示
  }

  /** 处理点击事件 */
  onTouch(e: any) {
    if (!this.layoutCache || this.historyData.length === 0) return;

    const touch = e.touches[0];
    const x = touch.x;
    const y = touch.y;

    const { config, chartH, yMin, yMax, stepX } = this.layoutCache;
    const data = [...this.historyData].reverse();

    // 检测点击是否在某个数据点附近
    // 点击区域：整个Y轴高度 + X轴左右各一定宽度
    let clickedIndex: number | null = null;
    const clickWidth = 30; // X轴左右各30像素的检测宽度

    for (let i = 0; i < data.length; i++) {
      const pointX = config.paddingL + i * stepX;

      // 检测X坐标是否在点的左右范围内
      if (Math.abs(x - pointX) <= clickWidth) {
        // 检测Y坐标是否在图表区域内
        if (y >= config.paddingT && y <= config.height - config.paddingB) {
          clickedIndex = i;
          break;
        }
      }
    }

    // 更新选中状态
    if (clickedIndex !== null) {
      this.selectedIndex = clickedIndex;
      this.touchX = x; // 保存触摸位置
    } else {
      this.selectedIndex = null;
      this.touchX = null;
    }
  }

  /** 绘制气泡 */
  private drawBubble(
    data: FeatureNote,
    index: number,
    layout: {
      config: any;
      chartH: number;
      yMin: number;
      yMax: number;
      stepX: number;
    },
  ) {
    // 格式化时间（时:分:秒）
    const date = new Date(data.timestamp);
    const timeStr = `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;

    // 气泡内容
    const lines = [
      `时间: ${timeStr}`,
      `角度峰值: ${data.romPeak.toFixed(1)}°`,
      `对比差异: ${data.percentageDiff.toFixed(1)} %`,
    ];

    // 气泡尺寸 - 全屏模式下更大
    const padding = 10;
    const lineHeight = 18;
    const bubbleWidth = 140;
    const bubbleHeight = lines.length * lineHeight + padding * 2;

    // 计算数据点的X坐标
    const { config, chartH, yMin, yMax, stepX } = layout;
    const pointX = config.paddingL + index * stepX;

    // 垂直虚线固定显示在数据点的X位置
    const verticalLineX = pointX;

    // 先绘制垂直灰色虚线
    this.ctx.save();
    this.ctx.strokeStyle = "#999999";
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([5, 5]); // 虚线样式
    this.ctx.beginPath();
    this.ctx.moveTo(verticalLineX, config.paddingT);
    this.ctx.lineTo(verticalLineX, this.height - config.paddingB);
    this.ctx.stroke();
    this.ctx.setLineDash([]); // 重置虚线样式
    this.ctx.restore();

    // 气泡跟随触摸位置，但不超出屏幕边界
    const margin = 10; // 距离屏幕边缘的最小距离

    // 计算气泡X坐标：优先显示在触摸点右侧，如果超出则显示在左侧
    let bubbleX = verticalLineX + 15; // 默认在触摸点右侧15像素
    if (bubbleX + bubbleWidth + margin > this.width) {
      // 右侧空间不足，显示在左侧
      bubbleX = verticalLineX - bubbleWidth - 15;
    }
    // 确保不超出左边界
    bubbleX = Math.max(margin, bubbleX);
    // 确保不超出右边界
    bubbleX = Math.min(this.width - bubbleWidth - margin, bubbleX);

    // 气泡Y坐标：固定在顶部，向下偏移30像素（margin 10 + 额外偏移 20）
    const bubbleY = margin + 30;

    // 绘制气泡背景
    this.ctx.save();
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    this.ctx.beginPath();

    // 绘制圆角矩形
    const radius = 8;
    this.ctx.moveTo(bubbleX + radius, bubbleY);
    this.ctx.lineTo(bubbleX + bubbleWidth - radius, bubbleY);
    this.ctx.quadraticCurveTo(
      bubbleX + bubbleWidth,
      bubbleY,
      bubbleX + bubbleWidth,
      bubbleY + radius,
    );
    this.ctx.lineTo(bubbleX + bubbleWidth, bubbleY + bubbleHeight - radius);
    this.ctx.quadraticCurveTo(
      bubbleX + bubbleWidth,
      bubbleY + bubbleHeight,
      bubbleX + bubbleWidth - radius,
      bubbleY + bubbleHeight,
    );
    this.ctx.lineTo(bubbleX + radius, bubbleY + bubbleHeight);
    this.ctx.quadraticCurveTo(
      bubbleX,
      bubbleY + bubbleHeight,
      bubbleX,
      bubbleY + bubbleHeight - radius,
    );
    this.ctx.lineTo(bubbleX, bubbleY + radius);
    this.ctx.quadraticCurveTo(bubbleX, bubbleY, bubbleX + radius, bubbleY);
    this.ctx.closePath();
    this.ctx.fill();

    // 绘制文字
    this.ctx.fillStyle = "#ffffff";
    this.ctx.font = "13px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      this.ctx.fillText(
        line,
        bubbleX + padding,
        bubbleY + padding + i * lineHeight,
      );
    });

    this.ctx.restore();
  }

  /** 从云端加载历史数据 */
  private async loadHistoryData() {
    this.isLoading = true;
    try {
      // 根据筛选条件查询数据
      if (this.currentFilter.bodyPart || this.currentFilter.action) {
        this.historyData = await FeatureNoteManager.queryFeatureNotes({
          bodyPart: this.currentFilter.bodyPart,
          action: this.currentFilter.action,
          limit: 5,
        });
        console.log(
          "全屏ROM趋势数据加载成功(筛选):",
          this.historyData.length,
          "条",
          this.currentFilter,
        );
      } else {
        this.historyData = await FeatureNoteManager.getFeatureNoteList(5);
        console.log("全屏ROM趋势数据加载成功:", this.historyData.length, "条");
      }
    } catch (error) {
      console.error("加载全屏ROM趋势数据失败:", error);
      this.historyData = [];
    } finally {
      this.isLoading = false;
    }
  }

  /** 绘制空状态提示 */
  private drawEmptyState() {
    if (!this.ctx) return;

    this.ctx.fillStyle = "#999999";
    this.ctx.font = "16px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("暂无历史数据", this.width / 2, this.height / 2);
  }

  /** 刷新数据 */
  async refresh() {
    this.historyData = [];
    this.hasLoaded = false;
    this.selectedIndex = null;
    this.touchX = null;
    await this.drawFrame();
  }
}
