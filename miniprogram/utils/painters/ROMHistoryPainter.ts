// miniprogram/utils/painters/ROMHistoryPainter.ts

import { BasePainter } from "./BasePainter";
import { FeatureNoteManager, FeatureNote } from "../storage/index";
import { DrawUtils } from "../shared/DrawUtils";
import { DrawConfig } from "../shared/types";

/**绘制角度的最近测量趋势曲线 */
export class ROMHistoryPainter extends BasePainter {
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

    // 3. 算布局
    const layout = DrawUtils.getHistoryLayout(
      this.width,
      this.height,
      data.length,
      rangeInfo.yMax,
    );
    const { config, chartW, chartH, stepX } = layout;

    // 缓存布局信息用于点击检测
    this.layoutCache = { config, chartH, yMin, yMax, stepX };

    //4. 绘制背景参考线 (单位 °)+x轴日期
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
        this.height - 5,
      );
    });

    // 5. 绘制趋势折线
    this.ctx.beginPath();
    this.ctx.strokeStyle = "#2f80ed";
    this.ctx.lineWidth = 2.5;

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

    // 7. 非全屏模式下不显示气泡，气泡仅在 FullscreenROMHistoryPainter 中显示
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
        ((data[i].romPeak - yMin) / (yMax - yMin)) * chartH;

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
          "ROM趋势数据加载成功(筛选):",
          this.historyData.length,
          "条",
          this.currentFilter,
        );
      } else {
        // 无筛选条件时加载全部
        this.historyData = await FeatureNoteManager.getFeatureNoteList(5);
        console.log("ROM趋势数据加载成功:", this.historyData.length, "条");
      }
    } catch (error) {
      console.error("加载ROM趋势数据失败:", error);
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

  /** 刷新数据*/
  async refresh() {
    this.historyData = [];
    this.hasLoaded = false;
    await this.drawFrame();
  }
}
