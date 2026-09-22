// miniprogram/utils/painters/HistoryPainter.ts
import { BasePainter } from "./BasePainter";
import { FeatureNoteManager, FeatureNote } from "../storage/index";
import { DrawUtils } from "../shared/DrawUtils";
import { DrawConfig } from "../shared/types";

/**绘制力值的最近测量趋势曲线 */
export class HistoryPainter extends BasePainter {
  private historyData: FeatureNote[] = [];
  private isLoading: boolean = false;
  private hasLoaded: boolean = false; // 标记是否已加载过数据
  private selectedIndex: number | null = null; // 当前选中的数据点索引
  private layoutCache: any = null; // 缓存布局信息用于点击检测
  private currentFilter: { bodyPart?: string; action?: string } = {}; // 当前筛选条件

  /** 设置筛选条件并刷新 */
  async setFilter(bodyPart?: string, action?: string) {
    this.currentFilter = { bodyPart, action };
    this.historyData = [];
    this.hasLoaded = false;
    this.selectedIndex = null;
    await this.drawFrame();
  }

  /** 实现子类的绘图逻辑 */
  async drawFrame() {
    if (!this.ctx) return;

    // 如果正在加载，直接返回
    if (this.isLoading) return;

    // 从云端数据库加载数据（只加载一次）
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

    // 2. 自动计算量程
    const values = data.map((d) => d.peakValue);
    const rangeInfo = DrawUtils.calculateHistoryRange(values);
    const { yMin, yMax, rangeY, realMax, realMin } = rangeInfo;

    // 3. 布局定义
    const layout = DrawUtils.getHistoryLayout(
      this.width,
      this.height,
      data.length,
      rangeInfo.yMax,
    );
    const { config, chartW, chartH, stepX } = layout;

    // 缓存布局信息用于点击检测
    this.layoutCache = { config, chartH, yMin, yMax, stepX };

    //  4.画背景横线+x轴日期
    DrawUtils.drawGridsHistory(this.ctx, realMax, realMin, yMax, yMin, config);
    data.forEach((res, i) => {
      const x = config.paddingL + i * stepX;
      DrawUtils.drawXAxisHistoryForFeatureNote(
        this.ctx,
        res,
        x,
        this.height - 10,
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
        config.paddingT + chartH - ((res.peakValue - yMin) / rangeY) * chartH;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    });
    this.ctx.stroke();

    // 6. 绘制每个数据点
    DrawUtils.drawHistoryNodesForFeatureNote(this.ctx, data, {
      paddingL: config.paddingL,
      paddingT: config.paddingT,
      chartH,
      yMin,
      yMax,
      stepX,
      selectedIndex: this.selectedIndex,
      valueField: "peakValue",
    });

    // 7. 非全屏模式下不显示气泡，气泡仅在 FullscreenHistoryPainter 中显示
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
    let clickedIndex: number | null = null;
    const clickRadius = 15; // 点击检测半径

    for (let i = 0; i < data.length; i++) {
      const pointX = config.paddingL + i * stepX;
      const pointY =
        config.paddingT +
        chartH -
        ((data[i].peakValue - yMin) / (yMax - yMin)) * chartH;

      const distance = Math.sqrt(
        Math.pow(x - pointX, 2) + Math.pow(y - pointY, 2),
      );

      if (distance <= clickRadius) {
        clickedIndex = i;
        break;
      }
    }

    // 更新选中状态
    if (clickedIndex !== null) {
      this.selectedIndex = clickedIndex;
    } else {
      this.selectedIndex = null;
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
      `力峰值: ${data.peakValue.toFixed(1)} kg`,
      `RFD: ${data.rfdValue.toFixed(1)} kg/s`,
      `保持时间: ${data.durationValue.toFixed(1)} s`,
      `对比差异: ${data.percentageDiff.toFixed(1)} %`,
    ];

    // 气泡尺寸
    const padding = 6;
    const lineHeight = 14;
    const bubbleWidth = 110;
    const bubbleHeight = lines.length * lineHeight + padding * 2;

    // 气泡位置固定在右上角
    const bubbleX = this.width - bubbleWidth - 2;
    const bubbleY = 0;

    // 绘制气泡背景
    this.ctx.save();
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    this.ctx.beginPath();

    // 绘制圆角矩形
    const radius = 6;
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
    this.ctx.font = "10px sans-serif";
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
          "MMT趋势数据加载成功(筛选):",
          this.historyData.length,
          "条",
          this.currentFilter,
        );
      } else {
        // 无筛选条件时加载全部
        this.historyData = await FeatureNoteManager.getFeatureNoteList(5);
        console.log("MMT趋势数据加载成功:", this.historyData.length, "条");
      }
    } catch (error) {
      console.error("加载MMT趋势数据失败:", error);
      this.historyData = [];
    } finally {
      this.isLoading = false;
    }
  }

  /** 绘制空状态提示 */
  private drawEmptyState() {
    if (!this.ctx) return;

    this.ctx.fillStyle = "#999999";
    this.ctx.font = "14px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("暂无历史数据", this.width / 2, this.height / 2);
  }

  /** 刷新数据 */
  async refresh() {
    this.historyData = [];
    this.hasLoaded = false;
    this.selectedIndex = null;
    await this.drawFrame();
  }
}
